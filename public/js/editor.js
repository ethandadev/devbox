import { api, qs, h, icon, iconButton, key, menu, prompt, confirm, store, toast, copyText, sheet, splitPath } from './ui.js';

const SAVE_DELAY = 1000;     // autosave this long after you stop typing
const POLL_MS = 4000;        // check the open file for changes made on the Mac

let monacoPromise = null;
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/monaco/vs/loader.js';
    s.onerror = () => reject(new Error('Could not load the editor files from your Mac.'));
    s.onload = () => {
      // Absolute URL: Monaco's language workers (TypeScript, JSON, CSS, HTML)
      // load from inside a worker, where a relative path can't be resolved.
      const vs = new URL('/vendor/monaco/vs', location.href).href;
      window.MonacoEnvironment = { baseUrl: new URL('/vendor/monaco/', location.href).href };
      window.require.config({ paths: { vs } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (err) => reject(err));
    };
    document.head.append(s);
  });
  return monacoPromise;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|heic)$/i;
const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
const baseName = (p) => p.split('/').pop();

export class CodePane {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.files = new Map();       // path -> { model, mtime, savedVersion, saving, timer, conflict, viewState }
    this.order = store.get('code.tabs', []);
    this.active = null;
    this.workspace = ctx.project.get();
    ctx.project.onChange((p) => { this.workspace = p; if (this.el.classList.contains('drawer-open')) this.renderTree(); });
    this.expanded = new Set(store.get('code.expanded', []));
    this.showHidden = store.get('code.hidden', false);
    this.visible = false;

