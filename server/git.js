'use strict';
// Git for the phone: status, diffs, stage/unstage/discard, commit, push/pull,
// branches, history and stash. Runs the Mac's own git, so your SSH keys and
// credential helper work as usual.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const { resolve, toRel, HttpError, wrap } = require('./files');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

function git(cwd, args, { timeout = 20000, maxBuffer = 32 * 1024 * 1024, encoding = 'utf8', allowFail = false } = {}) {
  return new Promise((ok, fail) => {
    if (!config.bins.git) return fail(new HttpError(501, 'Git is not installed on this Mac. Install it with: xcode-select --install'));
    execFile(config.bins.git, args, {
      cwd, timeout, maxBuffer, encoding,
      env: Object.assign({}, config.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_PAGER: 'cat', GIT_EDITOR: 'true' }),
    }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        const msg = String(stderr || err.message).trim().split('\n').filter((l) => !/^hint:/.test(l)).slice(-6).join('\n');
        const e = new HttpError(err.killed ? 504 : 400, err.killed ? 'Git took too long and was stopped.' : (msg || 'git failed'));
        return fail(e);
      }
      ok(err ? null : stdout);
    });
  });
}

async function repoRoot(rel) {
  const abs = resolve(rel);
  let dir = abs;
  try { if (!(await fsp.stat(abs)).isDirectory()) dir = path.dirname(abs); } catch { dir = path.dirname(abs); }
  const out = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!out) return null;
  const root = fs.realpathSync(out.trim());
  // Repos outside the editor root are off limits.
  const rootReal = fs.realpathSync(config.root);
  if (path.relative(rootReal, root).startsWith('..')) return null;
  return root;
}

async function needRepo(rel) {
  const root = await repoRoot(rel);
  if (!root) throw new HttpError(404, 'This folder is not a git repository.');
  return root;
}

const relToRoot = (abs) => toRel(path.join(config.root, path.relative(fs.realpathSync(config.root), abs)));

// ---------- status ----------
function parseStatus(out) {
  const res = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) { const b = line.slice(14); res.detached = b === '(detached)'; res.branch = res.detached ? null : b; }
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { res.ahead = +m[1]; res.behind = +m[2]; } }
    else if (line[0] === '1' || line[0] === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const p = f.slice(line[0] === '1' ? 8 : 9).join(' ');
      const entry = { path: p, x: xy[0], y: xy[1] };
      if (line[0] === '2') { entry.orig = parts[i + 1]; i++; }
      res.files.push(entry);
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      res.files.push({ path: f.slice(10).join(' '), x: 'U', y: 'U', conflicted: true });
    } else if (line[0] === '?') {
      res.files.push({ path: line.slice(2), x: '?', y: '?', untracked: true });
    }
  }
  return res;
}

router.get('/status', wrap(async (req, res) => {
  const root = await repoRoot(req.query.path || '');
  if (!root) return res.json({ repo: null });
  const [out, hasHead, stashList, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }),
    git(root, ['stash', 'list', '--format=%gd'], { allowFail: true }),
    git(root, ['remote'], { allowFail: true }),
  ]);
  const st = parseStatus(out);
  const staged = [], changes = [], conflicts = [];
  for (const f of st.files) {
    if (f.conflicted) conflicts.push({ path: f.path, status: 'U' });
    else if (f.untracked) changes.push({ path: f.path, status: 'U', untracked: true });
    else {
      if (f.x !== '.') staged.push({ path: f.path, status: f.x, orig: f.orig });
      if (f.y !== '.') changes.push({ path: f.path, status: f.y, orig: f.orig });
    }
  }
  res.json({
    repo: relToRoot(root), name: path.basename(root), branch: st.branch, detached: st.detached,
    upstream: st.upstream, ahead: st.ahead, behind: st.behind, hasCommits: !!hasHead,
    remotes: (remotes || '').split('\n').filter(Boolean),
    stashes: stashList ? stashList.split('\n').filter(Boolean).length : 0,
    staged, changes, conflicts,
  });
}));

