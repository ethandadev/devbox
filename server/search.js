'use strict';
// Search inside files (ripgrep if installed, otherwise grep) and quick-open
// by file name.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const { resolve, toRel, HttpError, wrap } = require('./files');

const router = express.Router();
const MAX_HITS = 400;
const IGNORE_DIRS = ['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache', 'Pods', 'DerivedData', '.Trash', 'Library'];

function run(bin, args, cwd, timeout = 15000) {
  return new Promise((ok) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: config.env }, (err, stdout) => ok(stdout || ''));
  });
}

router.get('/text', wrap(async (req, res) => {
  const dir = resolve(req.query.path || '');
  const q = String(req.query.q || '');
  if (!q) return res.json({ results: [], engine: null });
  const regex = req.query.regex === '1';
  const caseSensitive = req.query.case === '1';
  let out, engine;
  if (config.bins.rg) {
    engine = 'ripgrep';
    const args = ['--line-number', '--column', '--no-heading', '--color', 'never', '--max-columns', '240', '--max-columns-preview', '--max-count', '40', '--max-filesize', '2M'];
    if (!regex) args.push('--fixed-strings');
    args.push(caseSensitive ? '--case-sensitive' : '--ignore-case');
    args.push('-e', q, '--', '.');
    out = await run(config.bins.rg, args, dir);
  } else {
    engine = 'grep';
    const args = ['-rnI', '-m', '40', ...IGNORE_DIRS.map((d) => `--exclude-dir=${d}`)];
    if (!regex) args.push('-F'); else args.push('-E');
    if (!caseSensitive) args.push('-i');
    args.push('-e', q, '.');
    out = await run('grep', args, dir);
  }
  const results = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = engine === 'ripgrep' ? line.match(/^(.+?):(\d+):(\d+):(.*)$/) : line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const file = m[1].replace(/^\.\//, '');
    results.push({
      path: toRel(path.join(dir, file)),
      line: Number(m[2]),
      column: engine === 'ripgrep' ? Number(m[3]) : 1,
      text: (engine === 'ripgrep' ? m[4] : m[3]).slice(0, 240),
    });
    if (results.length >= MAX_HITS) break;
  }
  res.json({ results, engine, truncated: results.length >= MAX_HITS });
}));

// ---------- quick open ----------
const listCache = new Map();   // dir -> { at, files }
async function listFiles(dir) {
  const hit = listCache.get(dir);
  if (hit && Date.now() - hit.at < 20000) return hit.files;
  let files = [];
  if (config.bins.rg) {
    const out = await run(config.bins.rg, ['--files', '--max-filesize', '5M', '--', '.'], dir, 10000);
    files = out.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  } else {
    const skip = new Set(IGNORE_DIRS);
    const deadline = Date.now() + 4000;
    const walk = async (d, rel, depth) => {
      if (files.length > 30000 || Date.now() > deadline || depth > 12) return;
      let entries; try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || skip.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(d, e.name), r, depth + 1);
        else files.push(r);
      }
    };
    await walk(dir, '', 0);
  }
  files = files.slice(0, 50000);
  listCache.set(dir, { at: Date.now(), files });
  return files;
}

// Fuzzy match: letters must appear in order; consecutive letters and matches
// at word starts or in the file name score higher.
function score(file, q) {
  const f = file.toLowerCase();
  const nameStart = f.lastIndexOf('/') + 1;
  let fi = 0, s = 0, run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const at = f.indexOf(c, fi);
    if (at < 0) return -1;
    run = at === fi ? run + 1 : 0;
    s += 1 + run * 2;
    if (at >= nameStart) s += 2;
    if (at === 0 || '/._-'.includes(f[at - 1])) s += 3;
    fi = at + 1;
  }
  return s - file.length * 0.02;
}

router.get('/files', wrap(async (req, res) => {
  const dir = resolve(req.query.path || '');
  const q = String(req.query.q || '').toLowerCase().replace(/\s+/g, '');
  const files = await listFiles(dir);
  let results;
  if (!q) results = files.slice(0, 60).map((f) => ({ f, s: 0 }));
  else results = files.map((f) => ({ f, s: score(f, q) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 60);
  res.json({ results: results.map(({ f }) => ({ path: toRel(path.join(dir, f)), rel: f })), total: files.length });
}));

module.exports = router;
