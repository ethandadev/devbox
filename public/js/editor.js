import { api, qs, h, icon, iconButton, key, menu, prompt, confirm, store, toast, copyText, sheet, splitPath, fileIcon } from './ui.js';
import { Smarts, SEMANTIC_THEME_RULES } from './smarts.js';

const SAVE_DELAY = 1000;     // autosave this long after you stop typing
const POLL_MS = 4000;        // check the open file for changes made on the Mac

let monacoPromise = null;
// The editor is the biggest part of devbox (~4 MB, ~1 MB compressed). On a
// slow or relayed Tailscale link a download can drop, and Monaco's loader
// can't recover from a failed file. So: fetch the big files first, with
// retries, into the browser cache (served with a 30-day cache header), then
// let the loader pick them up from the cache.
const MONACO_CORE = ['vs/loader.js', 'vs/editor/editor.main.js', 'vs/editor/editor.main.css'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prefetch(path, onProgress) {
  const url = '/vendor/monaco/' + path;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      const res = await fetch(url, { cache: 'force-cache', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
      clearTimeout(timer);
      onProgress && onProgress();
      return;
    } catch (e) {
      lastError = e.name === 'AbortError' ? new Error('timed out') : e;
      await sleep(700 * attempt);
    }
  }
  throw new Error(`Couldn't download the editor (${path.split('/').pop()}: ${lastError.message}). The connection to your Mac may be slow or dropping.`);
}

function describeLoadError(err) {
  if (!err) return 'Unknown error.';
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const src = err.target && (err.target.src || err.target.href);
    return `Couldn't load ${src ? new URL(src).pathname.split('/').pop() : 'an editor file'} from your Mac. The connection may have dropped.`;
  }
  if (err.moduleId) return `Couldn't load editor part ${err.moduleId}${err.message ? `: ${err.message}` : ''}.`;
  return err.message || String(err);
}

export function loadMonaco(onProgress) {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    let done = 0;
    await Promise.all(MONACO_CORE.map((p) => prefetch(p, () => onProgress && onProgress(++done, MONACO_CORE.length))));
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/monaco/vs/loader.js';
      s.onerror = (e) => reject(e);
      s.onload = resolve;
      document.head.append(s);
    });
    // Absolute URL: Monaco's language workers (TypeScript, JSON, CSS, HTML)
    // load from inside a worker, where a relative path can't be resolved.
    const vs = new URL('/vendor/monaco/vs', location.href).href;
    window.MonacoEnvironment = { baseUrl: new URL('/vendor/monaco/', location.href).href };
    window.require.config({ paths: { vs } });
    return new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject));
  })().catch((err) => {
    monacoPromise = null;
    throw new Error(describeLoadError(err));
  });
  return monacoPromise;
}