// Find repositories under the root (for the project picker).
router.get('/repos', wrap(async (req, res) => {
  const found = [];
  const skip = new Set(['node_modules', 'Library', '.Trash', 'Applications', 'Pictures', 'Music', 'Movies', '.cache', '.npm', '.cargo', '.rustup', 'vendor', 'Pods', 'build', 'dist', '.venv', 'venv']);
  const deadline = Date.now() + 3000;
  async function walk(dir, depth) {
    if (found.length >= 80 || Date.now() > deadline) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) { found.push(toRel(dir)); return; }
    if (depth >= 4) return;
    await Promise.all(entries.filter((e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')).map((e) => walk(path.join(dir, e.name), depth + 1)));
  }
  await walk(config.root, 0);
  found.sort((a, b) => a.localeCompare(b));
  res.json({ repos: found });
}));

// ---------- diffs ----------
async function showBlob(root, spec) {
  const out = await git(root, ['show', spec], { allowFail: true, encoding: 'buffer', maxBuffer: MAX_DIFF_BYTES * 2 });
  return out === null ? null : out;
}
function asText(buf) {
  if (!buf) return { text: '' };
  if (buf.length > MAX_DIFF_BYTES) return { tooBig: true };
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return { binary: true };
  return { text: buf.toString('utf8') };
}

router.get('/diff', wrap(async (req, res) => {
  const root = await needRepo(req.query.repo);
  const file = String(req.query.path || '');
  const orig = String(req.query.orig || file);
  const mode = req.query.mode || 'worktree';
  let a, b;
  if (mode === 'staged') {
    a = await showBlob(root, `HEAD:${orig}`);
    b = await showBlob(root, `:${file}`);
  } else if (mode === 'commit') {
    const hash = String(req.query.hash || '');
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new HttpError(400, 'Bad commit id.');
    a = await showBlob(root, `${hash}^:${orig}`);
    b = await showBlob(root, `${hash}:${file}`);
  } else {
    a = await showBlob(root, `:${file}`);
    try { b = await fsp.readFile(path.join(root, file)); } catch { b = null; }
  }
  const A = asText(a), B = asText(b);
  if (A.binary || B.binary) return res.json({ binary: true });
  if (A.tooBig || B.tooBig) return res.json({ tooBig: true });
  res.json({ original: A.text, modified: B.text, path: file });
}));

// ---------- changing things ----------
const pathsOf = (body) => (Array.isArray(body.paths) ? body.paths.map(String) : []);

router.post('/stage', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  const paths = pathsOf(req.body);
  await git(root, paths.length ? ['add', '-A', '--', ...paths] : ['add', '-A']);
  res.json({ ok: true });
}));

router.post('/unstage', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  const paths = pathsOf(req.body);
  const hasHead = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  if (hasHead) await git(root, paths.length ? ['restore', '--staged', '--', ...paths] : ['restore', '--staged', '.']);
  else await git(root, ['rm', '-r', '-q', '--cached', '--', ...(paths.length ? paths : ['.'])]);
  res.json({ ok: true });
}));

router.post('/discard', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  const paths = pathsOf(req.body);
  if (!paths.length) throw new HttpError(400, 'Nothing to discard.');
  const tracked = [], untracked = [];
  for (const p of paths) {
    const known = await git(root, ['ls-files', '--error-unmatch', '--', p], { allowFail: true });
    (known ? tracked : untracked).push(p);
  }
  if (tracked.length) await git(root, ['restore', '--worktree', '--', ...tracked]);
  // New files are moved to the Trash rather than deleted outright.
  for (const p of untracked) {
    const abs = path.join(root, p);
    const trash = path.join(config.home, '.Trash');
    if (process.platform === 'darwin' && fs.existsSync(trash)) {
      let dest = path.join(trash, path.basename(abs));
      if (fs.existsSync(dest)) dest = path.join(trash, `${path.basename(abs)} ${Date.now()}`);
      try { await fsp.rename(abs, dest); continue; } catch {}
    }
    await fsp.rm(abs, { recursive: true, force: true });
  }
  res.json({ ok: true });
}));

router.post('/commit', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  const message = String(req.body.message || '').trim();
  if (!message) throw new HttpError(400, 'Write a commit message first.');
  if (req.body.all) await git(root, ['add', '-A']);
  const staged = await git(root, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) throw new HttpError(400, 'Nothing is staged. Stage some changes, or use "Commit all".');
  try {
    await git(root, ['commit', '-m', message]);
  } catch (e) {
    if (/Please tell me who you are|user\.email|user\.name/i.test(e.message)) {
      throw new HttpError(400, 'Git doesn\'t know your name and email yet. In the terminal run:\ngit config --global user.name "Your Name"\ngit config --global user.email you@example.com');
    }
    throw e;
  }
  const head = await git(root, ['log', '-1', '--format=%h %s']);
  res.json({ ok: true, head: head.trim() });
}));

