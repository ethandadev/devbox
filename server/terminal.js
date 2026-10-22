'use strict';
/**
 * Terminal sessions that outlive the connection.
 *
 * Phones kill background sockets constantly (lock the screen, switch apps,
 * walk into a lift). So the shell lives on the Mac independently of the
 * WebSocket: when the phone reconnects it re-attaches to the same shell and
 * gets the recent output replayed, like tmux does.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const config = require('./config');

// node-pty 1.1.0 ships its macOS helper program without the "executable"
// permission, which makes every terminal fail with "posix_spawnp failed".
// Repair it on startup so a fresh install or an update can't break terminals.
function fixSpawnHelper() {
  try {
    const base = path.dirname(require.resolve('node-pty/package.json'));
    for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
      const helper = path.join(base, dir, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755);
    }
  } catch (e) {
    console.error('  Could not fix node-pty spawn-helper permissions:', e.message);
  }
}
fixSpawnHelper();

// If $SHELL points somewhere that doesn't exist, fall back to a shell that does.
function pickShell() {
  for (const sh of [config.shell, '/bin/zsh', '/bin/bash', '/bin/sh']) {
    try { fs.accessSync(sh, fs.constants.X_OK); return sh; } catch {}
  }
  return '/bin/sh';
}
const SHELL = pickShell();

const MAX_SESSIONS = 8;
const SCROLLBACK_BYTES = 400 * 1024;        // replayed on re-attach
const IDLE_KILL_MS = 24 * 60 * 60 * 1000;   // unattached for a day -> closed

const sessions = new Map();
let counter = 0;

function shellName() {
  return SHELL.split('/').pop();
}

function createSession(cols, rows, opts = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Too many terminals open (max ${MAX_SESSIONS}). Close one first.`);
  }
  counter += 1;
  const id = crypto.randomBytes(6).toString('hex');
  const env = Object.assign({}, config.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    DEVBOX: '1',
  });
  // -l = login shell, so PATH from ~/.zprofile (Homebrew etc.) is loaded even
  // when devbox itself was started by pm2/launchd with a bare environment.
  const proc = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color',
    cols: clamp(cols, 20, 400, 80),
    rows: clamp(rows, 5, 200, 24),
    cwd: opts.cwd || config.home,
    env,
  });
  // Started from a Run button: type the command once the shell has drawn its
  // prompt, so it appears exactly once, as if you had typed it.
  if (opts.cmd) {
    let sent = false;
    const send = () => { if (!sent) { sent = true; proc.write(opts.cmd + '\r'); } };
    const first = proc.onData(() => { first.dispose(); setTimeout(send, 120); });
    setTimeout(send, 2000);
  }

  const s = {
    id,
    name: opts.name || `${shellName()} ${counter}`,
    proc,
    chunks: [],
    bytes: 0,
    clients: new Set(),
    lastDetached: Date.now(),
    exited: false,
  };

  // Coalesce output so a burst of tiny writes becomes one WebSocket frame.
  let pending = '';
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!pending) return;
    const data = pending;
    pending = '';
    remember(s, data);
    const msg = JSON.stringify({ type: 'data', data });
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(msg);
  };
  proc.onData((d) => {
    pending += d;
    if (!flushTimer) flushTimer = setTimeout(flush, 6);
  });
  proc.onExit(({ exitCode }) => {
    flush();
    s.exited = true;
    const msg = JSON.stringify({ type: 'exit', code: exitCode });
    for (const ws of s.clients) {
      if (ws.readyState === 1) ws.send(msg);
      ws.close(1000, 'shell exited');
    }
    sessions.delete(id);
  });

  sessions.set(id, s);
  return s;
}

function remember(s, data) {
  s.chunks.push(data);
  s.bytes += data.length;
  while (s.bytes > SCROLLBACK_BYTES && s.chunks.length > 1) {
    s.bytes -= s.chunks.shift().length;
  }
}

function clamp(n, lo, hi, dflt) {
  n = Number(n);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function list() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    name: s.name,
    attached: s.clients.size,
  }));
}

function kill(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.proc.kill(); } catch {}
  return true;
}

function attach(ws, url, resolveDir) {
  const id = url.searchParams.get('id');
  const cols = url.searchParams.get('cols');
  const rows = url.searchParams.get('rows');

  let s = id ? sessions.get(id) : null;
  let replay = true;
  if (!s) {
    try {
      let cwd;
      const rel = url.searchParams.get('cwd');
      if (rel !== null) { try { cwd = resolveDir(rel); } catch {} }
      s = createSession(cols, rows, { cwd, cmd: url.searchParams.get('cmd') || '', name: url.searchParams.get('name') || '' });
      replay = false;
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
      ws.close(1011, 'cannot create');
      return;
    }
  }

  s.clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', id: s.id, name: s.name, resumed: replay }));
  if (replay && s.chunks.length) {
    ws.send(JSON.stringify({ type: 'data', data: s.chunks.join('') }));
  }
  if (cols && rows) {
    try { s.proc.resize(clamp(cols, 20, 400, 80), clamp(rows, 5, 200, 24)); } catch {}
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (s.exited) return;
    if (msg.type === 'input' && typeof msg.data === 'string') s.proc.write(msg.data);
    else if (msg.type === 'resize') {
      try { s.proc.resize(clamp(msg.cols, 20, 400, 80), clamp(msg.rows, 5, 200, 24)); } catch {}
    } else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });
  ws.on('close', () => {
    s.clients.delete(ws);
    if (s.clients.size === 0) s.lastDetached = Date.now();
  });
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.clients.size === 0 && now - s.lastDetached > IDLE_KILL_MS) kill(s.id);
  }
}, 10 * 60 * 1000).unref();

module.exports = { attach, list, kill };
