'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const router = express.Router();
router.use(express.json({ limit: '1mb', type: 'application/json' }));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Turn a path from the phone (relative to the root) into an absolute path,
// refusing anything that climbs out of the root.
function resolve(rel) {
  const abs = path.resolve(config.root, String(rel || '').replace(/^\/+/, ''));
  const back = path.relative(config.root, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new HttpError(403, 'That path is outside the folder devbox is allowed to open.');
  }
  return abs;
}
const toRel = (abs) => path.relative(config.root, abs).split(path.sep).join('/');

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : e.code === 'EEXIST' ? 409 : 500);
  const message = e.status ? e.message
    : e.code === 'ENOENT' ? 'Not found. It may have been moved or deleted on the Mac.'
    : e.code === 'EACCES' || e.code === 'EPERM' ? 'macOS denied access to that file or folder.'
    : e.code === 'EEXIST' ? 'Something with that name already exists.'
    : e.message;
  res.status(status).json({ error: message, code: e.code });
});

router.get('/list', wrap(async (req, res) => {
  const abs = resolve(req.query.path);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  await Promise.all(dirents.map(async (d) => {
    let type = d.isDirectory() ? 'dir' : 'file';
    if (d.isSymbolicLink()) {
      try { type = (await fsp.stat(path.join(abs, d.name))).isDirectory() ? 'dir' : 'file'; } catch { type = 'file'; }
    }
    entries.push({ name: d.name, type, hidden: d.name.startsWith('.') });
  }));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  res.json({ path: toRel(abs), entries });
}));

router.get('/stat', wrap(async (req, res) => {
  const st = await fsp.stat(resolve(req.query.path));
  res.json({ mtime: st.mtimeMs, size: st.size, type: st.isDirectory() ? 'dir' : 'file' });
}));

router.get('/read', wrap(async (req, res) => {
  const abs = resolve(req.query.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new HttpError(400, 'That is a folder.');
  if (st.size > MAX_EDIT_BYTES) throw new HttpError(413, `File is ${(st.size / 1048576).toFixed(1)} MB; the editor opens files up to 5 MB.`);
  const buf = await fsp.readFile(abs);
  if (looksBinary(buf)) throw new HttpError(415, 'This looks like a binary file, so it can\'t be edited as text.');
  res.json({ path: toRel(abs), content: buf.toString('utf8'), mtime: st.mtimeMs });
}));

router.put('/write', express.text({ type: '*/*', limit: '6mb' }), wrap(async (req, res) => {
  const abs = resolve(req.query.path);
  const base = Number(req.query.baseMtime);
  let mode;
  try {
    const st = await fsp.stat(abs);
    mode = st.mode;
    // Someone (you in the terminal, git, another tab) changed the file since
    // the editor loaded it. Refuse instead of silently overwriting.
    if (base && Math.abs(st.mtimeMs - base) > 1 && req.query.force !== '1') {
      return res.status(409).json({ error: 'The file changed on the Mac since you opened it.', mtime: st.mtimeMs });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.devbox-${process.pid}-${Date.now()}`);
  await fsp.writeFile(tmp, typeof req.body === 'string' ? req.body : '', mode ? { mode } : undefined);
  await fsp.rename(tmp, abs);   // atomic: never leaves a half-written file
  const st = await fsp.stat(abs);
  res.json({ ok: true, mtime: st.mtimeMs });
}));

router.post('/create', wrap(async (req, res) => {
  const abs = resolve(req.body.path);
  if (req.body.type === 'dir') await fsp.mkdir(abs);
  else {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, '', { flag: 'wx' });
  }
  res.json({ ok: true, path: toRel(abs) });
}));

router.post('/rename', wrap(async (req, res) => {
  const from = resolve(req.body.from);
  const to = resolve(req.body.to);
  try { await fsp.access(to); throw new HttpError(409, 'Something with that name already exists.'); } catch (e) { if (e.status) throw e; }
  await fsp.rename(from, to);
  res.json({ ok: true, path: toRel(to) });
}));

router.post('/delete', wrap(async (req, res) => {
  const abs = resolve(req.body.path);
  if (abs === config.root) throw new HttpError(400, 'Refusing to delete the root folder.');
  // On a Mac, deleted items go to the Trash so a mis-tap is recoverable.
  const trash = path.join(config.home, '.Trash');
  if (process.platform === 'darwin' && fs.existsSync(trash)) {
    let dest = path.join(trash, path.basename(abs));
    if (fs.existsSync(dest)) dest = path.join(trash, `${path.basename(abs)} ${new Date().toISOString().replace(/[:.]/g, '-')}`);
    try { await fsp.rename(abs, dest); return res.json({ ok: true, trashed: true }); }
    catch (e) { if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; }
  }
  await fsp.rm(abs, { recursive: true });
  res.json({ ok: true, trashed: false });
}));

// Raw bytes: image previews in the editor and downloads to the phone.
router.get('/raw', wrap(async (req, res) => {
  const abs = resolve(req.query.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new HttpError(400, 'That is a folder.');
  if (req.query.download === '1') res.attachment(path.basename(abs));
  res.setHeader('Cache-Control', 'no-cache');
  await new Promise((ok, fail) => res.sendFile(abs, { dotfiles: 'allow' }, (e) => (e ? fail(e) : ok())));
}));

// Upload from the phone: the body is the raw file. Never overwrites: a
// clashing name gets " 2", " 3"… like Finder does.
router.post('/upload', wrap(async (req, res) => {
  const dir = resolve(req.query.dir);
  const name = path.basename(String(req.query.name || 'upload'));
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'Bad file name.');
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let dest = path.join(dir, name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${stem} ${i}${ext}`);
  await new Promise((ok, fail) => {
    const out = fs.createWriteStream(dest, { flags: 'wx' });
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; if (bytes > 500 * 1024 * 1024) { req.destroy(); out.destroy(); fail(new HttpError(413, 'Files over 500 MB can\'t be uploaded.')); } });
    req.pipe(out);
    out.on('finish', ok);
    out.on('error', fail);
    req.on('error', fail);
  });
  res.json({ ok: true, path: toRel(dest) });
}));

module.exports = router;
module.exports.resolve = resolve;
module.exports.toRel = toRel;
module.exports.HttpError = HttpError;
module.exports.wrap = wrap;
