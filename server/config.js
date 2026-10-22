'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.devbox');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// Sign-in is off by default: devbox only listens on your Tailscale address and
// on this Mac, so only your own devices can reach it. Set DEVBOX_TOKEN (or
// DEVBOX_AUTH=1 to generate one) if you want an access code anyway.
function loadToken() {
  if (process.env.DEVBOX_TOKEN) return process.env.DEVBOX_TOKEN.trim();
  if (process.env.DEVBOX_AUTH !== '1') return null;
  const file = path.join(DATA_DIR, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {}
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

// Common install places, so tools are found even when devbox is started by
// pm2/launchd with a minimal PATH.
const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const PATH = [...new Set([...(process.env.PATH || '').split(':'), ...EXTRA_PATH].filter(Boolean))].join(':');

function which(bin) {
  for (const dir of PATH.split(':')) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

const token = loadToken();

const config = {
  port: Number(process.env.PORT || 7111),
  // Explicit HOST overrides the safe default (Tailscale + this Mac only).
  host: process.env.HOST || null,
  root: path.resolve(process.env.DEVBOX_ROOT || HOME),
  home: HOME,
  dataDir: DATA_DIR,
  token,
  authRequired: !!token,
  allowedHosts: (process.env.DEVBOX_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  vncHost: process.env.VNC_HOST || '127.0.0.1',
  vncPort: Number(process.env.VNC_PORT || 5900),
  shell: process.env.DEVBOX_SHELL || process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
  keepAwake: process.env.DEVBOX_KEEP_AWAKE !== '0',
  version: require('../package.json').version,
  env: Object.assign({}, process.env, { PATH }),
  bins: {
    git: which('git'),
    rg: which('rg'),
    lsof: which('lsof'),
    pbcopy: which('pbcopy'),
    pbpaste: which('pbpaste'),
    tailscale: which('tailscale') || (fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : null),
  },
};

module.exports = config;