    // top bar: save state
    this.saveState = h('span', { class: 'save-state', 'aria-live': 'polite' });
    this.top = h('div', { dataset: { for: 'code' } }, this.saveState,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'File options', onclick: () => this.activeMenu() }, icon('more')));
    ctx.topActions.append(this.top);

    // head: explorer toggle + tabs
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.head = h('div', { class: 'code-head' }, iconButton('files', 'Files', () => this.toggleDrawer()), this.tabsEl,
      iconButton('search', 'Search files', () => this.searchSheet(), { class: 'end' }));

    // conflict banner
    this.banner = h('div', { class: 'banner', hidden: true });

    // editor area
    this.editorHost = h('div', { class: 'editor-host' });
    this.empty = h('div', { class: 'empty' },
      h('h2', {}, 'No file open'),
      h('p', {}, 'Open the file browser to pick a file, or create a new one.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.toggleDrawer(true) }, 'Browse files'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.createIn(this.workspace, 'file') }, 'New file')));
    this.loading = h('div', { class: 'empty' }, h('p', {}, 'Loading the editor…'));
    this.imageView = h('div', { class: 'image-view', hidden: true });
    this.wrap = h('div', { class: 'editor-wrap' }, this.editorHost, this.imageView, this.empty, this.loading);
    this.empty.hidden = true;

    // drawer
    this.crumbs = h('div', { class: 'crumbs' });
    this.tree = h('div', { class: 'tree', role: 'tree' });
    this.hiddenBtn = iconButton('eye', 'Show hidden files', () => this.toggleHidden(), { class: this.showHidden ? 'on' : '' });
    this.drawer = h('aside', { class: 'drawer', 'aria-label': 'Files' },
      h('div', { class: 'drawer-head' },
        h('div', { class: 'drawer-title' },
          h('strong', {}, 'Files'),
          iconButton('up', 'Parent folder', () => this.setWorkspace(parentOf(this.workspace))),
          iconButton('plus', 'New…', () => this.newMenu(this.workspace)),
          iconButton('upload', 'Upload from phone', () => this.uploadInput.click()),
          this.hiddenBtn,
          iconButton('refresh', 'Refresh', () => this.renderTree()),
          iconButton('x', 'Close', () => this.toggleDrawer(false))),
        this.crumbs),
      this.tree);
    this.scrim = h('div', { class: 'drawer-scrim', onclick: () => this.toggleDrawer(false) });
    this.uploadInput = h('input', { type: 'file', multiple: true, hidden: true });
    this.uploadInput.addEventListener('change', () => this.upload([...this.uploadInput.files]));
    el.append(this.uploadInput);

    el.append(this.head, this.banner, this.wrap, this.buildKeybar(), this.scrim, this.drawer);

    setInterval(() => this.poll(), POLL_MS);
    window.addEventListener('beforeunload', (e) => { if (this.anyDirty()) { this.flushAll(); e.preventDefault(); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushAll(); });
  }

  // ---------- lifecycle ----------
  preload() { this.ensureEditor().catch(() => {}); }

  async ensureEditor() {
    if (this.editor) return this.editor;
    if (this.editorPromise) return this.editorPromise;
    this.editorPromise = (async () => {
      let monaco;
      try { monaco = await loadMonaco(); }
      catch (e) {
        this.loading.replaceChildren(h('h2', {}, 'The editor didn\'t load'), h('p', {}, e.message || String(e)),
          h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Reload'));
        this.editorPromise = null; monacoPromise = null;
        throw e;
      }
      this.monaco = monaco;
      monaco.editor.defineTheme('devbox', {
        base: 'vs-dark', inherit: true, rules: [],
        colors: {
          'editor.background': '#0e1013',
          'editor.lineHighlightBackground': '#161a1f',
          'editorLineNumber.foreground': '#4a515b',
          'editorLineNumber.activeForeground': '#c9ced6',
          'editorCursor.foreground': '#f2b25c',
          'editor.selectionBackground': '#f2b25c40',
          'editorIndentGuide.background1': '#1f242b',
          'editorWidget.background': '#161a1f',
          'editorWidget.border': '#343a43',
          'input.background': '#0a0c0e',
          'focusBorder': '#f2b25c80',
          'scrollbarSlider.background': '#ffffff1a',
        },
      });
      const phone = window.matchMedia('(max-width: 700px)').matches;
      this.editor = monaco.editor.create(this.editorHost, {
        model: null,
        theme: 'devbox',
        fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
        fontSize: store.get('code.fontSize', phone ? 13 : 14),
        lineHeight: 1.55,
        minimap: { enabled: !phone },
        wordWrap: phone ? 'on' : 'off',
        lineNumbersMinChars: phone ? 3 : 4,
        glyphMargin: false,
        folding: !phone,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        automaticLayout: true,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active' },
        stickyScroll: { enabled: !phone },
        padding: { top: 8 },
        tabSize: 2,
      });
      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save(this.active, { now: true }));
      this.loading.hidden = true;
      await this.restoreTabs();
      return this.editor;
    })();
    return this.editorPromise;
  }

  async show() {
    this.visible = true;
    try { await this.ensureEditor(); } catch { return; }
    this.editor.layout();
    if (this.active) this.checkActive();
    else if (!this.order.length) this.toggleDrawer(true);
  }
  hide() { this.visible = false; this.toggleDrawer(false); this.flushAll(); }
  onResume() { if (this.visible && this.active) this.checkActive(); }

  // ---------- tabs ----------
  async restoreTabs() {
    const paths = this.order.slice();
    this.order = [];
    const want = store.get('code.active');
    for (const p of paths) {
      try { await this.open(p, { activate: false, quiet: true }); } catch {}
    }
    if (want && this.files.has(want)) this.activate(want);
    else if (this.order.length) this.activate(this.order[this.order.length - 1]);
    else this.renderTabs();
  }

  async open(path, { activate = true, quiet = false } = {}) {
    await this.ensureEditor();
    if (this.files.has(path)) { if (activate) this.activate(path); return; }
    if (IMAGE_EXT.test(path)) {
      this.files.set(path, { path, kind: 'image', mtime: 0 });
      if (!this.order.includes(path)) this.order.push(path);
      this.persistTabs();
      if (activate) this.activate(path); else this.renderTabs();
      return;
    }
    let data;
    try { data = await api('/api/fs/read?' + qs({ path })); }
    catch (e) {
      if (!quiet) {
        if (e.status === 415 || e.status === 413) this.cantOpen(path, e.message);
        else toast(e.message, 'bad');
      }
      throw e;
    }
    const uri = this.monaco.Uri.from({ scheme: 'file', path: '/' + path });
    const existing = this.monaco.editor.getModel(uri);
    if (existing) existing.dispose();
    const model = this.monaco.editor.createModel(data.content, this.languageFor(path), uri);
    const f = { path, model, mtime: data.mtime, savedVersion: model.getAlternativeVersionId(), timer: null, saving: false, conflict: null, viewState: null };
    model.onDidChangeContent(() => this.onEdit(f));
    this.files.set(path, f);
    if (!this.order.includes(path)) this.order.push(path);
    this.persistTabs();
    if (activate) this.activate(path);
    else this.renderTabs();
  }

  languageFor(path) {
    const name = baseName(path).toLowerCase();
    const langs = this.monaco.languages.getLanguages();
    for (const l of langs) if ((l.filenames || []).some((f) => f.toLowerCase() === name)) return l.id;
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    if (ext) for (const l of langs) if ((l.extensions || []).some((x) => x.toLowerCase() === ext)) return l.id;
    if (name === 'makefile') return 'shell';
    if (/^\.(zshrc|bashrc|zprofile|bash_profile|profile)$/.test(name)) return 'shell';
    if (name.startsWith('.env')) return 'ini';
    return 'plaintext';
  }

  activate(path) {
    const f = this.files.get(path);
    if (!f) return;
    const prev = this.active && this.files.get(this.active);
    if (prev && prev !== f && prev.model) prev.viewState = this.editor.saveViewState();
    this.active = path;
    store.set('code.active', path);
    if (f.kind === 'image') {
      this.editor.setModel(null);
      this.imageView.hidden = false;
      this.imageView.replaceChildren(h('img', { src: '/api/fs/raw?' + qs({ path, t: Date.now() }), alt: baseName(path) }), h('p', {}, path));
    } else {
      this.imageView.hidden = true;
      this.editor.setModel(f.model);
      if (f.viewState) this.editor.restoreViewState(f.viewState);
    }
    this.renderTabs();
    this.renderBanner();
    this.updateSaveState();
    this.empty.hidden = true;
    this.highlightTree();
    this.checkActive();
  }

  async close(path) {
    const f = this.files.get(path);
    if (!f) return;
    if (this.isDirty(f)) await this.save(path, { now: true });
    if (this.isDirty(f) && !(await confirm(`Close ${baseName(path)}?`, 'Your latest changes could not be saved to the Mac.', { ok: 'Close anyway', danger: true }))) return;
    clearTimeout(f.timer);
    if (f.model) f.model.dispose();
    this.files.delete(path);
    const i = this.order.indexOf(path);
    this.order.splice(i, 1);
    this.persistTabs();
    if (this.active === path) {
      this.active = null;
      const next = this.order[Math.min(i, this.order.length - 1)];
      if (next) this.activate(next);
      else { this.editor.setModel(null); this.imageView.hidden = true; this.renderTabs(); this.renderBanner(); this.updateSaveState(); this.empty.hidden = false; store.remove('code.active'); }
    } else this.renderTabs();
  }

  persistTabs() { store.set('code.tabs', this.order); }

  renderTabs() {
    this.tabsEl.replaceChildren(...this.order.map((p) => {
      const f = this.files.get(p);
      const t = h('div', { class: 'tab' + (p === this.active ? ' active' : '') + (f && this.isDirty(f) ? ' dirty' : ''), role: 'tab', title: p },
        h('span', { class: 'name', onclick: () => this.activate(p) }, baseName(p)),
        h('button', { class: 'close', type: 'button', 'aria-label': 'Close ' + baseName(p), onclick: (e) => { e.stopPropagation(); this.close(p); } }, icon('x')));
      t.addEventListener('click', () => this.activate(p));
      return t;
    }));
    const act = this.tabsEl.querySelector('.tab.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.empty.hidden = !!this.order.length || !this.editor;
  }

  // ---------- saving ----------
  isDirty(f) { return !!f.model && f.model.getAlternativeVersionId() !== f.savedVersion; }
  anyDirty() { for (const f of this.files.values()) if (this.isDirty(f)) return true; return false; }

  onEdit(f) {
    if (f.applyingRemote) return;
    clearTimeout(f.timer);
    if (!f.conflict) f.timer = setTimeout(() => this.save(f.path), SAVE_DELAY);
    this.renderTabs();
    this.updateSaveState();
  }

  async save(path, { now = false, force = false } = {}) {
    const f = this.files.get(path);
    if (!f || !f.model) return;
    clearTimeout(f.timer);
    if (f.saving) { f.again = true; return; }
    if (!this.isDirty(f) && !force) return;
    if (f.conflict && !force) return;
    f.saving = true;
    this.updateSaveState();
    const version = f.model.getAlternativeVersionId();
    try {
      const r = await api('/api/fs/write?' + qs({ path, baseMtime: f.mtime, ...(force ? { force: 1 } : {}) }), { method: 'PUT', body: f.model.getValue(), timeout: 20000 });
      f.mtime = r.mtime;
      f.savedVersion = version;
      f.conflict = null;
      f.error = null;
      window.dispatchEvent(new CustomEvent('devbox:saved', { detail: { path } }));
    } catch (e) {
      if (e.status === 409) { f.conflict = 'changed'; }
      else { f.error = e.message; f.timer = setTimeout(() => this.save(path), 4000); }
    } finally {
      f.saving = false;
      if (f.again) { f.again = false; if (this.isDirty(f) && !f.conflict) this.save(path); }
      this.renderTabs();
      this.updateSaveState();
      this.renderBanner();
    }
  }

  flushAll() { for (const f of this.files.values()) if (this.isDirty(f) && !f.conflict) this.save(f.path, { now: true }); }

  updateSaveState() {
    const f = this.active && this.files.get(this.active);
    let state = '', text = '';
    if (f && f.model) {
      if (f.conflict) { state = 'conflict'; text = 'Conflict'; }
      else if (f.saving) { state = 'saving'; text = 'Saving…'; }
      else if (f.error) { state = 'error'; text = 'Offline'; }
      else if (this.isDirty(f)) { state = 'dirty'; text = 'Edited'; }
      else { state = 'saved'; text = 'Saved'; }
    }
    this.saveState.dataset.state = state;
    this.saveState.textContent = text;
    this.saveState.title = f && f.error ? f.error : '';
  }

  renderBanner() {
    const f = this.active && this.files.get(this.active);
    if (!f || !f.conflict) { this.banner.hidden = true; return; }
    this.banner.hidden = false;
    this.banner.replaceChildren(
      h('span', { class: 'grow' }, h('b', {}, baseName(f.path)), ' was changed on your Mac while you were editing it.'),
      h('button', { class: 'btn', type: 'button', onclick: () => this.reloadFromDisk(f.path, { discard: true }) }, 'Use Mac version'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: () => this.save(f.path, { force: true }) }, 'Keep mine'));
  }

  // ---------- staying in sync with the Mac ----------
  async poll() {
    if (!this.visible || document.visibilityState !== 'visible' || !this.active) return;
    this.checkActive();
  }

  async checkActive() {
    const f = this.active && this.files.get(this.active);
    if (!f || !f.model || f.saving || f.checking) return;
    f.checking = true;
    try {
      const st = await api('/api/fs/stat?' + qs({ path: f.path }), { timeout: 8000 });
      if (Math.abs(st.mtime - f.mtime) > 1 && !f.saving) {
        if (this.isDirty(f)) { f.conflict = 'changed'; this.renderBanner(); this.updateSaveState(); }
        else await this.reloadFromDisk(f.path, {});
      }
    } catch (e) {
      if (e.status === 404 && !f.missing) { f.missing = true; toast(`${baseName(f.path)} no longer exists on the Mac. Saving will recreate it.`); f.mtime = 0; }
    } finally { f.checking = false; }
  }

  async reloadFromDisk(path, { discard = false }) {
    const f = this.files.get(path);
    if (!f) return;
    let data;
    try { data = await api('/api/fs/read?' + qs({ path })); } catch (e) { toast(e.message, 'bad'); return; }
    if (!discard && this.isDirty(f)) return;
    const view = this.active === path ? this.editor.saveViewState() : null;
    f.applyingRemote = true;
    // Replace through an edit so undo still works across the reload.
    f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: data.content }], () => null);
    f.applyingRemote = false;
    f.mtime = data.mtime;
    f.savedVersion = f.model.getAlternativeVersionId();
    f.conflict = null;
    if (view) this.editor.restoreViewState(view);
    this.renderTabs(); this.renderBanner(); this.updateSaveState();
    if (!discard) toast(`Reloaded ${baseName(path)} — it changed on your Mac`);
  }

  // ---------- accessory keys ----------
  buildKeybar() {
    const ed = (fn) => () => { if (this.editor) fn(this.editor); };
    const type = (text) => ed((e) => e.trigger('keyboard', 'type', { text }));
    this.keybarEl = h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Editor keys' },
      key(icon('save'), () => this.save(this.active, { now: true }), { cls: 'mod', title: 'Save now' }),
      key(icon('undo'), ed((e) => e.trigger('keys', 'undo', null)), { cls: 'mod', title: 'Undo', repeat: true }),
      key(icon('redo'), ed((e) => e.trigger('keys', 'redo', null)), { cls: 'mod', title: 'Redo', repeat: true }),
      key(icon('search'), ed((e) => e.getAction('actions.find').run()), { cls: 'mod', title: 'Find' }),
      h('span', { class: 'sep' }),
      key('tab', ed((e) => e.trigger('keys', 'tab', null)), { cls: 'mod' }),
      key('⇤', ed((e) => e.trigger('keys', 'outdent', null)), { cls: 'mod', title: 'Outdent' }),
      key('←', ed((e) => e.trigger('keys', 'cursorLeft', null)), { repeat: true, title: 'Left' }),
      key('→', ed((e) => e.trigger('keys', 'cursorRight', null)), { repeat: true, title: 'Right' }),
      key('↑', ed((e) => e.trigger('keys', 'cursorUp', null)), { repeat: true, title: 'Up' }),
      key('↓', ed((e) => e.trigger('keys', 'cursorDown', null)), { repeat: true, title: 'Down' }),
      h('span', { class: 'sep' }),
      ...['{', '}', '(', ')', '[', ']', '<', '>', '=', ';', ':', '"', "'", '`', '/', '\\', '|', '&', '!', '?', '_', '-', '+', '*', '#', '$', '%', '@'].map((c) => key(c, type(c))),
    );
    return this.keybarEl;
  }

  // ---------- file browser ----------
  toggleDrawer(open) {
    const on = open === undefined ? !this.el.classList.contains('drawer-open') : open;
    this.el.classList.toggle('drawer-open', on);
    if (on) this.renderTree();
  }

  setWorkspace(path) {
    this.workspace = path || '';
    this.ctx.project.set(this.workspace);
    this.renderTree();
  }

  toggleHidden() {
    this.showHidden = !this.showHidden;
    store.set('code.hidden', this.showHidden);
    this.hiddenBtn.classList.toggle('on', this.showHidden);
    this.renderTree();
  }

  renderCrumbs() {
    const root = this.ctx.status.rootName || '~';
    const parts = this.workspace ? this.workspace.split('/') : [];
    const items = [h('button', { type: 'button', onclick: () => this.setWorkspace('') }, root)];
    parts.forEach((p, i) => {
      items.push(h('span', { class: 'slash' }, '/'));
      items.push(h('button', { type: 'button', onclick: () => this.setWorkspace(parts.slice(0, i + 1).join('/')) }, p));
    });
    this.crumbs.replaceChildren(...items);
  }

  async renderTree() {
    this.renderCrumbs();
    const frag = document.createDocumentFragment();
    await this.renderDir(this.workspace, 0, frag);
    this.tree.replaceChildren(frag);
    this.highlightTree();
  }

  async renderDir(dir, depth, into) {
    let data;
    try { data = await api('/api/fs/list?' + qs({ path: dir })); }
    catch (e) { into.append(h('div', { class: 'tree-msg', style: `padding-left:${34 + depth * 14}px` }, e.message)); return; }
    const entries = data.entries.filter((e) => this.showHidden || !e.hidden);
    if (!entries.length) into.append(h('div', { class: 'tree-msg', style: `padding-left:${34 + depth * 14}px` }, 'Empty folder'));
    for (const e of entries) {
      const path = join(dir, e.name);
      const isDir = e.type === 'dir';
      const open = isDir && this.expanded.has(path);
      const row = h('div', { class: `node ${isDir ? 'dir' : 'file'}${open ? ' open' : ''}${e.hidden ? ' hidden-file' : ''}`, role: 'treeitem', dataset: { path }, style: `padding-left:${4 + depth * 14}px` },
        h('span', { class: 'twisty' }, isDir ? icon('chevron') : null),
        h('button', { class: 'label', type: 'button' }, e.name),
        h('button', { class: 'more', type: 'button', 'aria-label': `Options for ${e.name}` }, icon('more')));
      row.querySelector('.label').addEventListener('click', () => (isDir ? this.toggleFolder(path, row, depth) : this.pick(path)));
      row.querySelector('.twisty').addEventListener('click', () => isDir && this.toggleFolder(path, row, depth));
      row.querySelector('.more').addEventListener('click', () => this.entryMenu(path, isDir));
      into.append(row);
      if (open) {
        const kids = h('div', { dataset: { children: path } });
        await this.renderDir(path, depth + 1, kids);
        into.append(kids);
      }
    }
  }

  async toggleFolder(path, row, depth) {
    const kids = this.tree.querySelector(`[data-children="${CSS.escape(path)}"]`);
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      row.classList.remove('open');
      if (kids) kids.remove();
    } else {
      this.expanded.add(path);
      row.classList.add('open');
      const box = h('div', { dataset: { children: path } });
      row.after(box);
      await this.renderDir(path, depth + 1, box);
      this.highlightTree();
    }
    store.set('code.expanded', [...this.expanded].slice(-200));
  }

  highlightTree() {
    this.tree.querySelectorAll('.node.current').forEach((n) => n.classList.remove('current'));
    if (!this.active) return;
    const n = this.tree.querySelector(`.node[data-path="${CSS.escape(this.active)}"]`);
    if (n) n.classList.add('current');
  }

  async pick(path) {
    try { await this.open(path); } catch { return; }
    if (!window.matchMedia('(min-width: 900px)').matches) this.toggleDrawer(false);
  }

  async newMenu(dir) {
    const choice = await menu(`New in ${dir || this.ctx.status.rootName || '~'}`, [
      { label: 'New file', value: 'file', icon: 'plus' },
      { label: 'New folder', value: 'dir', icon: 'files' },
    ]);
    if (choice) this.createIn(dir, choice);
  }

  async createIn(dir, type) {
    const name = await prompt(type === 'dir' ? 'New folder' : 'New file', { placeholder: type === 'dir' ? 'folder-name' : 'name.ext', ok: 'Create' });
    if (!name) return;
    const path = join(dir, name);
    try { await api('/api/fs/create', { method: 'POST', json: { path, type } }); }
    catch (e) { toast(e.message, 'bad'); return; }
    if (dir) { this.expanded.add(dir); store.set('code.expanded', [...this.expanded]); }
    await this.renderTree();
    if (type === 'file') this.pick(path);
  }

  async entryMenu(path, isDir) {
    const choice = await menu(baseName(path), [
      isDir ? { label: 'Open this folder', value: 'workspace', icon: 'files', sub: 'show only this' } : { label: 'Open', value: 'open', icon: 'files' },
      isDir ? { label: 'New file here', value: 'newfile', icon: 'plus' } : null,
      isDir ? { label: 'New folder here', value: 'newdir', icon: 'plus' } : null,
      { label: 'Open in terminal', value: 'terminal', icon: 'keyboard', sub: isDir ? 'cd here' : 'cd to its folder' },
      { label: 'Rename', value: 'rename', icon: 'text' },
      { label: 'Copy path', value: 'copy', icon: 'copy' },
      isDir ? { label: 'Upload from phone here', value: 'upload', icon: 'upload' } : { label: 'Download to phone', value: 'download', icon: 'download' },
      { label: 'Move to Trash', value: 'delete', icon: 'x', danger: true },
    ]);
    if (!choice) return;
    const abs = this.ctx.status.root.replace(/\/$/, '') + '/' + path;
    if (choice === 'open') this.pick(path);
    else if (choice === 'workspace') this.setWorkspace(path);
    else if (choice === 'newfile') this.createIn(path, 'file');
    else if (choice === 'newdir') this.createIn(path, 'dir');
    else if (choice === 'copy') copyText(abs);
    else if (choice === 'download') this.download(path);
    else if (choice === 'upload') { this.uploadTarget = path; this.uploadInput.click(); }
    else if (choice === 'terminal') {
      const dir = isDir ? abs : abs.split('/').slice(0, -1).join('/');
      this.ctx.switchTab('term');
      this.ctx.panes().term.runCommand(`cd '${dir.replace(/'/g, "'\\''")}'`);
    } else if (choice === 'rename') this.rename(path);
    else if (choice === 'delete') this.remove(path, isDir);
  }

  async rename(path) {
    const name = await prompt('Rename', { value: baseName(path), ok: 'Rename', selectStem: true });
    if (!name || name === baseName(path)) return;
    const to = join(parentOf(path), name);
    try { await api('/api/fs/rename', { method: 'POST', json: { from: path, to } }); }
    catch (e) { toast(e.message, 'bad'); return; }
    // Re-point any open tabs inside the renamed item.
    for (const p of [...this.order]) {
      if (p === path || p.startsWith(path + '/')) {
        const wasActive = this.active === p;
        const f = this.files.get(p);
        const dirty = f && this.isDirty(f);
        if (dirty) await this.save(p, { now: true });
        await this.close(p);
        await this.open(to + p.slice(path.length), { activate: wasActive, quiet: true }).catch(() => {});
      }
    }
    this.renderTree();
  }

  async remove(path, isDir) {
    const ok = await confirm(`Move ${baseName(path)} to the Trash?`, isDir ? 'The folder and everything in it will go to the Trash on your Mac.' : 'You can restore it from the Trash on your Mac.', { ok: 'Move to Trash', danger: true });
    if (!ok) return;
    try { await api('/api/fs/delete', { method: 'POST', json: { path } }); }
    catch (e) { toast(e.message, 'bad'); return; }
    for (const p of [...this.order]) {
      if (p === path || p.startsWith(path + '/')) {
        const f = this.files.get(p);
        if (f) f.savedVersion = f.model.getAlternativeVersionId();   // nothing to save
        await this.close(p);
      }
    }
    toast('Moved to Trash');
    this.renderTree();
  }

  async activeMenu() {
    const f = this.active && this.files.get(this.active);
    const size = this.editor ? this.editor.getOption(this.monaco.editor.EditorOption.fontSize) : 13;
    const wrap = this.editor ? this.editor.getOption(this.monaco.editor.EditorOption.wordWrap) : 'on';
    const text = f && f.model;
    const choice = await menu(f ? baseName(f.path) : 'Editor', [
      text ? { label: 'All commands…', value: 'palette', icon: 'command', sub: 'like ⇧⌘P' } : null,
      text ? { label: 'Format document', value: 'format', icon: 'text' } : null,
      text ? { label: 'Go to line…', value: 'goto', icon: 'down' } : null,
      text ? { label: 'Find and replace', value: 'replace', icon: 'search' } : null,
      { label: 'Search in project', value: 'search', icon: 'search' },
      text ? { label: 'Save now', value: 'save', icon: 'save' } : null,
      text ? { label: 'Reload from Mac', value: 'reload', icon: 'refresh' } : null,
      f ? { label: 'Download to phone', value: 'download', icon: 'download' } : null,
      { label: wrap === 'off' ? 'Turn on word wrap' : 'Turn off word wrap', value: 'wrap', icon: 'text' },
      { label: 'Larger text', value: 'bigger', icon: 'text', sub: `${size}px` },
      { label: 'Smaller text', value: 'smaller', icon: 'text' },
      f ? { label: 'Close file', value: 'close', icon: 'x' } : null,
    ]);
    if (!choice) return;
    if (choice === 'palette') { this.editor.focus(); this.editor.trigger('menu', 'editor.action.quickCommand', null); }
    else if (choice === 'format') {
      const action = this.editor.getAction('editor.action.formatDocument');
      if (action && action.isSupported()) { await action.run(); toast('Formatted'); }
      else toast('No formatter for this kind of file. Try your project\'s formatter in the terminal.');
    } else if (choice === 'goto') {
      const n = await prompt('Go to line', { placeholder: `1 – ${f.model.getLineCount()}`, ok: 'Go' });
      const line = parseInt(n, 10);
      if (line) this.reveal(f.path, line, 1);
    } else if (choice === 'replace') { this.editor.focus(); this.editor.getAction('editor.action.startFindReplaceAction').run(); }
    else if (choice === 'search') this.searchSheet('text');
    else if (choice === 'download') this.download(f.path);
    else if (choice === 'save') this.save(f.path, { now: true, force: false });
    else if (choice === 'reload') {
      if (this.isDirty(f) && !(await confirm('Discard your unsaved changes?', 'This loads the version saved on your Mac.', { ok: 'Discard', danger: true }))) return;
      this.reloadFromDisk(f.path, { discard: true });
    } else if (choice === 'wrap') this.editor.updateOptions({ wordWrap: wrap === 'off' ? 'on' : 'off' });
    else if (choice === 'bigger' || choice === 'smaller') {
      const n = Math.max(10, Math.min(24, size + (choice === 'bigger' ? 1 : -1)));
      store.set('code.fontSize', n);
      this.editor.updateOptions({ fontSize: n });
    } else if (choice === 'close') this.close(f.path);
  }

  // ---------- search & quick open ----------
  async reveal(path, line, column = 1) {
    try { await this.open(path); } catch { return; }
    const f = this.files.get(path);
    if (!f || !f.model) return;
    const ln = Math.min(Math.max(1, line), f.model.getLineCount());
    this.editor.setSelection({ startLineNumber: ln, startColumn: column, endLineNumber: ln, endColumn: column });
    this.editor.revealLineInCenter(ln);
  }

  searchSheet(mode = store.get('code.searchMode', 'files')) {
    const scope = this.workspace;
    const scopeName = scope ? scope.split('/').pop() : (this.ctx.status.rootName || '~');
    let caseSensitive = false, regex = false, timer = null, seq = 0;
    return sheet((panel, done) => {
      panel.classList.add('sheet-tall');
      const input = h('input', { class: 'input mono', type: 'search', placeholder: '', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'data-select': 'no' });
      const results = h('div', { class: 'results' });
      const info = h('p', { class: 'results-info' });
      const segFiles = h('button', { type: 'button' }, 'Files');
      const segText = h('button', { type: 'button' }, 'Text in files');
      const caseBtn = h('button', { class: 'key mod toggle', type: 'button', title: 'Match case' }, 'Aa');
      const reBtn = h('button', { class: 'key mod toggle', type: 'button', title: 'Regular expression' }, '.*');
      const opts = h('div', { class: 'search-opts' }, caseBtn, reBtn);
      const setMode = (m) => {
        mode = m; store.set('code.searchMode', m);
        segFiles.classList.toggle('on', m === 'files'); segText.classList.toggle('on', m === 'text');
        opts.hidden = m !== 'text';
        input.placeholder = m === 'files' ? `Find a file in ${scopeName}` : `Search text in ${scopeName}`;
        run(); input.focus();
      };
      segFiles.onclick = () => setMode('files');
      segText.onclick = () => setMode('text');
      caseBtn.onclick = () => { caseSensitive = !caseSensitive; caseBtn.classList.toggle('on', caseSensitive); run(); };
      reBtn.onclick = () => { regex = !regex; reBtn.classList.toggle('on', regex); run(); };

      const pick = (path, line, col) => { done(null); if (line) this.reveal(path, line, col); else this.pick(path); };

      const run = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value;
          const my = ++seq;
          if (mode === 'text' && q.length < 2) { results.replaceChildren(); info.textContent = 'Type at least 2 characters.'; return; }
          info.textContent = 'Searching…';
          try {
            if (mode === 'files') {
              const r = await api('/api/search/files?' + qs({ path: scope, q }));
              if (my !== seq) return;
              info.textContent = r.results.length ? (q ? `${r.results.length === 60 ? 'Top 60' : r.results.length} of ${r.total} files` : `${r.total} files · type to filter`) : `No files match “${q}”.`;
              results.replaceChildren(...r.results.map((x) => {
                const [dir, name] = splitPath(x.rel);
                return h('button', { class: 'result', type: 'button', onclick: () => pick(x.path) }, h('span', { class: 'r-name' }, name), h('span', { class: 'r-dir' }, dir));
              }));
            } else {
              const r = await api('/api/search/text?' + qs({ path: scope, q, case: caseSensitive ? 1 : 0, regex: regex ? 1 : 0 }), { timeout: 30000 });
              if (my !== seq) return;
              const byFile = new Map();
              for (const m of r.results) { if (!byFile.has(m.path)) byFile.set(m.path, []); byFile.get(m.path).push(m); }
              info.textContent = r.results.length ? `${r.results.length}${r.truncated ? '+' : ''} ${r.results.length === 1 ? 'match' : 'matches'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}` : `No matches for “${q}”.`;
              const nodes = [];
              for (const [path, hits] of byFile) {
                const rel = scope ? path.slice(scope.length + 1) : path;
                nodes.push(h('div', { class: 'result-file' }, rel));
                for (const m of hits) {
                  nodes.push(h('button', { class: 'result hit', type: 'button', onclick: () => pick(m.path, m.line, m.column) },
                    h('span', { class: 'r-line' }, String(m.line)), h('span', { class: 'r-text' }, highlight(m.text.trim(), q, regex, caseSensitive))));
                }
              }
              results.replaceChildren(...nodes);
            }
          } catch (e) { if (my === seq) info.textContent = e.message; }
        }, mode === 'files' ? 90 : 260);
      };
      input.addEventListener('input', run);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = results.querySelector('.result'); if (first) first.click(); } });
      panel.append(h('div', { class: 'seg' }, segFiles, segText), h('div', { class: 'search-row' }, input, opts), info, results);
      setMode(mode);
    });
  }

  // ---------- files between phone and Mac ----------
  download(path) {
    const a = h('a', { href: '/api/fs/raw?' + qs({ path, download: 1 }), download: baseName(path) });
    document.body.append(a); a.click(); a.remove();
  }

  async upload(fileList) {
    const dir = this.uploadTarget !== undefined ? this.uploadTarget : this.workspace;
    this.uploadTarget = undefined;
    this.uploadInput.value = '';
    if (!fileList.length) return;
    let done = 0;
    for (const file of fileList) {
      toast(`Uploading ${file.name}…`);
      try {
        await fetch('/api/fs/upload?' + qs({ dir, name: file.name }), { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } })
          .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Upload failed (${r.status})`); });
        done++;
      } catch (e) { toast(`${file.name}: ${e.message}`, 'bad'); }
    }
    if (done) toast(`Uploaded ${done} file${done === 1 ? '' : 's'} to ${dir || this.ctx.status.rootName || '~'}`, 'ok');
    if (dir) { this.expanded.add(dir); }
    this.renderTree();
  }

  cantOpen(path, message) {
    sheet((panel, close) => {
      panel.append(h('h3', {}, baseName(path)), h('p', {}, message),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'OK'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { close(null); this.download(path); } }, 'Download to phone')));
    });
  }
}

function highlight(text, q, regex, caseSensitive) {
  const frag = document.createDocumentFragment();
  let re;
  try { re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi'); } catch { frag.append(text); return frag; }
  let last = 0, m, guard = 0;
  while ((m = re.exec(text)) && guard++ < 50) {
    if (!m[0]) { re.lastIndex++; continue; }
    frag.append(text.slice(last, m.index), h('mark', {}, m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}
