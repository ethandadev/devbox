#!/usr/bin/env node
'use strict';
/**
 * devbox — terminal, code editor, git, dev-server preview and screen sharing
 * for your Mac, made for a phone on your tailnet. Everything the page needs is
 * served from this Mac.
 */
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { WebSocketServer } = require('ws');

const config = require('./config');
const auth = require('./auth');
const netinfo = require('./netinfo');
const terminal = require('./terminal');
const vnc = require('./vnc');
const files = require('./files');
const git = require('./git');
const search = require('./search');
const ports = require('./ports');
const project = require('./project');
const system = require('./system');
const lsp = require('./lsp');
const screenlite = require('./screenlite');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');   // for `tailscale serve` in front
app.use(auth.guard);
app.use(compression());

// --- optional sign-in (only when DEVBOX_TOKEN / DEVBOX_AUTH=1 is set) -------
app.get('/', (req, res, next) => {
  if (config.authRequired && req.query.token !== undefined) {
    if (auth.tokenMatches(String(req.query.token))) auth.setAuthCookie(res);
    return res.redirect(302, '/');
  }
  next();
});
app.post('/api/login', express.json(), (req, res) => {
  if (!auth.tokenMatches(String((req.body && req.body.token) || '').trim())) {
    return res.status(401).json({ error: 'That access code is not right.' });
  }
  if (config.authRequired) auth.setAuthCookie(res);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

// --- API -------------------------------------------------------------------
app.get('/api/status', auth.requireAuth, async (req, res) => {
  res.json({
    version: config.version,
    host: os.hostname().replace(/\.local$/, ''),
    user: os.userInfo().username,
    platform: process.platform,
    shell: config.shell,
    root: config.root,
    rootName: config.root === config.home ? '~' : path.basename(config.root),
    home: config.home,
    auth: config.authRequired,
    appDir: path.resolve(__dirname, '..'),
    managedByPm2: !!process.env.pm_id,
    tailscale: { ips: netinfo.tailscaleIPs(), name: await netinfo.tailscaleName() },
    vnc: await vnc.probe(),
    features: {
      git: !!config.bins.git,
      search: config.bins.rg ? 'ripgrep' : 'grep',
      clipboard: !!(config.bins.pbcopy && config.bins.pbpaste),
      ports: !!config.bins.lsof,
      keepAwake: system.isKeepingAwake(),
    },
  });
});

app.get('/api/terminals', auth.requireAuth, (req, res) => res.json(terminal.list()));
app.delete('/api/terminals/:id', auth.requireAuth, (req, res) => res.json({ ok: terminal.kill(req.params.id) }));
app.use('/api/fs', auth.requireAuth, files);
app.use('/api/git', auth.requireAuth, git);
app.use('/api/search', auth.requireAuth, search);
app.use('/api/ports', auth.requireAuth, ports);
app.use('/api/project', auth.requireAuth, project);
app.use('/api/system', auth.requireAuth, system.router);
app.use('/api/lsp', auth.requireAuth, lsp.router);
app.use('/api/screen', auth.requireAuth, screenlite.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
// Your files as plain web pages (HTML preview with working relative links).
app.use('/files', auth.requireAuth, (req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); res.removeHeader('Cross-Origin-Resource-Policy'); next(); },
  express.static(config.root, { dotfiles: 'allow', index: ['index.html'], fallthrough: false }));

// --- static ----------------------------------------------------------------
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const vendorOpts = { maxAge: '30d', immutable: true, index: false };
app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm'), vendorOpts));
app.use('/vendor/xterm-fit', express.static(pkgDir('@xterm/addon-fit'), vendorOpts));
app.use('/vendor/xterm-links', express.static(pkgDir('@xterm/addon-web-links'), vendorOpts));
app.use('/vendor/monaco', express.static(path.join(pkgDir('monaco-editor'), 'min'), vendorOpts));
app.use('/vendor/marked', express.static(pkgDir('marked'), vendorOpts));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, file) => {
    if (file.includes(`${path.sep}vendor${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=2592000');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

// --- websockets ------------------------------------------------------------
const termWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
const vncWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const liteWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
const lspWss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: 64 * 1024 * 1024 });
const resolveDir = (rel) => files.resolve(rel);

function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (!auth.upgradeAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (url.pathname === '/ws/term') termWss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws, url, resolveDir));
  else if (url.pathname === '/ws/screen') vncWss.handleUpgrade(req, socket, head, (ws) => vnc.handle(ws));
  else if (url.pathname === '/ws/lite') liteWss.handleUpgrade(req, socket, head, (ws) => screenlite.handle(ws));
  else if (url.pathname === '/ws/lsp') lspWss.handleUpgrade(req, socket, head, (ws) => lsp.handle(ws, url));
  else socket.destroy();
}

setInterval(() => {
  for (const wss of [termWss, vncWss, lspWss, liteWss]) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }
}, 25000).unref();
for (const wss of [termWss, vncWss, lspWss, liteWss]) {
  wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });
}

// --- listening -------------------------------------------------------------
// Without an access code, devbox listens only on this Mac and its Tailscale
// address(es), never on your home Wi-Fi. It watches for Tailscale coming up
// later (e.g. after a reboot) and starts listening there too.
const listening = new Map();   // address -> http.Server

function listenOn(address) {
  if (listening.has(address)) return Promise.resolve(true);
  return new Promise((ok) => {
    const srv = http.createServer(app);
    srv.on('upgrade', onUpgrade);
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && (address === '127.0.0.1' || address === '0.0.0.0')) {
        console.error(`\n  Port ${config.port} is already in use, so devbox is probably already running.\n  Check with: pm2 list   (or start on another port: PORT=7112 npm start)\n`);
        process.exit(1);
      }
      if (e.code !== 'EADDRNOTAVAIL') console.error(`  Couldn't listen on ${address}: ${e.message}`);
      ok(false);
    });
    srv.listen(config.port, address, () => { listening.set(address, srv); ok(true); });
  });
}