// How to run a file, by type. Gets the file name (run from its folder).
const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const RUNNERS = [
  [/\.py$/i, (f) => `python3 ${q(f)}`],
  [/\.(js|mjs|cjs)$/i, (f) => `node ${q(f)}`],
  [/\.tsx?$/i, (f) => `npx --yes tsx ${q(f)}`],
  [/\.(sh|bash)$/i, (f) => `bash ${q(f)}`],
  [/\.zsh$/i, (f) => `zsh ${q(f)}`],
  [/\.rb$/i, (f) => `ruby ${q(f)}`],
  [/\.go$/i, (f) => `go run ${q(f)}`],
  [/\.rs$/i, (f) => `if [ -f Cargo.toml ] || [ -f ../Cargo.toml ]; then cargo run; else rustc ${q(f)} -o /tmp/devbox-run && /tmp/devbox-run; fi`],
  [/\.c$/i, (f) => `cc -O0 -g -Wall ${q(f)} -o /tmp/devbox-run && /tmp/devbox-run`],
  [/\.(cpp|cc|cxx|c\+\+)$/i, (f) => `c++ -std=c++20 -O0 -g -Wall ${q(f)} -o /tmp/devbox-run && /tmp/devbox-run`],
  [/\.m$/i, (f) => `clang -fobjc-arc -framework Foundation ${q(f)} -o /tmp/devbox-run && /tmp/devbox-run`],
  [/\.swift$/i, (f) => `swift ${q(f)}`],
  [/\.java$/i, (f) => `java ${q(f)}`],
  [/\.kts?$/i, (f) => `kotlinc -script ${q(f)}`],
  [/\.php$/i, (f) => `php ${q(f)}`],
  [/\.lua$/i, (f) => `lua ${q(f)}`],
  [/\.pl$/i, (f) => `perl ${q(f)}`],
  [/\.r$/i, (f) => `Rscript ${q(f)}`],
  [/\.dart$/i, (f) => `dart run ${q(f)}`],
  [/\.zig$/i, (f) => `zig run ${q(f)}`],
  [/\.ex(s)?$/i, (f) => `elixir ${q(f)}`],
  [/\.(cs)$/i, (f) => `dotnet run`],
  [/^makefile$/i, () => 'make'],
  [/\.html?$/i, null],
];
export function runCommandFor(path) {
  const name = path.split('/').pop();
  for (const [re, fn] of RUNNERS) if (re.test(name)) return fn;
  return null;
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
    this.dirCache = new Map();   // folder path -> { entries, sig }
    this.visible = false;

    // top bar: save state
    this.saveState = h('span', { class: 'save-state', 'aria-live': 'polite' });
    this.top = h('div', { dataset: { for: 'code' } }, this.saveState,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'File options', onclick: () => this.activeMenu() }, icon('more')));
    ctx.topActions.append(this.top);

    // head: explorer toggle + tabs
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.head = h('div', { class: 'code-head' }, iconButton('files', 'Files', () => this.toggleDrawer()), this.tabsEl,
      this.runBtn = iconButton('play', 'Run this file', () => this.runFile(), { class: 'end run-btn' }),
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
    // VS Code-style status bar: language, cursor position, indentation, branch.
    this.sbLang = h('button', { class: 'sb-item', type: 'button', onclick: () => this.languageMenu() });
    this.sbPos = h('button', { class: 'sb-item', type: 'button', onclick: () => this.gotoLine() });
    this.sbIndent = h('span', { class: 'sb-item' });
    this.sbBranch = h('button', { class: 'sb-item sb-branch', type: 'button', onclick: () => ctx.switchTab('git') });
    this.sbProblems = h('button', { class: 'sb-item sb-problems', type: 'button', onclick: () => this.problemsSheet() });
    this.sbSmarts = h('button', { class: 'sb-item sb-smarts', type: 'button', onclick: () => this.smartsSheet() });
    this.statusBar = h('div', { class: 'status-bar', hidden: true }, this.sbBranch, this.sbProblems, h('span', { class: 'sb-gap' }), this.sbPos, this.sbIndent, this.sbSmarts, this.sbLang);

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

    el.append(this.head, this.banner, this.wrap, this.statusBar, this.buildKeybar(), this.scrim, this.drawer);
    ctx.project.onChange(() => this.updateTitle());
    window.addEventListener('devbox:git', (e) => { this.branch = e.detail && e.detail.branch; this.updateStatusBar(); });

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
      const msg = h('p', {}, 'Loading the editor…');
      this.loading.replaceChildren(msg);
      this.loading.hidden = false;
      try {
        monaco = await loadMonaco((n, total) => { msg.textContent = n < total ? `Downloading the editor from your Mac (${n}/${total})…` : 'Starting the editor…'; });
      } catch (e) {
        // The loader can't retry a failed file in place, so "Try again"
        // reloads the page. Terminal sessions keep running on the Mac.
        const retry = window.require && window.require.config ? () => location.reload() : () => { this.editorPromise = null; this.ensureEditor().catch(() => {}); };
        this.loading.replaceChildren(h('h2', {}, 'The editor didn\'t load'), h('p', {}, e.message),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: retry }, 'Try again'));
        this.editorPromise = null;
        throw e;
      }
      this.monaco = monaco;
      monaco.editor.defineTheme('devbox', {
        base: 'vs-dark', inherit: true, rules: SEMANTIC_THEME_RULES,
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
        minimap: { enabled: store.get('code.minimap', !phone) },
        wordWrap: store.get('code.wrap', phone) ? 'on' : 'off',
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
        'semanticHighlighting.enabled': true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggest: { showWords: true, preview: true },
        inlayHints: { enabled: 'off' },
      });
      this.smarts = new Smarts(monaco, this);
      this.smarts.onChange(() => this.updateStatusBar());
      monaco.editor.onDidChangeMarkers(() => this.updateStatusBar());
      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save(this.active, { now: true }));
      // iOS autocorrect / predictive text inserts duplicated words in code.
      const ta = this.editorHost.querySelector('textarea');
      if (ta) for (const [k, v] of Object.entries({ autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' })) ta.setAttribute(k, v);
      this.editor.onDidChangeCursorPosition(() => this.updateStatusBar());
      this.editor.onDidChangeModel(() => this.updateStatusBar());
      this.loading.hidden = true;
      this.updateTitle();
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
    if (this.smarts) this.smarts.attach(model, path);
    this.remember(path);
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
    this.updateStatusBar();
    this.checkActive();
  }

  async close(path) {
    const f = this.files.get(path);
    if (!f) return;
    if (this.isDirty(f)) await this.save(path, { now: true });
    if (this.isDirty(f) && !(await confirm(`Close ${baseName(path)}?`, 'Your latest changes could not be saved to the Mac.', { ok: 'Close anyway', danger: true }))) return;
    clearTimeout(f.timer);
    if (f.model) { if (this.smarts) this.smarts.detach(f.model); f.model.dispose(); }
    this.files.delete(path);
    const i = this.order.indexOf(path);
    this.order.splice(i, 1);
    this.persistTabs();
    if (this.active === path) {
      this.active = null;
      const next = this.order[Math.min(i, this.order.length - 1)];
      if (next) this.activate(next);
      else { this.editor.setModel(null); this.imageView.hidden = true; this.renderTabs(); this.renderBanner(); this.updateSaveState(); this.updateStatusBar(); this.empty.hidden = false; store.remove('code.active'); }
    } else this.renderTabs();
  }

  persistTabs() { store.set('code.tabs', this.order); }

  updateTitle() {
    const f = this.active && this.files.get(this.active);
    const projectName = this.ctx.project.get().split('/').pop() || this.ctx.status.rootName || '~';
    if (!f) { this.ctx.setTitle('code', { title: projectName === '~' ? 'Code' : projectName, sub: 'No file open', onClick: () => this.toggleDrawer(true) }); return; }
    const [dir] = splitPath(f.path);
    const proj = this.ctx.project.get();
    const relDir = proj && (dir === proj || dir.startsWith(proj + '/')) ? dir.slice(proj.length).replace(/^\//, '') : dir;
    this.ctx.setTitle('code', { title: baseName(f.path), sub: relDir ? `${projectName} / ${relDir}` : projectName, onClick: () => this.toggleDrawer(true), dirty: this.isDirty(f) });
  }

  updateStatusBar() {
    const f = this.active && this.files.get(this.active);
    const show = !!(f && f.model && this.editor);
    this.statusBar.hidden = !show;
    if (!show) return;
    const pos = this.editor.getPosition();
    const sel = this.editor.getSelection();
    const selLen = sel && !sel.isEmpty() ? f.model.getValueInRange(sel).length : 0;
    this.sbPos.textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${selLen ? ` (${selLen} selected)` : ''}` : '';
    const o = f.model.getOptions();
    this.sbIndent.textContent = o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab: ${o.tabSize}`;
    const lang = this.monaco.languages.getLanguages().find((l) => l.id === f.model.getLanguageId());
    this.sbLang.textContent = (lang && lang.aliases && lang.aliases[0]) || f.model.getLanguageId();
    // Problems (errors / warnings) in this file.
    const markers = this.monaco.editor.getModelMarkers({ resource: f.model.uri });
    const errs = markers.filter((m) => m.severity === this.monaco.MarkerSeverity.Error).length;
    const warns = markers.filter((m) => m.severity === this.monaco.MarkerSeverity.Warning).length;
    this.sbProblems.replaceChildren(h('span', { class: errs ? 'sb-err' : '' }, `⊗ ${errs}`), h('span', { class: warns ? 'sb-warn' : '' }, `⚠ ${warns}`));
    // Language server status.
    const st = this.smarts && this.smarts.status(f.model);
    this.sbSmarts.hidden = !st;
    if (st) {
      const name = st.server ? st.server.name : 'smarts';
      const label = st.state === 'ready' ? `● ${name}` : st.state === 'starting' ? `○ ${name}…` : st.state === 'missing' ? '○ Basic' : `○ ${name} off`;
      this.sbSmarts.textContent = label;
      this.sbSmarts.className = `sb-item sb-smarts state-${st.state}`;
    }
    this.runBtn.classList.toggle('dim', !runCommandFor(f.path));
    this.sbBranch.hidden = !this.branch;
    this.sbBranch.replaceChildren(icon('branch'), h('span', {}, this.branch || ''));
  }

  async languageMenu() {
    const f = this.active && this.files.get(this.active);
    if (!f || !f.model) return;
    const common = ['plaintext', 'javascript', 'typescript', 'python', 'html', 'css', 'json', 'markdown', 'shell', 'yaml', 'go', 'rust', 'java', 'cpp', 'swift', 'ruby', 'php', 'sql', 'xml', 'dockerfile'];
    const langs = this.monaco.languages.getLanguages().filter((l) => common.includes(l.id)).sort((a, b) => common.indexOf(a.id) - common.indexOf(b.id));
    const cur = f.model.getLanguageId();
    const choice = await menu('Language', langs.map((l) => ({ label: (l.aliases && l.aliases[0]) || l.id, value: l.id, current: l.id === cur })));
    if (choice) { this.monaco.editor.setModelLanguage(f.model, choice); this.updateStatusBar(); }
  }

  async gotoLine() {
    const f = this.active && this.files.get(this.active);
    if (!f || !f.model) return;
    const n = await prompt('Go to line', { placeholder: `1 – ${f.model.getLineCount()}`, ok: 'Go' });
    const line = parseInt(n, 10);
    if (line) this.reveal(f.path, line, 1);
  }

  // Settings screen hooks
  getFontSize() { return store.get('code.fontSize', window.matchMedia('(max-width: 700px)').matches ? 13 : 14); }
  setFontSize(n) { store.set('code.fontSize', n); if (this.editor) this.editor.updateOptions({ fontSize: n }); }
  getWordWrap() { return store.get('code.wrap', window.matchMedia('(max-width: 700px)').matches); }
  setWordWrap(on) { store.set('code.wrap', on); if (this.editor) this.editor.updateOptions({ wordWrap: on ? 'on' : 'off' }); }
  getMinimap() { return store.get('code.minimap', !window.matchMedia('(max-width: 700px)').matches); }
  setMinimap(on) { store.set('code.minimap', on); if (this.editor) this.editor.updateOptions({ minimap: { enabled: on } }); }

  renderTabs() {
    this.tabsEl.replaceChildren(...this.order.map((p) => {
      const f = this.files.get(p);
      const t = h('div', { class: 'tab' + (p === this.active ? ' active' : '') + (f && this.isDirty(f) ? ' dirty' : ''), role: 'tab', title: p },
        fileIcon(baseName(p)),
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
    if (store.get('code.formatOnSave', false) && !force && this.active === path && !f.formatting) {
      const action = this.editor.getAction('editor.action.formatDocument');
      if (action && action.isSupported()) {
        f.formatting = true;
        try { await action.run(); } catch {}
        f.formatting = false;
      }
    }
    const version = f.model.getAlternativeVersionId();
    try {
      const r = await api('/api/fs/write?' + qs({ path, baseMtime: f.mtime, ...(force ? { force: 1 } : {}) }), { method: 'PUT', body: f.model.getValue(), timeout: 20000 });
      f.mtime = r.mtime;
      f.savedVersion = version;
      f.conflict = null;
      f.error = null;
      window.dispatchEvent(new CustomEvent('devbox:saved', { detail: { path } }));
      if (this.smarts) this.smarts.saved(path);
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
    this.updateTitle();
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
      key('//', ed((e) => e.getAction('editor.action.commentLine').run()), { cls: 'mod', title: 'Toggle comment' }),
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

  // ---------- file tree (instant from cache, refreshed in the background) ----------
  cacheDir(path, entries) {
    const prev = this.dirCache.get(path);
    const sig = JSON.stringify(entries);
    this.dirCache.set(path, { entries, sig });
    return !prev || prev.sig !== sig;
  }

  async fetchDir(dir) {
    const data = await api('/api/fs/list?' + qs({ path: dir, ahead: 1 }));
    const changed = this.cacheDir(dir, data.entries);
    for (const [p, entries] of Object.entries(data.ahead || {})) if (!this.dirCache.has(p) || p !== dir) this.cacheDir(p, entries);
    return changed;
  }

  renderTree() {
    this.renderCrumbs();
    const scroll = this.tree.scrollTop;
    const frag = document.createDocumentFragment();
    this.renderDir(this.workspace, 0, frag);
    this.tree.replaceChildren(frag);
    this.tree.scrollTop = scroll;
    this.highlightTree();
    this.refreshTree();
  }

  // Re-read the root and every open folder in one request; redraw if anything changed.
  async refreshTree() {
    const paths = [this.workspace, ...[...this.expanded].filter((p) => !this.workspace || p === this.workspace || p.startsWith(this.workspace + '/'))];
    const seq = (this.treeSeq = (this.treeSeq || 0) + 1);
    try {
      let changed = false;
      if (!this.dirCache.has(this.workspace)) { await this.fetchDir(this.workspace); changed = true; }
      const { lists } = await api('/api/fs/lists', { method: 'POST', json: { paths } });
      for (const [p, entries] of Object.entries(lists)) {
        if (Array.isArray(entries)) changed = this.cacheDir(p, entries) || changed;
        else if (this.dirCache.has(p)) { this.dirCache.delete(p); changed = true; }
      }
      // Warm the level below the root for instant expanding.
      this.fetchDir(this.workspace).then((c) => { if (c && seq === this.treeSeq) this.redrawTree(); }).catch(() => {});
      if (changed && seq === this.treeSeq) this.redrawTree();
    } catch (e) {
      if (!this.dirCache.has(this.workspace)) this.tree.replaceChildren(h('div', { class: 'tree-msg' }, e.message));
    }
  }

  redrawTree() {
    if (!this.el.classList.contains('drawer-open')) return;
    const scroll = this.tree.scrollTop;
    const frag = document.createDocumentFragment();
    this.renderDir(this.workspace, 0, frag);
    this.tree.replaceChildren(frag);
    this.tree.scrollTop = scroll;
    this.highlightTree();
  }

  renderDir(dir, depth, into) {
    const cached = this.dirCache.get(dir);
    const pad = `padding-left:${34 + depth * 14}px`;
    if (!cached) {
      into.append(h('div', { class: 'tree-msg loading', style: pad }, 'Loading…'));
      return;
    }
    const entries = cached.entries.filter((e) => this.showHidden || !e.hidden);
    if (!entries.length) into.append(h('div', { class: 'tree-msg', style: pad }, 'Empty folder'));
    for (const e of entries) {
      const path = join(dir, e.name);
      const isDir = e.type === 'dir';
      const open = isDir && this.expanded.has(path);
      const row = h('div', { class: `node ${isDir ? 'dir' : 'file'}${open ? ' open' : ''}${e.hidden ? ' hidden-file' : ''}`, role: 'treeitem', dataset: { path }, style: `padding-left:${4 + depth * 14}px` },
        h('span', { class: 'twisty' }, isDir ? icon('chevron') : null),
        fileIcon(e.name, isDir ? 'dir' : 'file', open),
        h('button', { class: 'label', type: 'button' }, e.name),
        h('button', { class: 'more', type: 'button', 'aria-label': `Options for ${e.name}` }, icon('more')));
      row.querySelector('.label').addEventListener('click', () => (isDir ? this.toggleFolder(path, row, depth) : this.pick(path)));
      row.querySelector('.twisty').addEventListener('click', () => isDir && this.toggleFolder(path, row, depth));
      row.querySelector('.more').addEventListener('click', () => this.entryMenu(path, isDir));
      into.append(row);
      if (open) {
        const kids = h('div', { dataset: { children: path } });
        this.renderDir(path, depth + 1, kids);
        into.append(kids);
      }
    }
  }

  async toggleFolder(path, row, depth) {
    const existing = this.tree.querySelector(`[data-children="${CSS.escape(path)}"]`);
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      row.classList.remove('open');
      const ic = row.querySelector('svg.ficon'); if (ic) ic.classList.remove('open');
      if (existing) existing.remove();
    } else {
      this.expanded.add(path);
      row.classList.add('open');
      const ic = row.querySelector('svg.ficon'); if (ic) ic.classList.add('open');
      const box = h('div', { dataset: { children: path } });
      row.after(box);
      this.renderDir(path, depth + 1, box);       // instant when read ahead
      this.highlightTree();
      try {
        const changed = await this.fetchDir(path);   // refresh + read the next level ahead
        if (changed && box.isConnected) { const fresh = document.createDocumentFragment(); this.renderDir(path, depth + 1, fresh); box.replaceChildren(fresh); this.highlightTree(); }
      } catch (e) {
        if (box.isConnected) box.replaceChildren(h('div', { class: 'tree-msg', style: `padding-left:${34 + (depth + 1) * 14}px` }, e.message));
      }
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
      f ? { label: 'Run this file', value: 'run', icon: 'play', sub: runCommandFor(f.path) ? '' : 'not runnable' } : null,
      f && /\.(md|markdown|mdx)$/i.test(f.path) ? { label: 'Preview Markdown', value: 'mdpreview', icon: 'eye' } : null,
      f && /\.html?$/i.test(f.path) ? { label: 'Open page in browser', value: 'htmlpreview', icon: 'globe' } : null,
      text ? { label: 'Go to symbol…', value: 'symbol', icon: 'search', sub: 'functions, classes' } : null,
      text ? { label: 'Go to definition', value: 'definition', icon: 'external' } : null,
      text ? { label: 'Rename symbol…', value: 'rename', icon: 'text' } : null,
      text ? { label: 'Problems', value: 'problems', icon: 'x' } : null,
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
    if (choice === 'run') this.runFile();
    else if (choice === 'mdpreview') this.markdownPreview(f.path);
    else if (choice === 'htmlpreview') window.open('/files/' + f.path.split('/').map(encodeURIComponent).join('/'), '_blank', 'noopener');
    else if (choice === 'symbol') { this.editor.focus(); this.editor.trigger('menu', 'editor.action.quickOutline', null); }
    else if (choice === 'definition') { this.editor.focus(); this.editor.trigger('menu', 'editor.action.revealDefinition', null); }
    else if (choice === 'rename') { this.editor.focus(); this.editor.trigger('menu', 'editor.action.rename', null); }
    else if (choice === 'problems') this.problemsSheet();
    else if (choice === 'palette') { this.editor.focus(); this.editor.trigger('menu', 'editor.action.quickCommand', null); }
    else if (choice === 'format') {
      const action = this.editor.getAction('editor.action.formatDocument');
      if (action && action.isSupported()) { await action.run(); toast('Formatted'); }
      else toast('No formatter for this kind of file. Try your project\'s formatter in the terminal.');
    } else if (choice === 'goto') this.gotoLine(); else if (choice === 'replace') { this.editor.focus(); this.editor.getAction('editor.action.startFindReplaceAction').run(); }
    else if (choice === 'search') this.searchSheet('text');
    else if (choice === 'download') this.download(f.path);
    else if (choice === 'save') this.save(f.path, { now: true, force: false });
    else if (choice === 'reload') {
      if (this.isDirty(f) && !(await confirm('Discard your unsaved changes?', 'This loads the version saved on your Mac.', { ok: 'Discard', danger: true }))) return;
      this.reloadFromDisk(f.path, { discard: true });
    } else if (choice === 'wrap') this.setWordWrap(wrap === 'off');
    else if (choice === 'bigger' || choice === 'smaller') this.setFontSize(Math.max(10, Math.min(24, size + (choice === 'bigger' ? 1 : -1))));
    else if (choice === 'close') this.close(f.path);
  }

  // ---------- developer tools ----------
  remember(path) {
    const recent = store.get('code.recent', []).filter((p) => p !== path);
    recent.unshift(path);
    store.set('code.recent', recent.slice(0, 30));
  }

  async runFile() {
    const f = this.active && this.files.get(this.active);
    if (!f) { toast('Open a file to run it.'); return; }
    const cmd = runCommandFor(f.path);
    if (!cmd) { toast(`devbox doesn't know how to run ${baseName(f.path)}. Run it from the terminal.`); return; }
    if (f.model && this.isDirty(f)) await this.save(f.path, { now: true });
    const dir = f.path.split('/').slice(0, -1).join('/');
    const term = this.ctx.panes().term;
    this.ctx.switchTab('term');
    term.runInNamedSession(`▶ ${baseName(f.path)}`, dir, cmd(baseName(f.path)));
  }

  problemsSheet() {
    const monaco = this.monaco;
    if (!monaco) return;
    const S = monaco.MarkerSeverity;
    const all = monaco.editor.getModelMarkers({}).filter((m) => m.severity >= S.Warning)
      .sort((a, b) => b.severity - a.severity || a.resource.path.localeCompare(b.resource.path) || a.startLineNumber - b.startLineNumber);
    sheet((panel, done) => {
      panel.classList.add('sheet-tall');
      const list = h('div', { class: 'results' });
      if (!all.length) list.append(h('p', { class: 'pane-msg' }, 'No problems in your open files.'));
      for (const m of all.slice(0, 300)) {
        const rel = m.resource.path.replace(/^\//, '');
        list.append(h('button', { class: 'result problem', type: 'button', onclick: () => { done(null); this.reveal(rel, m.startLineNumber, m.startColumn); } },
          h('span', { class: m.severity === S.Error ? 'p-err' : 'p-warn' }, m.severity === S.Error ? '⊗' : '⚠'),
          h('span', { class: 'p-text' }, h('b', {}, m.message), h('small', {}, `${baseName(rel)}:${m.startLineNumber}${m.source ? ' · ' + m.source : ''}`))));
      }
      panel.append(h('h3', {}, `Problems${all.length ? ` (${all.length})` : ''}`), list);
    });
  }

  smartsSheet() {
    const f = this.active && this.files.get(this.active);
    const st = f && f.model && this.smarts.status(f.model);
    if (!st) return;
    const srv = st.server || {};
    sheet((panel, done) => {
      const lang = srv.label || st.group;
      if (st.state === 'ready') {
        panel.append(h('h3', {}, `${srv.name} is running`), h('p', {}, `Full ${lang} support: completion, errors, hover, go to definition, rename, formatting and semantic highlighting.`),
          h('p', { class: 'mono small' }, srv.path || ''),
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => { done(null); this.restartSmarts(); } }, 'Restart'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => done(null) }, 'OK')));
      } else if (st.state === 'missing') {
        panel.append(h('h3', {}, `Smarter ${lang}`),
          h('p', {}, `Right now you get basic highlighting. Install ${srv.name} on your Mac for full completion, errors, go to definition and exact highlighting of your own classes and functions.`),
          srv.installNote ? h('p', {}, srv.installNote) : null,
          h('code', { class: 'cmd' }, srv.install || ''),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: async () => { done(null); await this.smarts.loadServers(); this.restartSmarts(); } }, 'I installed it'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { done(null); this.ctx.switchTab('term'); this.ctx.panes().term.openSession({ cmd: srv.install, name: `install ${srv.name}` }); } }, 'Install in terminal')));
      } else {
        const why = st.client && st.client.exitInfo && st.client.exitInfo.stderr;
        panel.append(h('h3', {}, `${srv.name || 'Language server'} ${st.state === 'starting' ? 'is starting' : 'stopped'}`),
          why ? h('pre', { class: 'cmd small' }, why) : h('p', {}, st.state === 'starting' ? 'Large projects can take a moment to index.' : 'It may have crashed. Restart it to try again.'),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { done(null); this.restartSmarts(); } }, 'Restart')));
      }
    });
  }

  async restartSmarts() {
    for (const c of this.smarts.clients.values()) c.close();
    this.smarts.clients.clear();
    await this.smarts.loadServers();
    for (const f of this.files.values()) if (f.model) this.smarts.attach(f.model, f.path, true);
  }

  async markdownPreview(path) {
    const f = this.files.get(path);
    if (!f || !f.model) return;
    if (!this._marked) {
      // ESM build: the UMD one gets swallowed by Monaco's AMD loader and never sets a global.
      this._marked = await import('/vendor/marked/lib/marked.esm.js').then((m) => m.marked || m.default).catch(() => null);
    }
    const marked = this._marked;
    if (!marked) { toast('Couldn\'t load the Markdown previewer.', 'bad'); return; }
    const body = h('article', { class: 'md-body' });
    const render = () => { body.innerHTML = marked.parse(f.model.getValue(), { gfm: true, breaks: false }); body.querySelectorAll('script').forEach((x) => x.remove()); };
    render();
    const sub = f.model.onDidChangeContent(() => render());
    const overlay = h('div', { class: 'overlay md-overlay' },
      h('div', { class: 'overlay-head' },
        iconButton('x', 'Close preview', () => { sub.dispose(); overlay.remove(); }),
        h('div', { class: 'oh-title' }, h('b', {}, baseName(path)), h('small', {}, 'Markdown preview'))),
      h('div', { class: 'md-scroll' }, body));
    this.el.append(overlay);
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
              if (!q) {
                const recent = store.get('code.recent', []).filter((p) => !scope || p.startsWith(scope + '/'));
                if (recent.length) {
                  info.textContent = 'Recently opened';
                  results.replaceChildren(...recent.slice(0, 20).map((p) => {
                    const rel = scope ? p.slice(scope.length + 1) : p;
                    const [dir, name] = splitPath(rel);
                    return h('button', { class: 'result', type: 'button', onclick: () => pick(p) }, fileIcon(name), h('span', { class: 'r-name' }, name), h('span', { class: 'r-dir' }, dir));
                  }));
                  return;
                }
              }
              const r = await api('/api/search/files?' + qs({ path: scope, q }));
              if (my !== seq) return;
              info.textContent = r.results.length ? (q ? `${r.results.length === 60 ? 'Top 60' : r.results.length} of ${r.total} files` : `${r.total} files · type to filter`) : `No files match “${q}”.`;
              results.replaceChildren(...r.results.map((x) => {
                const [dir, name] = splitPath(x.rel);
                return h('button', { class: 'result', type: 'button', onclick: () => pick(x.path) }, fileIcon(name), h('span', { class: 'r-name' }, name), h('span', { class: 'r-dir' }, dir));
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
