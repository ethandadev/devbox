'use strict';
// What can be run in a project: package.json scripts and Makefile targets.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const { resolve, toRel, wrap } = require('./files');

const router = express.Router();

function managerFor(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

async function findUp(start, name) {
  let dir = start;
  const root = config.root;
  for (;;) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
    if (dir === root || path.dirname(dir) === dir || path.relative(root, dir).startsWith('..')) return null;
    dir = path.dirname(dir);
  }
}

router.get('/scripts', wrap(async (req, res) => {
  const start = resolve(req.query.path || '');
  const out = { groups: [] };

  const pkgPath = await findUp(start, 'package.json');
  if (pkgPath) {
    try {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
      const dir = path.dirname(pkgPath);
      const pm = managerFor(dir);
      const scripts = Object.entries(pkg.scripts || {}).map(([name, command]) => ({
        name, detail: command, command: pm === 'npm' ? (name === 'start' || name === 'test' ? `npm ${name}` : `npm run ${name}`) : `${pm} ${name}`,
      }));
      const hasModules = fs.existsSync(path.join(dir, 'node_modules'));
      if (!hasModules) scripts.unshift({ name: 'install', detail: 'Install dependencies', command: `${pm} install`, suggested: true });
      out.groups.push({ kind: 'package', title: pkg.name || path.basename(dir), file: 'package.json', dir: toRel(dir), items: scripts });
    } catch (e) {
      out.groups.push({ kind: 'package', title: 'package.json', dir: toRel(path.dirname(pkgPath)), error: 'package.json could not be read: ' + e.message, items: [] });
    }
  }

  const makePath = await findUp(start, 'Makefile');
  if (makePath) {
    const text = await fsp.readFile(makePath, 'utf8').catch(() => '');
    const targets = [...new Set([...text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)].map((m) => m[1]).filter((t) => !t.startsWith('.')))].slice(0, 40);
    if (targets.length) out.groups.push({ kind: 'make', title: 'Makefile', file: 'Makefile', dir: toRel(path.dirname(makePath)), items: targets.map((t) => ({ name: t, command: `make ${t}` })) });
  }

  const pyproject = await findUp(start, 'pyproject.toml');
  const manage = await findUp(start, 'manage.py');
  const py = [];
  if (manage) py.push({ name: 'runserver', detail: 'Django dev server on all addresses', command: 'python3 manage.py runserver 0.0.0.0:8000', dir: toRel(path.dirname(manage)) });
  if (pyproject && fs.existsSync(path.join(path.dirname(pyproject), 'uv.lock'))) py.push({ name: 'uv sync', detail: 'Install dependencies', command: 'uv sync', dir: toRel(path.dirname(pyproject)) });
  if (py.length) out.groups.push({ kind: 'python', title: 'Python', dir: py[0].dir, items: py });

  res.json(out);
}));

module.exports = router;
