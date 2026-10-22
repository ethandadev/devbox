#!/usr/bin/env node
'use strict';
// `npm run doctor`: checks everything devbox needs and says how to fix what's missing.
const http = require('http');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.DEVBOX_KEEP_AWAKE = '0';
const config = require('../server/config');
const netinfo = require('../server/netinfo');

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s, fix) => console.log(`  \x1b[31m✗\x1b[0m ${s}${fix ? `\n      → ${fix}` : ''}`);
const warn = (s, fix) => console.log(`  \x1b[33m!\x1b[0m ${s}${fix ? `\n      → ${fix}` : ''}`);
let problems = 0;

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1200, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function getJSON(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 2000 }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); })
      .on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

(async () => {
  console.log('\n  devbox doctor\n');

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node.js ${process.versions.node}`);
  else { problems++; bad(`Node.js ${process.versions.node} is too old`, 'brew install node   (needs 18 or newer)'); }

  // Actually open a terminal, like devbox does (this also repairs the helper's permissions).
  try {
    require('../server/terminal');
    const pty = require('node-pty');
    const out = await new Promise((resolve, reject) => {
      const p = pty.spawn('/bin/sh', ['-c', 'echo devbox-pty-ok'], { cols: 80, rows: 24, env: config.env });
      let buf = '';
      p.onData((d) => { buf += d; });
      p.onExit(() => resolve(buf));
      setTimeout(() => reject(new Error('timed out')), 5000);
    });
    if (out.includes('devbox-pty-ok')) ok('Terminals work');
    else { problems++; bad('Terminal started but gave no output', 'rm -rf node_modules && npm install'); }
  } catch (e) {
    problems++;
    bad(`Terminals don't work: ${e.message.split('\n')[0]}`, 'chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper   (or: rm -rf node_modules && npm install)');
  }

  try { require('monaco-editor/package.json'); require('@xterm/xterm/package.json'); ok('Editor and terminal files are installed'); }
  catch { problems++; bad('Some packages are missing', 'npm install'); }

  const ips = netinfo.tailscaleIPs();
  const name = await netinfo.tailscaleName();
  if (ips.length) ok(`Tailscale connected: ${name || ips[0]}`);
  else { problems++; bad('Tailscale isn\'t connected on this Mac', 'Open the Tailscale app and sign in. Your phone must be on the same tailnet.'); }

  if (await portOpen(config.vncPort)) ok('Screen Sharing is on');
  else { problems++; bad('Screen Sharing is off (needed for the Screen tab)', 'System Settings → General → Sharing → turn on Screen Sharing'); }

  if (config.bins.git) {
    ok(`git found (${config.bins.git})`);
    try {
      const n = execFileSync(config.bins.git, ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
      if (n) ok(`git will commit as ${n}`);
    } catch { warn('git has no name/email set, so commits will fail', 'git config --global user.name "Your Name" && git config --global user.email you@example.com'); }
  } else { problems++; bad('git not found (needed for the Git tab)', 'xcode-select --install'); }

  if (config.bins.rg) ok('ripgrep found (fast code search)');
  else warn('ripgrep not installed, so search will be slower', 'brew install ripgrep');

  if (config.bins.lsof) ok('lsof found (dev server list)');
  else warn('lsof not found, so the Run tab can\'t list servers');

  if (process.platform === 'darwin') {
    if (config.bins.pbcopy) ok('Clipboard sharing available');
  } else warn('Not a Mac: clipboard sharing and keep-awake are Mac-only');

  const running = await getJSON(`http://127.0.0.1:${config.port}/api/status`);
  if (running && running.version) ok(`devbox ${running.version} is running on port ${config.port}`);
  else if (await portOpen(config.port)) { problems++; bad(`Port ${config.port} is used by something else`, `Start devbox on another port: PORT=7112 npm start`); }
  else warn('devbox isn\'t running right now', 'npm start   (or npm run service to keep it running)');

  let pm2 = null;
  try { pm2 = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', env: config.env, stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
  if (pm2) {
    const p = pm2.find((x) => x.name === 'devbox');
    if (p) ok(`pm2 keeps devbox running (status: ${p.pm2_env.status})`);
    else warn('pm2 is installed but not running devbox', 'npm run service');
  } else warn('Not set up to start automatically', 'npm run service');

  if (ips.length) {
    const host = name || ips.find((i) => i.includes('.')) || ips[0];
    console.log(`\n  Phone link: http://${host}:${config.port}/`);
  }
  console.log(problems ? `\n  ${problems} thing${problems === 1 ? '' : 's'} to fix above.\n` : '\n  All good.\n');
  process.exit(problems ? 1 : 0);
})();