router.post('/sync', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  const action = req.body.action;
  let out;
  try {
    if (action === 'fetch') out = await git(root, ['fetch', '--prune'], { timeout: 90000 });
    else if (action === 'pull') out = await git(root, ['pull', '--ff-only'], { timeout: 90000 });
    else if (action === 'push') {
      const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
      out = await git(root, up ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeout: 90000 });
    } else throw new HttpError(400, 'Unknown action.');
  } catch (e) {
    if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey\)/i.test(e.message)) {
      throw new HttpError(400, 'Git needs to log in to the remote, and can\'t ask for a password from here. Set up an SSH key or run the command once in the terminal so your Mac remembers the login.');
    }
    if (/Not possible to fast-forward|diverging branches/i.test(e.message)) {
      throw new HttpError(400, 'Your branch and the remote have both changed. Pull in the terminal to choose how to merge (git pull --rebase or git pull --no-rebase).');
    }
    throw e;
  }
  res.json({ ok: true, output: (out || '').trim() });
}));

router.post('/init', wrap(async (req, res) => {
  const dir = resolve(req.body.path || '');
  await git(dir, ['init']);
  res.json({ ok: true });
}));

router.post('/stash', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  if (req.body.action === 'pop') await git(root, ['stash', 'pop']);
  else await git(root, ['stash', 'push', '--include-untracked', '-m', `devbox ${new Date().toLocaleString()}`]);
  res.json({ ok: true });
}));

// ---------- history ----------
router.get('/log', wrap(async (req, res) => {
  const root = await needRepo(req.query.repo);
  const skip = Math.max(0, Number(req.query.skip) || 0);
  const out = await git(root, ['log', '-n', '60', `--skip=${skip}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1e'], { allowFail: true });
  const commits = (out || '').split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [hash, short, author, at, subject, refs] = s.split('\x1f');
    return { hash, short, author, time: Number(at) * 1000, subject, refs: refs ? refs.split(', ').filter((r) => r && r !== 'HEAD') : [] };
  });
  res.json({ commits });
}));

router.get('/show', wrap(async (req, res) => {
  const root = await needRepo(req.query.repo);
  const hash = String(req.query.hash || '');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new HttpError(400, 'Bad commit id.');
  const [meta, names] = await Promise.all([
    git(root, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B', hash]),
    git(root, ['show', '--format=', '--name-status', '-z', '-M', hash]),
  ]);
  const [full, author, email, at, body] = meta.split('\x1f');
  const parts = names.split('\0').filter((x) => x !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (/^[RC]/.test(st)) { files.push({ status: st[0], orig: parts[i + 1], path: parts[i + 2] }); i += 2; }
    else { files.push({ status: st[0], path: parts[i + 1] }); i += 1; }
  }
  res.json({ hash: full, author, email, time: Number(at) * 1000, message: (body || '').trim(), files });
}));

// ---------- branches ----------
router.get('/branches', wrap(async (req, res) => {
  const root = await needRepo(req.query.repo);
  const out = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)', 'refs/heads', 'refs/remotes']);
  const local = [], remote = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, name, head, upstream] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) local.push({ name, current: head === '*', upstream });
    else if (!ref.endsWith('/HEAD')) remote.push({ name });
  }
  res.json({ local, remote });
}));

router.post('/checkout', wrap(async (req, res) => {
  const root = await needRepo(req.body.repo);
  const branch = String(req.body.branch || '').trim();
  if (!branch || /[\s~^:?*\[\\]/.test(branch)) throw new HttpError(400, 'That isn\'t a valid branch name.');
  if (req.body.create) await git(root, ['switch', '-c', branch]);
  else if (req.body.remote) {
    const local = branch.replace(/^[^/]+\//, '');
    const exists = await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { allowFail: true });
    await git(root, exists ? ['switch', local] : ['switch', '--track', branch]);
  } else await git(root, ['switch', branch]);
  res.json({ ok: true });
}));

module.exports = router;
