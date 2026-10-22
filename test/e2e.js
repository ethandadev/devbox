const fs = require('fs');
// End-to-end test of devbox 2.1 in an iPhone-sized browser.
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const http = require('http');
const os = require('os');

const path = require('path');
const APP = path.resolve(__dirname, '..');
const T = path.join(__dirname, '.run');
fs.mkdirSync(T, { recursive: true });
const ROOT = `${T}/root`;
const P = `${ROOT}/project`;
const SHOTS = `${T}/shots`;
const PORT = 7311;
const BASE = `http://localhost:${PORT}`;
const LOG = `${T}/fake-vnc.log`;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return false;
}
const sh = (cmd) => execSync(cmd, { cwd: P, encoding: 'utf8' });
const lanIP = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal).address;
const httpGet = (url) => new Promise((ok) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => ok({ status: r.statusCode, body: b })); }).on('error', (e) => ok({ status: 0, body: e.message })));

(async () => {
  // ---------- fixture project ----------
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(`${P}/src`, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(`${P}/hello.py`, 'def greet(name):\n    """Say hi."""\n    return f"hello {name}"\n\nprint(greet("phone"))\n');
  fs.writeFileSync(`${P}/src/app.ts`, 'export const answer: number = 42;\n\nexport function double(n: number) {\n  return n * 2;\n}\n');
  fs.writeFileSync(`${P}/README.md`, '# Project\n\nA test project.\n');
  fs.writeFileSync(`${P}/data.json`, '{"name":"demo","list":[1,2,3],"nested":{"a":true}}');
  fs.writeFileSync(`${P}/package.json`, JSON.stringify({ name: 'demo-app', scripts: { hello: 'echo script-ran-ok', dev: 'python3 -m http.server 8765 --bind 127.0.0.1' } }, null, 2));
  fs.mkdirSync(`${P}/node_modules`);
  fs.writeFileSync(`${P}/.gitignore`, 'node_modules\n');
  // 2x2 PNG
  fs.writeFileSync(`${P}/logo.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8Dwn4GBgYGJAQoAAPU1AwF0xEeUAAAAAElFTkSuQmCC', 'base64'));
  sh('git init -q -b main && git config user.email t@example.com && git config user.name Tester && git add -A && git commit -qm "Initial commit"');
  fs.rmSync(LOG, { force: true });

  // a "dev server" bound to localhost only
  const devServer = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: P, stdio: 'ignore' });

  const fake = spawn('node', [path.join(__dirname, 'fake-mac-vnc.js')], { env: { ...process.env, FAKE_PORT: '5911', FAKE_TYPES: '30,2' }, stdio: 'inherit' });
  await waitFor(() => fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').includes('listening 5911'));
  const env = { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', DEVBOX_ROOT: ROOT, VNC_PORT: '5911', SHELL: '/bin/bash' };
  delete env.DEVBOX_TOKEN;
  const srv = spawn('node', [path.join(APP, 'server/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = '';
  srv.stdout.on('data', (d) => (srvOut += d));
  srv.stderr.on('data', (d) => (srvOut += d));
  check('server starts', await waitFor(() => srvOut.includes('is running')));
  await waitFor(() => srvOut.includes('Screen:'), 4000);

  // ---------- security without sign-in ----------
  const evilHost = await new Promise((ok) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { Host: 'attacker.example.com' } }, (r) => ok(r.statusCode)).on('error', () => ok(0)));
  check('blocks requests addressed to a foreign host name', evilHost === 403);
  const wsEvil = await new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/ws/term', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example.com' } });
    req.on('response', (r) => ok(r.statusCode)); req.on('upgrade', () => ok(101)); req.on('error', () => ok(0)); req.end();
  });
  check('blocks terminal connections from other websites', wsEvil === 403, 'status ' + wsEvil);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const external = [];
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('http://localhost:8765')) external.push(u); });
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const tab = (t) => page.tap(`.tabbar button[data-tab=${t}]`);
  const termText = () => page.$eval('#pane-term .xterm-rows', (e) => e.innerText);

  // ---------- no sign-in ----------
  await page.goto(BASE + '/');
  check('opens straight into the app (no sign-in)', await waitFor(() => page.isVisible('#app')));
  check('five tabs', (await page.$$('.tabbar button')).length === 5);

  // ---------- terminal ----------
  check('terminal connects', await waitFor(() => page.$eval('#conn-dot', (e) => e.dataset.state === 'online'), 10000));
  await page.click('.term-host');
  await page.keyboard.type('echo devbox-ok-$((40+2))');
  await page.keyboard.press('Enter');
  check('terminal runs commands', await waitFor(async () => (await termText()).includes('devbox-ok-42')));
  await page.keyboard.type('export MARK=kept'); await page.keyboard.press('Enter'); await sleep(300);
  await page.reload();
  await waitFor(() => page.$eval('#conn-dot', (e) => e.dataset.state === 'online'), 10000);
  await page.click('.term-host');
  await page.keyboard.type('echo mark=$MARK'); await page.keyboard.press('Enter');
  check('terminal session survives a reload', await waitFor(async () => (await termText()).includes('mark=kept')));

  // ---------- code ----------
  await tab('code');
  check('editor loads', await waitFor(() => page.evaluate(() => !!window.monaco), 15000));
  await waitFor(() => page.$eval('#pane-code', (e) => e.classList.contains('drawer-open')));
  await page.locator('.node .label', { hasText: 'project' }).tap();
  await waitFor(() => page.isVisible('.node .label:text-is("hello.py")'));
  await page.locator('.node:has(.label:text-is("project")) .more').tap();
  await page.locator('.menu button', { hasText: 'Open this folder' }).tap();
  check('"Open this folder" makes it the project', await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem('devbox.code.workspace')) === 'project')));
  await page.locator('.node .label:text-is("hello.py")').tap();
  check('opens a file with syntax highlighting', await waitFor(() => page.evaluate(() => { const m = window.monaco.editor.getModels().find((x) => x.uri.path.endsWith('hello.py')); return m && m.getLanguageId() === 'python'; })));
  await page.click('.editor-host .view-lines');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n# edited from phone');
  check('autosaves to the Mac', await waitFor(() => fs.readFileSync(`${P}/hello.py`, 'utf8').includes('# edited from phone'), 6000));
  await shot('10-editor');

  // quick open
  await page.tap('.code-head .icon-btn.end:not(.run-btn)');
  await waitFor(() => page.isVisible('.sheet .seg'));
  await page.locator('.seg button:text-is("Files")').tap();
  await page.fill('.sheet input[type=search]', 'apts');
  check('quick open finds files by fuzzy name', await waitFor(() => page.evaluate(() => { const n = [...document.querySelectorAll('.result .r-name')].map((e) => e.textContent); return n[0] === 'app.ts' && !n.includes('hello.py'); })));
  await shot('11-quick-open');
  await page.locator('.result', { hasText: 'app.ts' }).first().tap();
  check('quick open opens the file', await waitFor(() => page.isVisible('.tab.active .name:text-is("app.ts")')));

  // text search -> jumps to the line
  await page.tap('.code-head .icon-btn.end:not(.run-btn)');
  await page.locator('.seg button', { hasText: 'Text in files' }).tap();
  await page.fill('.sheet input[type=search]', 'return n');
  check('text search finds matches', await waitFor(() => page.isVisible('.result.hit mark')));
  await shot('12-search');
  await page.locator('.result.hit').first().tap();
  check('search result jumps to the line', await waitFor(() => page.evaluate(() => { const ed = window.monaco.editor.getEditors()[0]; return ed.getModel().uri.path.endsWith('app.ts') && ed.getPosition().lineNumber === 4; })));

  // format document (JSON)
  await page.tap('.code-head .icon-btn:first-child');
  await page.locator('.node .label:text-is("data.json")').tap();
  await waitFor(() => page.isVisible('.tab.active .name:text-is("data.json")'));
  await page.tap('[data-for=code] .icon-btn');
  await page.locator('.menu button', { hasText: 'Format document' }).tap();
  check('format document works and saves', await waitFor(() => fs.readFileSync(`${P}/data.json`, 'utf8').includes('\n'), 6000));

  // image
  await page.tap('.code-head .icon-btn:first-child');
  await page.locator('.node .label:text-is("logo.png")').tap();
  check('images open as a preview', await waitFor(() => page.evaluate(() => { const i = document.querySelector('.image-view img'); return i && i.complete && i.naturalWidth === 2; })));

  // upload
  fs.writeFileSync(`${T}/from-phone.txt`, 'uploaded!');
  await page.tap('.code-head .icon-btn:first-child');
  await page.setInputFiles('#pane-code input[type=file]', `${T}/from-phone.txt`);
  check('uploads files from the phone', await waitFor(() => fs.existsSync(`${P}/from-phone.txt`) && fs.readFileSync(`${P}/from-phone.txt`, 'utf8') === 'uploaded!'));
  await page.tap('.drawer-scrim').catch(() => {});

  // ---------- developer tools ----------
  // folders open instantly (read ahead), no waiting on the network
  const openDrawer = async () => { if (!(await page.$eval('#pane-code', (e) => e.classList.contains('drawer-open')))) await page.tap('.code-head .icon-btn:first-child'); };
  await openDrawer();
  await waitFor(() => page.isVisible('.node .label:text-is("src")'));
  await sleep(400);
  const t0 = Date.now();
  await page.locator('.node .label:text-is("src")').tap();
  await page.waitForSelector('.node .label:text-is("app.ts")', { timeout: 3000 });
  check('subfolders open instantly from read-ahead', Date.now() - t0 < 350, `${Date.now() - t0} ms`);
  await page.locator('.node .label:text-is("README.md")').tap();
  await waitFor(() => page.isVisible('.tab.active .name:text-is("README.md")'));
  await page.tap('[data-for=code] .icon-btn');
  await page.locator('.menu button', { hasText: 'Preview Markdown' }).tap();
  check('Markdown preview renders', await waitFor(() => page.$eval('.md-body h1', (e) => e.textContent === 'Project')));
  await page.tap('.md-overlay .icon-btn[aria-label="Close preview"]');
  const filesRoute = await page.evaluate(async () => (await fetch('/files/project/README.md')).status);
  check('files are served for HTML preview', filesRoute === 200, String(filesRoute));
  // problems from the JSON language service
  fs.writeFileSync(`${P}/bad.json`, '{ "name": "demo", "list": [1, 2, }\n');
  await openDrawer();
  await page.tap('.drawer .icon-btn[aria-label=Refresh]');
  await page.locator('.node .label:text-is("bad.json")').tap();
  check('errors show in the status bar', await waitFor(() => page.$eval('.sb-problems', (e) => !/⊗ 0/.test(e.textContent)), 10000), await page.$eval('.sb-problems', (e) => e.textContent).catch(() => ''));
  await page.tap('.sb-problems');
  check('problems list shows the error', await waitFor(() => page.isVisible('.result.problem')));
  await page.locator('.result.problem').first().tap();
  // run the current file in its own terminal
  await openDrawer();
  await page.locator('.node .label:text-is("hello.py")').tap();
  await waitFor(() => page.isVisible('.tab.active .name:text-is("hello.py")'));
  await page.tap('.code-head .run-btn');
  check('▶ runs the file in a terminal', await waitFor(async () => (await page.$eval('#pane-term .xterm-rows', (e) => e.innerText)).includes('hello phone'), 10000));
  check('run terminal is named after the file', await page.$eval('#title-main', (e) => e.textContent.includes('hello.py')));
  await tab('code');
  await page.tap('.code-head .icon-btn.end:not(.run-btn)');
  await waitFor(() => page.isVisible('.sheet .seg'));
  await page.locator('.seg button:text-is("Files")').tap();
  check('quick open lists recently opened files', await waitFor(() => page.$eval('.results-info', (e) => e.textContent === 'Recently opened')));
  await page.tap('.sheet-scrim', { position: { x: 10, y: 10 } });

  // ---------- git ----------
  await tab('git');
  check('git tab shows the repo and branch', await waitFor(() => page.isVisible('.pane-bar .chip-btn:has-text("main")')));
  check('git lists changed files', await waitFor(() => page.isVisible('.file-row .fr-name b:text-is("hello.py")')));
  check('new files show as untracked', await page.isVisible('.file-row:has(b:text-is("from-phone.txt")) .st-U'));
  await shot('13-git');
  await page.locator('.file-row', { hasText: 'hello.py' }).first().tap();
  check('tapping a file shows a diff', await waitFor(() => page.isVisible('.diff-host .monaco-diff-editor'), 10000));
  await sleep(500);
  await shot('14-diff');
  await page.locator('.diff-actions .btn', { hasText: 'Stage' }).tap();
  check('stage from the diff view', await waitFor(() => sh('git diff --cached --name-only').includes('hello.py')));
  await waitFor(() => page.isVisible('.section-head:has-text("Staged")'));
  await page.fill('#commit-msg', 'Edit greeting from phone');
  await page.locator('.commit-box .btn-primary').tap();
  check('commit from the phone', await waitFor(() => sh('git log -1 --format=%s').trim() === 'Edit greeting from phone'));
  check('history shows the new commit', await waitFor(() => page.isVisible('.commit-row .c-subject:text-is("Edit greeting from phone")')));
  // new branch
  await page.locator('.pane-bar .chip-btn', { hasText: 'main' }).tap();
  await page.locator('.menu button', { hasText: 'New branch' }).tap();
  await page.fill('.sheet input', 'feature/phone');
  await page.locator('.sheet .btn-primary').tap();
  check('create and switch branch', await waitFor(() => sh('git branch --show-current').trim() === 'feature/phone'));
  // discard untracked
  await waitFor(() => page.isVisible('.file-row:has(b:text-is("from-phone.txt"))'));
  await page.locator('.file-row:has(b:text-is("from-phone.txt")) .icon-btn[aria-label^="Discard"]').tap();
  await page.locator('.sheet .btn-danger').tap();
  check('discard removes a new file', await waitFor(() => !fs.existsSync(`${P}/from-phone.txt`)));
  await page.locator('.commit-row').first().tap();
  check('commit details list changed files', await waitFor(() => page.isVisible('.sheet .file-row b:text-is("hello.py")')));
  await shot('15-commit');
  await page.locator('.sheet .btn', { hasText: 'Close' }).tap();

  // ---------- run ----------
  await tab('run');
  check('run tab lists package.json scripts', await waitFor(() => page.isVisible('.script-row b:text-is("hello")')));
  check('dev server on localhost is detected', await waitFor(() => page.isVisible('.server-row .port:text-is("8765")'), 8000));
  await shot('16-run');
  await page.locator('.server-row:has(.port:text-is("8765")) .btn').tap();
  check('preview opens the dev server', await waitFor(() => page.evaluate(() => { const f = document.querySelector('.preview-frame'); return f && f.src.includes(':8765'); })));
  const fwd = await waitFor(async () => { const r = await httpGet(`http://${lanIP}:8765/`); return r.status === 200 && r.body.includes('Directory listing') ? r : null; }, 6000);
  check('localhost-only server is shared to the network address', !!fwd);
  await sleep(800);
  await shot('17-preview');
  await page.tap('.overlay.preview .icon-btn[aria-label="Close preview"]');
  await page.locator('.script-row', { hasText: 'hello' }).first().tap();
  check('script runs in a new terminal', await waitFor(async () => (await termText()).includes('script-ran-ok'), 8000));
  await shot('18-script-terminal');

  // ---------- screen ----------
  await tab('screen');
  await page.fill('#scr-user', 'ethan');
  await page.fill('#scr-pass', 'correct horse');
  await page.tap('.screen-setup .btn-primary');
  check('screen connects with Mac login', await waitFor(() => page.isVisible('.screen-view canvas'), 10000));
  await page.tap('[data-for=screen] .icon-btn[aria-label=Keyboard]');
  await page.keyboard.type('ok');
  check('typing reaches the Mac', await waitFor(() => /key down 0x6f[\s\S]*key down 0x6b/.test(fs.readFileSync(LOG, 'utf8'))));

  // ---------- general ----------
  check('no requests leave your Mac', external.length === 0, external.slice(0, 3).join(', '));
  const realErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

  await browser.close();
  srv.kill(); fake.kill(); devServer.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
