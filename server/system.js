'use strict';
// Mac clipboard sharing and keeping the Mac awake.
const express = require('express');
const { execFile, spawn } = require('child_process');
const config = require('./config');
const { HttpError, wrap } = require('./files');

const router = express.Router();

router.get('/clipboard', wrap(async (req, res) => {
  if (!config.bins.pbpaste) throw new HttpError(501, 'Clipboard sharing only works on a Mac.');
  const text = await new Promise((ok, fail) => execFile(config.bins.pbpaste, [], { timeout: 4000, maxBuffer: 8 * 1024 * 1024, env: Object.assign({}, config.env, { LANG: 'en_US.UTF-8' }) }, (e, out) => (e ? fail(e) : ok(out))));
  res.json({ text });
}));

router.put('/clipboard', express.text({ type: '*/*', limit: '8mb' }), wrap(async (req, res) => {
  if (!config.bins.pbcopy) throw new HttpError(501, 'Clipboard sharing only works on a Mac.');
  await new Promise((ok, fail) => {
    const p = spawn(config.bins.pbcopy, [], { env: Object.assign({}, config.env, { LANG: 'en_US.UTF-8' }) });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error('pbcopy failed'))));
    p.stdin.end(typeof req.body === 'string' ? req.body : '');
  });
  res.json({ ok: true });
}));

// A sleeping Mac drops off the tailnet. While devbox runs, ask macOS not to
// idle-sleep (the display can still turn off). Ends automatically with devbox.
let caffeinate = null;
function keepAwake() {
  if (!config.keepAwake || process.platform !== 'darwin') return false;
  try {
    caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
    caffeinate.on('error', () => { caffeinate = null; });
    return true;
  } catch { return false; }
}

module.exports = { router, keepAwake, isKeepingAwake: () => !!caffeinate };