async function syncListeners() {
  if (config.host) return;
  for (const ip of netinfo.tailscaleIPs()) await listenOn(ip);
}

async function start() {
  if (config.host) await listenOn(config.host);
  else {
    await listenOn('127.0.0.1');
    await syncListeners();
    setInterval(syncListeners, 15000).unref();
  }
  const awake = system.keepAwake();
  await banner(awake);
}

async function banner(awake) {
  const tsName = await netinfo.tailscaleName();
  const tsIPs = netinfo.tailscaleIPs().filter((ip) => ip.includes('.'));
  const q = config.authRequired ? `/?token=${config.token}` : '/';
  const link = (h) => `http://${h}:${config.port}${q}`;
  const best = tsName || tsIPs[0] || (config.host && config.host !== '0.0.0.0' ? config.host : null);
  const line = '─'.repeat(64);

  console.log(`\n  devbox ${config.version} is running\n  ${line}`);
  if (best) {
    console.log('  Open on your phone:');
    if (tsName) console.log(`    ${link(tsName)}`);
    for (const ip of tsIPs) console.log(`    ${link(ip)}`);
    if (!tsName && !tsIPs.length) console.log(`    ${link(best)}`);
  } else {
    console.log('  Tailscale isn\'t connected on this Mac yet. devbox will start listening on');
    console.log('  your Tailscale address automatically as soon as it connects.');
  }
  console.log(`  On this Mac:  ${link('localhost')}`);
  if (config.authRequired) console.log(`  Access code:  ${config.token}`);
  else if (config.host === '0.0.0.0') console.log('  Warning:      HOST=0.0.0.0 with no access code: anyone on your network can use this.');
  console.log(`  Files:        ${config.root}`);
  const v = await vnc.probe();
  console.log(`  Screen:       ${v.reachable ? 'Screen Sharing is on ✓' : 'Screen Sharing is OFF. Turn it on in System Settings → General → Sharing.'}`);
  if (awake) console.log('  Keep awake:   on (the Mac won\'t idle-sleep while devbox runs)');
  const missing = ['git', 'rg'].filter((b) => !config.bins[b]);
  if (missing.includes('git')) console.log('  Note:         git not found. Install it with: xcode-select --install');
  if (missing.includes('rg')) console.log('  Tip:          brew install ripgrep makes code search much faster.');
  console.log(`  ${line}`);
  if (best && process.stdout.isTTY) {
    try { require('qrcode-terminal').generate(link(best), { small: true }, (qr) => console.log(qr.replace(/^/gm, '  '))); } catch {}
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
start();
