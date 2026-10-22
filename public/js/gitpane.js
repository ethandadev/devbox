import { api, qs, h, icon, iconButton, menu, prompt, confirm, sheet, toast, timeAgo, splitPath, projectChip, pickProject } from './ui.js';

const STATUS_NAME = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked', T: 'Type changed', '?': 'Untracked' };

export class GitPane {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.data = null;
    this.visible = false;
    this.busy = false;

    this.top = h('div', { dataset: { for: 'git' } },
      iconButton('refresh', 'Refresh', () => this.refresh(true)),
      iconButton('more', 'Git options', () => this.moreMenu()));
    ctx.topActions.append(this.top);

    this.body = h('div', { class: 'scroll-pane' });
    this.overlay = h('div', { class: 'overlay', hidden: true });
    el.append(this.body, this.overlay);

    ctx.project.onChange(() => { this.data = null; if (this.visible) this.refresh(); else this.refreshBadge(); });
    window.addEventListener('devbox:saved', () => { if (this.visible) this.refresh(); else this.refreshBadge(); });
    setInterval(() => { if (this.visible && document.visibilityState === 'visible' && this.overlay.hidden) this.refresh(); }, 6000);
  }

  get repo() { return this.data && this.data.repo; }

  show() { this.visible = true; this.refresh(true); }
  hide() { this.visible = false; }
  onResume() { if (this.visible) this.refresh(); }

  async refreshBadge() {
    if (!this.ctx.status.features.git) return;
    try {
      const d = await api('/api/git/status?' + qs({ path: this.ctx.project.get() }));
      this.ctx.setBadge('git', !!(d.repo && (d.staged.length || d.changes.length || d.conflicts.length)));
    } catch {}
  }

  async refresh(showSpinner = false) {
    if (!this.ctx.status.features.git) { this.renderNoGit(); return; }
    if (showSpinner && !this.data) this.body.replaceChildren(h('p', { class: 'pane-msg' }, 'Reading repository…'));
    try {
      const d = await api('/api/git/status?' + qs({ path: this.ctx.project.get() }));
      this.data = d;
      this.ctx.setBadge('git', !!(d.repo && (d.staged.length || d.changes.length || d.conflicts.length)));
      if (!d.repo) return this.renderNotRepo();
      this.render();
      if (showSpinner || !this.log) this.loadLog();
    } catch (e) {
      this.body.replaceChildren(h('div', { class: 'empty-block' }, h('h2', {}, 'Couldn\'t read git status'), h('p', {}, e.message),
        h('button', { class: 'btn', type: 'button', onclick: () => this.refresh(true) }, 'Try again')));
    }
  }

  // ---------- states ----------
  renderNoGit() {
    this.body.replaceChildren(h('div', { class: 'empty-block' },
      h('h2', {}, 'Git isn\'t installed on your Mac'),
      h('p', {}, 'Install Apple\'s developer tools, which include git:'),
      h('code', { class: 'cmd' }, 'xcode-select --install'),
      h('button', { class: 'btn', type: 'button', onclick: () => { this.ctx.switchTab('term'); this.ctx.panes().term.runCommand('xcode-select --install'); } }, 'Run it in the terminal')));
  }

  renderNotRepo() {
    const p = this.ctx.project.get();
    this.body.replaceChildren(
      h('div', { class: 'pane-bar' }, projectChip(this.ctx)),
      h('div', { class: 'empty-block' },
        h('h2', {}, `${p ? p.split('/').pop() : 'This folder'} isn't a git repository`),
        h('p', {}, 'Pick one of your repositories, or start tracking this folder with git.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => pickProject(this.ctx) }, 'Choose a repository'),
          h('button', { class: 'btn', type: 'button', onclick: () => this.init() }, 'Initialize here'))));
  }

  async init() {
    const p = this.ctx.project.get();
    if (!(await confirm('Start a git repository here?', `Runs “git init” in ${p || this.ctx.status.root}.`, { ok: 'Initialize' }))) return;
    try { await api('/api/git/init', { method: 'POST', json: { path: p } }); toast('Repository created', 'ok'); this.refresh(true); }
    catch (e) { toast(e.message, 'bad'); }
  }

  // ---------- main view ----------
  render() {
    const d = this.data;
    const keepMsg = this.msgInput ? this.msgInput.value : '';
    const scrollTop = this.body.scrollTop;

    const branchChip = h('button', { class: 'chip-btn', type: 'button', onclick: () => this.branchMenu(), 'aria-label': 'Branches' },
      icon('branch'), h('span', {}, d.detached ? 'detached HEAD' : (d.branch || 'no branch')), icon('down'));
    const sync = this.syncButton(d);
    const bar = h('div', { class: 'pane-bar' }, projectChip(this.ctx), branchChip, sync);

    // commit box
    const total = d.staged.length + d.changes.length;
    this.msgInput = h('textarea', { class: 'input commit-msg', id: 'commit-msg', rows: 2, placeholder: d.staged.length ? `Message for ${d.staged.length} staged change${d.staged.length === 1 ? '' : 's'}` : 'Commit message', autocapitalize: 'sentences' });
    this.msgInput.value = keepMsg;
    const commitAll = !d.staged.length && d.changes.length > 0;
    const commitBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: !total, onclick: () => this.commit(commitAll) },
      icon('check'), commitAll ? 'Commit all changes' : d.staged.length ? `Commit ${d.staged.length}` : 'Commit');
    const box = h('div', { class: 'commit-box' }, this.msgInput, commitBtn);

    const sections = [];
    if (d.conflicts.length) sections.push(this.section('Merge conflicts', d.conflicts, 'conflict'));
    if (d.staged.length) sections.push(this.section('Staged', d.staged, 'staged'));
    if (d.changes.length) sections.push(this.section('Changes', d.changes, 'changes'));
    if (!total && !d.conflicts.length) {
      sections.push(h('div', { class: 'clean' }, icon('check'), h('div', {}, h('b', {}, 'Nothing to commit'), h('span', {}, d.hasCommits ? 'Your working tree matches the last commit.' : 'Create some files to make the first commit.'))));
    }

    this.logEl = this.logEl || h('div', { class: 'log' });
    this.body.replaceChildren(bar, (total || d.conflicts.length) ? box : null, ...sections,
      h('div', { class: 'section-head' }, h('span', {}, 'History'), d.stashes ? h('span', { class: 'muted' }, `${d.stashes} stashed`) : null),
      this.logEl);
    this.body.scrollTop = scrollTop;
  }

  syncButton(d) {
    const parts = [];
    if (d.behind) parts.push(`↓${d.behind}`);
    if (d.ahead) parts.push(`↑${d.ahead}`);
    const label = !d.upstream ? (d.hasCommits && d.remotes.length ? 'Publish' : '') : parts.join(' ') || 'Synced';
    if (!label) return null;
    const btn = h('button', { class: 'chip-btn sync' + (d.ahead || d.behind || !d.upstream ? ' attention' : ''), type: 'button', onclick: () => this.syncMenu() }, icon('sync'), h('span', {}, label));
    return btn;
  }

  section(title, items, kind) {
    const actions = [];
    if (kind === 'staged') actions.push(h('button', { class: 'link-btn', type: 'button', onclick: () => this.op('unstage', []) }, 'Unstage all'));
    if (kind === 'changes') {
      actions.push(h('button', { class: 'link-btn', type: 'button', onclick: () => this.discardAll(items) }, 'Discard all'));
      actions.push(h('button', { class: 'link-btn', type: 'button', onclick: () => this.op('stage', []) }, 'Stage all'));
    }
    const list = h('div', { class: 'list' }, ...items.map((f) => this.fileRow(f, kind)));
    return h('section', {}, h('div', { class: 'section-head' }, h('span', {}, `${title}`, h('em', {}, String(items.length))), h('span', { class: 'head-actions' }, ...actions)), list);
  }

  fileRow(f, kind) {
    const [dir, name] = splitPath(f.path);
    const st = f.status;
    const btns = [];
    if (kind === 'staged') btns.push(iconButton('minus', `Unstage ${name}`, (e) => { e.stopPropagation(); this.op('unstage', [f.path]); }));
    else {
      if (kind === 'changes') btns.push(iconButton('discard', `Discard changes to ${name}`, (e) => { e.stopPropagation(); this.discard(f); }));
      btns.push(iconButton('plus', `Stage ${name}`, (e) => { e.stopPropagation(); this.op('stage', [f.path]); }));
    }
    return h('div', { class: 'file-row', role: 'button', tabindex: 0, onclick: () => this.openDiff(f, kind === 'staged' ? 'staged' : 'worktree') },
      h('span', { class: `st st-${st === '?' ? 'U' : st}`, title: STATUS_NAME[st] || st }, st === '?' ? 'U' : st),
      h('span', { class: 'fr-name' }, h('b', { class: st === 'D' ? 'deleted' : '' }, name), dir ? h('small', {}, dir) : null),
      h('span', { class: 'fr-actions' }, ...btns));
  }

  // ---------- actions ----------
  async op(kind, paths) {
    try { await api(`/api/git/${kind}`, { method: 'POST', json: { repo: this.repo, paths } }); }
    catch (e) { toast(e.message, 'bad'); }
    this.refresh();
  }

  async discard(f) {
    const [, name] = splitPath(f.path);
    const ok = await confirm(`Discard changes to ${name}?`, f.untracked ? 'This new file will be moved to the Trash.' : 'The file goes back to how it was at the last commit (or the staged version). This can\'t be undone.', { ok: 'Discard', danger: true });
    if (ok) this.op('discard', [f.path]);
  }

  async discardAll(items) {
    const ok = await confirm(`Discard all ${items.length} changes?`, 'Unstaged edits are thrown away and new files go to the Trash. Staged changes are kept.', { ok: 'Discard all', danger: true });
    if (ok) this.op('discard', items.map((f) => f.path));
  }

  async commit(all) {
    const message = this.msgInput.value.trim();
    if (!message) { this.msgInput.focus(); toast('Write a commit message first.'); return; }
    try {
      const r = await api('/api/git/commit', { method: 'POST', json: { repo: this.repo, message, all } });
      this.msgInput.value = '';
      this.msgInput.blur();
      await this.refresh();
      this.loadLog();
      const d = this.data;
      toast(`Committed ${r.head}`, 'ok', d && d.remotes.length ? { label: d.upstream ? 'Push' : 'Publish', onClick: () => this.sync('push') } : null);
    } catch (e) { toast(e.message, 'bad'); }
  }

  async syncMenu() {
    const d = this.data;
    const choice = await menu(d.upstream ? `Sync with ${d.upstream}` : 'Publish branch', [
      d.upstream ? { label: 'Pull', value: 'pull', icon: 'download', sub: d.behind ? `${d.behind} new` : '' } : null,
      { label: d.upstream ? 'Push' : `Publish ${d.branch || 'branch'} to origin`, value: 'push', icon: 'upload', sub: d.ahead ? `${d.ahead} to send` : '' },
      { label: 'Fetch', value: 'fetch', icon: 'sync', sub: 'check for new commits' },
    ]);
    if (choice) this.sync(choice);
  }

  async sync(action) {
    const label = { pull: 'Pulling', push: 'Pushing', fetch: 'Fetching' }[action];
    toast(`${label}…`);
    try {
      await api('/api/git/sync', { method: 'POST', json: { repo: this.repo, action }, timeout: 100000 });
      toast({ pull: 'Pulled', push: 'Pushed', fetch: 'Fetched' }[action], 'ok');
    } catch (e) { toast(e.message, 'bad'); }
    this.refresh();
    this.loadLog();
  }

  async branchMenu() {
    let b;
    try { b = await api('/api/git/branches?' + qs({ repo: this.repo })); } catch (e) { toast(e.message, 'bad'); return; }
    const localNames = new Set(b.local.map((x) => x.name));
    const remotes = b.remote.filter((r) => !localNames.has(r.name.replace(/^[^/]+\//, ''))).slice(0, 15);
    const choice = await menu('Branches', [
      { label: 'New branch…', value: 'new', icon: 'plus' },
      ...b.local.slice(0, 25).map((x) => ({ label: x.name, value: 'l:' + x.name, current: x.current, icon: 'branch', sub: x.current ? 'current' : (x.upstream || '') })),
      ...remotes.map((x) => ({ label: x.name, value: 'r:' + x.name, icon: 'globe', sub: 'remote' })),
    ]);
    if (!choice) return;
    let body;
    if (choice === 'new') {
      const name = await prompt('New branch', { placeholder: 'feature/my-change', ok: 'Create and switch' });
      if (!name) return;
      body = { branch: name, create: true };
    } else if (choice.startsWith('r:')) body = { branch: choice.slice(2), remote: true };
    else { if (choice.slice(2) === this.data.branch) return; body = { branch: choice.slice(2) }; }
    try { await api('/api/git/checkout', { method: 'POST', json: { repo: this.repo, ...body } }); toast(`On ${body.branch.replace(/^origin\//, '')}`, 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
    this.refresh(); this.loadLog();
  }

  async moreMenu() {
    if (!this.repo) { pickProject(this.ctx); return; }
    const d = this.data;
    const choice = await menu(d.name, [
      d.remotes.length ? { label: 'Pull', value: 'pull', icon: 'download' } : null,
      d.remotes.length ? { label: d.upstream ? 'Push' : 'Publish branch', value: 'push', icon: 'upload' } : null,
      d.remotes.length ? { label: 'Fetch', value: 'fetch', icon: 'sync' } : null,
      { label: 'Stash changes', value: 'stash', icon: 'history', sub: 'set aside, including new files' },
      d.stashes ? { label: 'Pop latest stash', value: 'pop', icon: 'history', sub: `${d.stashes} saved` } : null,
      { label: 'Switch project…', value: 'project', icon: 'folder' },
      { label: 'Open terminal in repo', value: 'term', icon: 'keyboard' },
    ]);
    if (!choice) return;
    if (['pull', 'push', 'fetch'].includes(choice)) this.sync(choice);
    else if (choice === 'stash' || choice === 'pop') {
      try { await api('/api/git/stash', { method: 'POST', json: { repo: this.repo, action: choice === 'pop' ? 'pop' : 'push' } }); toast(choice === 'pop' ? 'Stash applied' : 'Changes stashed', 'ok'); }
      catch (e) { toast(e.message, 'bad'); }
      this.refresh();
    } else if (choice === 'project') pickProject(this.ctx);
    else if (choice === 'term') {
      this.ctx.switchTab('term');
      this.ctx.panes().term.openSession({ cwd: this.repo, name: d.name });
    }
  }

  // ---------- history ----------
  async loadLog(more = false) {
    if (!this.repo || !this.logEl) return;
    const skip = more ? this.log.length : 0;
    let r;
    try { r = await api('/api/git/log?' + qs({ repo: this.repo, skip })); } catch { return; }
    this.log = more ? this.log.concat(r.commits) : r.commits;
    if (!this.log.length) { this.logEl.replaceChildren(h('p', { class: 'pane-msg' }, 'No commits yet.')); return; }
    const rows = this.log.map((c) => h('button', { class: 'commit-row', type: 'button', onclick: () => this.showCommit(c) },
      h('span', { class: 'c-subject' }, c.subject),
      h('span', { class: 'c-meta' }, h('code', {}, c.short), ` ${c.author} · ${timeAgo(c.time)}`, ...c.refs.slice(0, 3).map((r) => h('span', { class: 'ref' }, r.replace(/^HEAD -> /, ''))))));
    if (r.commits.length === 60) rows.push(h('button', { class: 'btn more-btn', type: 'button', onclick: () => this.loadLog(true) }, 'Show older commits'));
    this.logEl.replaceChildren(...rows);
  }

  async showCommit(c) {
    let d;
    try { d = await api('/api/git/show?' + qs({ repo: this.repo, hash: c.hash })); } catch (e) { toast(e.message, 'bad'); return; }
    sheet((panel, done) => {
      const [subject, ...rest] = d.message.split('\n');
      panel.append(
        h('h3', {}, subject),
        rest.join('\n').trim() ? h('p', { class: 'commit-body' }, rest.join('\n').trim()) : null,
        h('p', { class: 'mono small' }, `${c.short} · ${d.author} · ${new Date(d.time).toLocaleString()}`),
        h('div', { class: 'list' }, ...d.files.map((f) => {
          const [dir, name] = splitPath(f.path);
          return h('div', { class: 'file-row', role: 'button', tabindex: 0, onclick: () => { done(null); this.openDiff(f, 'commit', c); } },
            h('span', { class: `st st-${f.status}` }, f.status),
            h('span', { class: 'fr-name' }, h('b', {}, name), dir ? h('small', {}, dir) : null));
        })),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Close')));
    });
  }

  // ---------- diff viewer ----------
  async openDiff(f, mode, commit) {
    const [, name] = splitPath(f.path);
    this.overlay.hidden = false;
    const title = mode === 'commit' ? `${commit.short}` : mode === 'staged' ? 'Staged' : 'Changes';
    const host = h('div', { class: 'diff-host' }, h('p', { class: 'pane-msg' }, 'Loading diff…'));
    const actions = h('div', { class: 'diff-actions' });
    this.overlay.replaceChildren(
      h('div', { class: 'overlay-head' },
        iconButton('back', 'Back', () => this.closeDiff()),
        h('div', { class: 'oh-title' }, h('b', {}, name), h('small', {}, `${title} · ${STATUS_NAME[f.status] || f.status}`)),
        iconButton('files', 'Open in editor', () => { this.closeDiff(); this.ctx.switchTab('code'); this.ctx.panes().code.open(this.repoPath(f.path)).catch(() => {}); })),
      host, actions);

    if (mode !== 'commit') {
      if (mode === 'staged') actions.append(h('button', { class: 'btn', type: 'button', onclick: () => { this.op('unstage', [f.path]); this.closeDiff(); } }, icon('minus'), 'Unstage'));
      else {
        actions.append(h('button', { class: 'btn', type: 'button', onclick: async () => { await this.discard(f); this.closeDiff(); } }, icon('discard'), 'Discard'));
        actions.append(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { this.op('stage', [f.path]); this.closeDiff(); } }, icon('plus'), 'Stage'));
      }
    }

    let data, monaco;
    try {
      [data, monaco] = await Promise.all([
        api('/api/git/diff?' + qs({ repo: this.repo, path: f.path, orig: f.orig || f.path, mode, hash: commit ? commit.hash : '' })),
        this.ctx.panes().code.ensureEditor().then(() => window.monaco),
      ]);
    } catch (e) { host.replaceChildren(h('p', { class: 'pane-msg' }, e.message)); return; }
    if (this.overlay.hidden) return;
    if (data.binary || data.tooBig) { host.replaceChildren(h('p', { class: 'pane-msg' }, data.binary ? 'Binary file: no text diff to show.' : 'This file is too big to show a diff here.')); return; }

    host.replaceChildren();
    const lang = this.ctx.panes().code.languageFor(f.path);
    const original = monaco.editor.createModel(data.original, lang);
    const modified = monaco.editor.createModel(data.modified, lang);
    const phone = window.matchMedia('(max-width: 700px)').matches;
    const diff = monaco.editor.createDiffEditor(host, {
      theme: 'devbox', readOnly: true, originalEditable: false, automaticLayout: true,
      renderSideBySide: !phone, useInlineViewWhenSpaceIsLimited: true,
      fontSize: 12.5, fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', minimap: { enabled: false },
      scrollBeyondLastLine: false, renderOverviewRuler: false, wordWrap: 'on', diffWordWrap: 'on',
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 },
      lineNumbersMinChars: 3, glyphMargin: false, folding: false,
    });
    diff.setModel({ original, modified });
    this.diff = { diff, original, modified };
  }

  repoPath(file) { return this.repo ? `${this.repo}/${file}` : file; }

  closeDiff() {
    if (this.diff) { this.diff.diff.dispose(); this.diff.original.dispose(); this.diff.modified.dispose(); this.diff = null; }
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
    this.refresh();
  }
}
