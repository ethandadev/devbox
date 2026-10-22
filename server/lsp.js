'use strict';
/**
 * Language servers: the same "smarts" VS Code uses (completion, errors, hover,
 * go to definition, real semantic highlighting such as your own C++ classes).
 *
 * The phone's editor speaks the Language Server Protocol over a WebSocket; this
 * module starts the matching server installed on the Mac (clangd, pyright,
 * gopls, …) and relays messages. Nothing is installed automatically: the
 * editor shows a one-tap install command when a server is missing.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const config = require('./config');
const { resolve } = require('./files');

// Language group -> how to find and start its server.
const SERVERS = {
  cpp: {
    label: 'C / C++ / Objective-C', name: 'clangd',
    candidates: [['clangd', ['--background-index', '--header-insertion=never', '--log=error']]],
    extraPaths: ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'], xcrun: 'clangd',
    install: process.platform === 'darwin' ? 'brew install llvm && echo "clangd installed"' : 'sudo apt install clangd',
    installNote: 'Installs clangd (part of LLVM). If you have Xcode, devbox can also use the clangd inside it.',
  },
  python: {
    label: 'Python', name: 'pyright',
    candidates: [['pyright-langserver', ['--stdio']], ['basedpyright-langserver', ['--stdio']], ['pylsp', []], ['jedi-language-server', []]],
    install: 'npm install -g pyright', installNote: 'Installs Microsoft\'s Pyright (the engine behind VS Code\'s Python support).',
  },
  go: { label: 'Go', name: 'gopls', candidates: [['gopls', []]], install: 'go install golang.org/x/tools/gopls@latest' },
  rust: { label: 'Rust', name: 'rust-analyzer', candidates: [['rust-analyzer', []]], install: 'rustup component add rust-analyzer' },
  swift: { label: 'Swift', name: 'sourcekit-lsp', candidates: [['sourcekit-lsp', []]], xcrun: 'sourcekit-lsp', install: 'xcode-select --install' },
  shell: { label: 'Shell', name: 'bash-language-server', candidates: [['bash-language-server', ['start']]], install: 'npm install -g bash-language-server' },
  ruby: { label: 'Ruby', name: 'ruby-lsp', candidates: [['ruby-lsp', []], ['solargraph', ['stdio']]], install: 'gem install ruby-lsp' },
  php: { label: 'PHP', name: 'intelephense', candidates: [['intelephense', ['--stdio']]], install: 'npm install -g intelephense' },
  lua: { label: 'Lua', name: 'lua-language-server', candidates: [['lua-language-server', []]], install: 'brew install lua-language-server' },
  java: { label: 'Java', name: 'jdtls', candidates: [['jdtls', []]], install: 'brew install jdtls' },
  kotlin: { label: 'Kotlin', name: 'kotlin-language-server', candidates: [['kotlin-language-server', []]], install: 'brew install kotlin-language-server' },
  zig: { label: 'Zig', name: 'zls', candidates: [['zls', []]], install: 'brew install zls' },
  dart: { label: 'Dart', name: 'dart', candidates: [['dart', ['language-server', '--protocol=lsp']]], install: 'brew install dart' },
};

// Where language tools usually live, beyond the normal PATH.
const HOME = config.home;
const TOOL_DIRS = [path.join(HOME, 'go/bin'), path.join(HOME, '.cargo/bin'), path.join(HOME, '.local/bin'), path.join(HOME, '.npm-global/bin'),
  path.join(HOME, '.bun/bin'), path.join(HOME, '.deno/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
const SEARCH_PATH = [...new Set([...TOOL_DIRS, ...config.env.PATH.split(':')])];
const LSP_ENV = Object.assign({}, config.env, { PATH: SEARCH_PATH.join(':') });

function whichIn(bin, extra = []) {
  for (const dir of [...extra, ...SEARCH_PATH]) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

const found = new Map();   // group -> { bin, args } | null  (cached for a minute)
function locate(group) {
  if (process.env.DEVBOX_LSP === '0') return null;   // turn language servers off
  const hit = found.get(group);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const spec = SERVERS[group];
  let value = null;
  for (const [bin, args] of spec.candidates) {
    const p = whichIn(bin, spec.extraPaths || []);
    if (p) { value = { bin: p, args }; break; }
  }
  if (!value && spec.xcrun && process.platform === 'darwin') {
    try {
      const p = execFileSync('/usr/bin/xcrun', ['--find', spec.xcrun], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p) value = { bin: p, args: spec.candidates[0][1] };
    } catch {}
  }
  found.set(group, { at: Date.now(), value });
  return value;
}

const router = express.Router();
router.get('/servers', (req, res) => {
  const out = {};
  for (const [group, spec] of Object.entries(SERVERS)) {
    const loc = locate(group);
    out[group] = { label: spec.label, name: spec.name, available: !!loc, path: loc ? loc.bin : null, install: spec.install, installNote: spec.installNote || null };
  }
  res.json(out);
});

// One WebSocket <-> one language server process.
function handle(ws, url) {
  const group = url.searchParams.get('group');
  const spec = SERVERS[group];
  if (!spec) { ws.close(4004, 'unknown language'); return; }
  const loc = locate(group);
  if (!loc) { ws.close(4005, 'not installed'); return; }
  let cwd;
  try { cwd = resolve(url.searchParams.get('root') || ''); if (!fs.statSync(cwd).isDirectory()) cwd = path.dirname(cwd); }
  catch { cwd = config.root; }

  let proc;
  try { proc = spawn(loc.bin, loc.args, { cwd, env: LSP_ENV, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { ws.close(4006, 'failed to start'); return; }

  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buf.subarray(0, headerEnd).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < headerEnd + 4 + len) return;
      const body = buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      buf = buf.subarray(headerEnd + 4 + len);
      if (ws.readyState === 1) ws.send(body);
    }
  });
  let stderrTail = '';
  proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
  proc.on('error', () => { try { ws.close(4006, 'failed to start'); } catch {} });
  proc.on('exit', (code) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'devbox/serverExited', params: { code, stderr: stderrTail.slice(-600) } }));
      ws.close(1000, 'server exited');
    }
  });

  ws.on('message', (data) => {
    const text = data.toString();
    if (!proc.stdin.writable) return;
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
  });
  ws.on('close', () => {
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
  });
}

module.exports = { router, handle, SERVERS };
