const fs = require('fs');
// End-to-end test of devbox in an iPhone-sized browser.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const T = path.join(__dirname, '.run');
fs.mkdirSync(T, { recursive: true });
const ROOT = `${T}/root`;
const SHOTS = `${T}/shots`;
const PORT = 7311;
const BASE = `http://localhost:${PORT}`;
const LOG = `${T}/fake-vnc.log`;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return false;
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(`${ROOT}/project/src`, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(`${ROOT}/project/hello.py`, 'def greet(name):\n    """Say hi."""\n    return f"hello {name}"\n\nprint(greet("phone"))\n');
  fs.writeFileSync(`${ROOT}/project/src/app.ts`, 'export const answer: number = 42;\n');
  fs.writeFileSync(`${ROOT}/project/README.md`, '# Project\n');
  fs.rmSync(LOG, { force: true });
  fs.rmSync(`${T}/fake2.log`, { force: true });

  const fake = spawn('node', [path.join(__dirname, 'fake-mac-vnc.js')], { env: { ...process.env, FAKE_PORT: '5911', FAKE_TYPES: '30,2' }, stdio: 'inherit' });
  await waitFor(() => fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').includes('listening 5911'), 8000);
  const env = { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', DEVBOX_ROOT: ROOT, VNC_PORT: '5911', DEVBOX_TOKEN: 'test-token-1234567890', SHELL: '/bin/bash' };
  const srv = spawn('node', [path.join(APP, 'server/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = '';
  srv.stdout.on('data', (d) => (srvOut += d));
  srv.stderr.on('data', (d) => (srvOut += d));
  await waitFor(() => srvOut.includes('is running'), 8000);
  check('server starts and prints banner', srvOut.includes('is running'));
  check('banner reports screen sharing on', srvOut.includes('Screen Sharing is on'));

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

  // ---------- login ----------
  await page.goto(BASE + '/');
  check('unauthenticated visit shows sign-in', await waitFor(() => page.isVisible('#login')));
  await page.screenshot({ path: `${SHOTS}/01-login.png` });
  await page.fill('#login-code', 'wrong');
  await page.click('#login button[type=submit]');
  check('wrong code shows an error', await waitFor(() => page.isVisible('#login-error')));
  await page.fill('#login-code', 'test-token-1234567890');
  await page.click('#login button[type=submit]');
  check('right code opens the app', await waitFor(() => page.isVisible('#app')));

  // ---------- terminal ----------
  check('terminal connects (green dot)', await waitFor(() => page.$eval('#conn-dot', (e) => e.dataset.state === 'online'), 10000));
  await page.click('.term-host');
  await page.keyboard.type('echo devbox-ok-$((40+2))');
  await page.keyboard.press('Enter');
  const termText = () => page.$eval('.xterm-rows', (e) => e.innerText);
  check('terminal runs a real command', await waitFor(async () => (await termText()).includes('devbox-ok-42')));
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await sleep(400);
  await page.locator('.keybar .key', { hasText: '^C' }).first().tap();
  await page.keyboard.type('echo after-ctrl-c');
  await page.keyboard.press('Enter');
  check('^C key interrupts a running command', await waitFor(async () => (await termText()).match(/after-ctrl-c\s*\n/)));
  // ctrl modifier: ctrl then "u" should clear the typed line
  await page.keyboard.type('garbage-text');
  await page.locator('.keybar .key', { hasText: 'ctrl' }).tap();
  await page.keyboard.type('u');
  await page.keyboard.type('echo ctrl-mod-works');
  await page.keyboard.press('Enter');
  check('sticky ctrl key works (ctrl-U cleared the line)', await waitFor(async () => { const t = await termText(); return t.includes('ctrl-mod-works') && !t.includes('garbage-textecho'); }));
  await page.screenshot({ path: `${SHOTS}/02-terminal.png` });

  // persistence across reload (phone locked / page reloaded)
  await page.keyboard.type('export DEVBOX_MARK=still-here');
  await page.keyboard.press('Enter');
  await sleep(300);
  await page.reload();
  check('after reload: reconnects', await waitFor(() => page.$eval('#conn-dot', (e) => e.dataset.state === 'online'), 10000));
  check('after reload: earlier output replayed', await waitFor(async () => (await termText()).includes('devbox-ok-42')));
  await page.click('.term-host');
  await page.keyboard.type('echo mark=$DEVBOX_MARK');
  await page.keyboard.press('Enter');
  check('after reload: same shell session (env var kept)', await waitFor(async () => (await termText()).includes('mark=still-here')));

  // ---------- code ----------
  await page.tap('.tabbar button[data-tab=code]');
  check('editor loads (Monaco)', await waitFor(() => page.evaluate(() => !!window.monaco), 15000));
  check('file drawer opens when nothing is open', await waitFor(() => page.$eval('#pane-code', (e) => e.classList.contains('drawer-open'))));
  await page.locator('.node .label', { hasText: 'project' }).tap();
  check('folder expands', await waitFor(() => page.isVisible('.node .label:text-is("hello.py")')));
  await page.locator('.node .label:text-is("hello.py")').tap();
  check('file opens in a tab', await waitFor(() => page.isVisible('.tab.active .name:text-is("hello.py")')));
  check('python syntax highlighting is on', await waitFor(() => page.evaluate(() => {
    const m = window.monaco.editor.getModels().find((x) => x.uri.path.endsWith('hello.py'));
    return m && m.getLanguageId() === 'python' && document.querySelectorAll('.view-lines .mtk1, .view-lines [class*="mtk"]').length > 3 && new Set([...document.querySelectorAll('.view-lines span span')].map((s) => getComputedStyle(s).color)).size >= 3;
  })));
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/03-editor.png` });

  // edit + autosave
  await page.click('.editor-host .view-lines');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n# edited from phone');
  check('save state shows Edited/Saving', await waitFor(() => page.$eval('.save-state', (e) => ['dirty', 'saving'].includes(e.dataset.state)), 2000, 50));
  check('autosaves to disk', await waitFor(() => fs.readFileSync(`${ROOT}/project/hello.py`, 'utf8').includes('# edited from phone'), 5000));
  check('save state returns to Saved', await waitFor(() => page.$eval('.save-state', (e) => e.dataset.state === 'saved')));

  // external change while clean -> silent reload
  await sleep(1200);
  fs.writeFileSync(`${ROOT}/project/hello.py`, fs.readFileSync(`${ROOT}/project/hello.py`, 'utf8') + '# changed on mac\n');
  check('picks up a change made on the Mac', await waitFor(() => page.evaluate(() => window.monaco.editor.getModels().some((m) => m.getValue().includes('# changed on mac'))), 9000));

  // external change while dirty -> conflict, nothing overwritten
  await page.click('.editor-host .view-lines');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n# phone edit');
  fs.writeFileSync(`${ROOT}/project/hello.py`, 'EXTERNAL REWRITE\n');
  const fileNow = () => fs.readFileSync(`${ROOT}/project/hello.py`, 'utf8');
  check('conflict banner instead of overwriting', await waitFor(() => page.isVisible('.banner:not([hidden])'), 9000));
  check('Mac version was not clobbered', fileNow() === 'EXTERNAL REWRITE\n');
  await page.screenshot({ path: `${SHOTS}/04-conflict.png` });
  await page.locator('.banner .btn', { hasText: 'Keep mine' }).tap();
  check('"Keep mine" writes the phone version', await waitFor(() => fileNow().includes('# phone edit')));

  // new file via drawer
  await page.tap('.code-head .icon-btn');
  await waitFor(() => page.$eval('#pane-code', (e) => e.classList.contains('drawer-open')));
  await page.locator('.node:has(.label:text-is("project")) .more').tap();
  await page.locator('.menu button', { hasText: 'New file here' }).tap();
  await page.fill('.sheet input', 'notes.md');
  await page.locator('.sheet .btn-primary').tap();
  check('creates a new file', await waitFor(() => fs.existsSync(`${ROOT}/project/notes.md`)));
  check('new file opens in a tab', await waitFor(() => page.isVisible('.tab.active .name:text-is("notes.md")')));

  // path safety
  const escape = await page.evaluate(async () => (await fetch('/api/fs/read?path=../../etc/passwd')).status);
  check('refuses paths outside the root', escape === 403, 'status ' + escape);

  // ---------- screen ----------
  await page.tap('.tabbar button[data-tab=screen]');
  check('screen tab shows Screen Sharing is on', await waitFor(() => page.isVisible('.status-line b:text("Screen Sharing is on")')));
  await page.screenshot({ path: `${SHOTS}/05-screen-setup.png` });
  await page.fill('#scr-user', 'ethan');
  await page.fill('#scr-pass', 'nope');
  await page.tap('.screen-setup .btn-primary');
  check('wrong Mac password shows a clear error', await waitFor(() => page.$eval('.screen-setup .error-text', (e) => !e.hidden && /Wrong username or password/.test(e.textContent))), await page.$eval('.screen-setup .error-text', (e) => e.textContent).catch(() => ''));
  await page.fill('#scr-pass', 'correct horse');
  await page.tap('.screen-setup .btn-primary');
  check('connects with Mac username + password', await waitFor(() => page.isVisible('.screen-view canvas'), 10000));
  const painted = await waitFor(() => page.evaluate(() => {
    const c = document.querySelector('.screen-view canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return d[0] > 200 && d[1] > 200;   // the light "window" block in the middle
  }), 8000);
  check('remote screen is drawn on the phone', painted);
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/06-screen-live.png` });

  // tap -> click
  const box = await page.locator('.screen-view canvas').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  check('tap sends a click to the Mac', await waitFor(() => /pointer mask=1/.test(fs.readFileSync(LOG, 'utf8'))));

  // keyboard
  await page.tap('[data-for=screen] .icon-btn[aria-label=Keyboard]');
  await page.keyboard.type('hi');
  check('typing reaches the Mac', await waitFor(() => { const l = fs.readFileSync(LOG, 'utf8'); return /key down 0x68/.test(l) && /key down 0x69/.test(l); }));
  await page.keyboard.press('Backspace');
  check('backspace reaches the Mac', await waitFor(() => /key down 0xff08/.test(fs.readFileSync(LOG, 'utf8'))));
  await page.locator('#pane-screen .keybar .key', { hasText: '⌘C' }).tap();
  check('⌘C sends Command+C', await waitFor(() => { const l = fs.readFileSync(LOG, 'utf8'); return /key down 0xffeb[\s\S]*key down 0x63/.test(l); }));

  // ---------- classic VNC password mode ----------
  const fake2 = spawn('node', [path.join(__dirname, 'fake-mac-vnc.js')], { env: { ...process.env, FAKE_PORT: '5912', FAKE_TYPES: '2', FAKE_LOG: `${T}/fake2.log` }, stdio: 'inherit' });
  await waitFor(() => fs.existsSync(`${T}/fake2.log`) && fs.readFileSync(`${T}/fake2.log`, 'utf8').includes('listening 5912'), 8000);
  const vncTest = await new Promise((resolve) => {
    const vnc = require(path.join(APP, 'server/vnc.js'));
    const net = require('net');
    const s = net.connect(5912, '127.0.0.1');
    s.on('error', () => resolve(false));
    const R = class { constructor(sock) { this.b = Buffer.alloc(0); this.w = null; sock.on('data', (d) => { this.b = Buffer.concat([this.b, d]); this.w && this.w(); }); }
      async read(n) { while (this.b.length < n) await new Promise((r) => (this.w = r)); const o = this.b.subarray(0, n); this.b = this.b.subarray(n); return Buffer.from(o); } };
    s.on('connect', () => vnc._loginToMac(s, new R(s), { username: '', password: 'vncpw123' }).then((t) => resolve(t === 2), () => resolve(false)));
  });
  check('classic VNC-password login also works', vncTest);
  fake2.kill();

  // ---------- general ----------
  check('no requests leave your Mac (no CDNs)', external.length === 0, external.slice(0, 3).join(', '));
  const realErrors = consoleErrors.filter((e) => !/401|Failed to load resource/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  // token link sign-in in a fresh browser
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/?token=test-token-1234567890`);
  check('printed link signs in and hides the token', await waitFor(() => p2.isVisible('#app')) && !p2.url().includes('token'));

  await browser.close();
  srv.kill(); fake.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
