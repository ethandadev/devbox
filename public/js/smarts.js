// Code intelligence for the editor.
//
// 1. Language servers (clangd, pyright, gopls, …) running on the Mac give the
//    real thing: completion, errors, hover, go to definition, formatting and
//    semantic highlighting (your own classes, functions, macros…).
// 2. Without one installed, a built-in fallback still colors classes,
//    namespaces, functions and macros by reading the code's structure.
import { api } from './ui.js';

// Monaco language id -> language-server group + LSP languageId.
const GROUPS = {
  cpp: ['cpp', 'cpp'], c: ['cpp', 'c'], 'objective-c': ['cpp', 'objective-c'],
  python: ['python', 'python'], go: ['go', 'go'], rust: ['rust', 'rust'], swift: ['swift', 'swift'],
  shell: ['shell', 'shellscript'], ruby: ['ruby', 'ruby'], php: ['php', 'php'], lua: ['lua', 'lua'],
  java: ['java', 'java'], kotlin: ['kotlin', 'kotlin'], zig: ['zig', 'zig'], dart: ['dart', 'dart'],
};

const TOKEN_TYPES = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property',
  'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator', 'concept', 'label'];
const TOKEN_MODS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'];
const T = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i]));

// VS Code Dark+ colors for semantic tokens.
export const SEMANTIC_THEME_RULES = [
  { token: 'class', foreground: '4EC9B0' }, { token: 'struct', foreground: '4EC9B0' }, { token: 'type', foreground: '4EC9B0' },
  { token: 'interface', foreground: '4EC9B0' }, { token: 'enum', foreground: '4EC9B0' }, { token: 'typeParameter', foreground: '4EC9B0' },
  { token: 'concept', foreground: '4EC9B0' }, { token: 'namespace', foreground: '4EC9B0' },
  { token: 'function', foreground: 'DCDCAA' }, { token: 'method', foreground: 'DCDCAA' },
  { token: 'macro', foreground: 'BD93F9' }, { token: 'enumMember', foreground: '4FC1FF' },
  { token: 'parameter', foreground: '9CDCFE' }, { token: 'variable', foreground: '9CDCFE' }, { token: 'property', foreground: '9CDCFE' },
  { token: 'variable.readonly', foreground: '4FC1FF' }, { token: 'decorator', foreground: 'DCDCAA' },
];

// ---------------------------------------------------------------------------
// Fallback: structure-aware highlighting without a language server
// ---------------------------------------------------------------------------
const KEYWORDS = new Set(('if else for while do switch case default break continue return goto try catch finally throw throws new delete this self super ' +
  'class struct union enum interface trait protocol extension impl namespace using typedef typename template module import export from as package ' +
  'public private protected internal static const constexpr consteval constinit volatile mutable inline virtual override final explicit extern friend operator ' +
  'auto void bool char short int long float double signed unsigned wchar_t size_t true false null nullptr nil None True False and or not in is ' +
  'let var val fn func function def lambda async await yield fun mut ref pub crate mod use where match loop type struct dyn move unsafe ' +
  'sizeof alignof decltype noexcept static_assert static_cast dynamic_cast reinterpret_cast const_cast typeid concept requires co_await co_return co_yield ' +
  'elif except raise with pass global nonlocal assert del print end begin then unless until when record sealed permits instanceof ' +
  'string int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t std').split(/\s+/));

const DECL_BEFORE = /\b(class|struct|union|enum|interface|trait|protocol|namespace|concept|typename|type|impl|record|object|actor)\s+$/;
const DECL = /\b(class|struct|union|enum(?:\s+class|\s+struct)?|interface|trait|protocol|extension|record|object|actor|concept|impl(?:\s*<[^>]*>)?|type|typealias|namespace|module)\s+([A-Za-z_]\w*)/g;

// Blank out comments and strings so their contents aren't treated as code.
function maskCode(text, lang) {
  const hashComments = lang === 'python' || lang === 'ruby' || lang === 'shell';
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (!hashComments && c === '/' && d === '/') { while (i < n && text[i] !== '\n') out[i++] = ' '; continue; }
    if (hashComments && c === '#') { while (i < n && text[i] !== '\n') out[i++] = ' '; continue; }
    if (!hashComments && c === '/' && d === '*') {
      out[i++] = ' '; out[i++] = ' ';
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i++] = ' '; out[i++] = ' '; }
      continue;
    }
    if (c === '"' || c === '\'' || c === '`') {
      const triple = lang === 'python' && text.substr(i, 3) === c.repeat(3);
      const end = triple ? c.repeat(3) : c;
      out[i] = ' '; i += triple ? 3 : 1;
      if (triple) { out[i - 1] = ' '; out[i - 2] = ' '; }
      while (i < n) {
        if (text[i] === '\\') { out[i] = ' '; if (text[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
        if (text.substr(i, end.length) === end) { for (let k = 0; k < end.length; k++) out[i + k] = ' '; i += end.length; break; }
        if (text[i] === '\n' && !triple && c !== '`') break;
        if (text[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

function heuristicTokens(model) {
  const lang = model.getLanguageId();
  const text = model.getValue();
  if (text.length > 600000) return new Uint32Array(0);
  const masked = maskCode(text, lang);
  const cFamily = lang === 'cpp' || lang === 'c' || lang === 'objective-c';

  const types = new Map();   // name -> token type
  for (const m of masked.matchAll(DECL)) {
    const kw = m[1].split(/\s|</)[0];
    types.set(m[2], kw === 'namespace' || kw === 'module' ? T.namespace : kw === 'enum' ? T.enum : kw === 'interface' || kw === 'protocol' || kw === 'trait' ? T.interface : kw === 'concept' ? T.concept : T.class);
  }
  for (const m of masked.matchAll(/\btemplate\s*<([^>]*)>/g)) for (const p of m[1].matchAll(/\b(?:typename|class)\s+([A-Za-z_]\w*)/g)) types.set(p[1], T.typeParameter);
  for (const m of masked.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=/g)) types.set(m[1], T.type);
  for (const m of masked.matchAll(/\btypedef\b[^;{]*?\b([A-Za-z_]\w*)\s*;/g)) types.set(m[1], T.type);
  for (const m of masked.matchAll(/}\s*([A-Za-z_]\w*)\s*;/g)) if (/typedef/.test(masked.slice(Math.max(0, m.index - 2000), m.index))) types.set(m[1], T.type);

  const data = [];
  let prevLine = 0, prevChar = 0;
  const lines = masked.split('\n');
  const maxLines = Math.min(lines.length, 30000);
  for (let ln = 0; ln < maxLines; ln++) {
    const line = lines[ln];
    if (cFamily && /^\s*#\s*(include|import)\b/.test(line)) continue;
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(line))) {
      const word = m[0], col = m.index;
      if (KEYWORDS.has(word) || (col > 0 && /[\d.]/.test(line[col - 1]) && line[col - 1] !== '.')) continue;
      if (col > 0 && line[col - 1] === '#') continue;
      const after = line.slice(col + word.length);
      const before = line.slice(0, col);
      let type = -1, mods = 0;
      if (types.has(word)) {
        type = types.get(word);
        if (DECL_BEFORE.test(before)) mods = 1;
      } else if (/^\s*::/.test(after)) type = /^[A-Z]/.test(word) ? T.class : T.namespace;
      else if (/^\s*\(/.test(after)) {
        if (/\bnew\s+$/.test(before) || (/^[A-Z][a-z]/.test(word) && lang !== 'go')) type = T.class;
        else type = /(\.|->)\s*$/.test(before) ? T.method : T.function;
        if (/\b(def|fn|func|function|fun)\s+$/.test(before)) mods = 1;
      } else if (cFamily && /^[A-Z][A-Z0-9_]+$/.test(word) && word.length > 1) type = T.macro;
      else if (/^[A-Z][a-z0-9]+[A-Za-z0-9]*$/.test(word) || /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word)) type = T.class;
      else if (/^\s*<[\w\s,:<>*&]*>\s*[(\w&*]/.test(after) && /^[A-Za-z_]/.test(word) && cFamily) type = T.class;
      if (type < 0) continue;
      data.push(ln - prevLine, ln === prevLine ? col - prevChar : col, word.length, type, mods);
      prevLine = ln; prevChar = col;
    }
  }
  return new Uint32Array(data);
}

// ---------------------------------------------------------------------------
// Minimal LSP client
// ---------------------------------------------------------------------------
class LspClient {
  constructor(group, root, smarts) {
    this.group = group;
    this.root = root;
    this.smarts = smarts;
    this.id = 0;
    this.pending = new Map();
    this.ready = false;
    this.caps = {};
    this.docs = new Map();   // uri -> { version }
    this.queue = [];
    this.state = 'starting';
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/lsp?group=${encodeURIComponent(this.group)}&root=${encodeURIComponent(this.root)}`);
    this.ws = ws;
    ws.onopen = () => this.initialize();
    ws.onmessage = (ev) => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } this.onMessage(msg); };
    ws.onclose = () => {
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error('Language server closed'));
      this.pending.clear();
      if (this.state !== 'failed') this.state = 'stopped';
      this.smarts.changed();
    };
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeout = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize() {
    const rootUri = this.smarts.toLspUri(this.root);
    try {
      const res = await this.request('initialize', {
        processId: null, rootUri, rootPath: this.smarts.abs(this.root),
        workspaceFolders: [{ uri: rootUri, name: this.root.split('/').pop() || 'root' }],
        clientInfo: { name: 'devbox' },
        initializationOptions: this.group === 'cpp' ? { fallbackFlags: ['-std=c++20'] } : undefined,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], insertReplaceSupport: false }, contextSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
            definition: { linkSupport: true }, declaration: { linkSupport: true }, references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            formatting: {}, rename: { prepareSupport: false },
            publishDiagnostics: { relatedInformation: false },
            semanticTokens: { requests: { full: true, range: false }, tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODS, formats: ['relative'], multilineTokenSupport: false, overlappingTokenSupport: false },
          },
        },
      }, 30000);
      this.caps = res.capabilities || {};
      this.notify('initialized', {});
      this.ready = true;
      this.state = 'ready';
      for (const fn of this.queue.splice(0)) fn();
      this.smarts.changed();
    } catch (e) {
      this.state = 'failed';
      this.smarts.changed();
    }
  }

  onMessage(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') this.smarts.diagnostics(this, msg.params);
    else if (msg.method === 'devbox/serverExited') { this.state = 'failed'; this.exitInfo = msg.params; }
    else if (msg.id !== undefined) {
      // Requests from the server: answer politely so it carries on.
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params.items || []).map(() => null);
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: this.smarts.toLspUri(this.root), name: this.root.split('/').pop() || 'root' }];
      this.send({ jsonrpc: '2.0', id: msg.id, result });
    }
  }

  whenReady(fn) { if (this.ready) fn(); else this.queue.push(fn); }

  open(model, rel, languageId) {
    const uri = this.smarts.toLspUri(rel);
    this.whenReady(() => {
      this.docs.set(uri, { version: 1 });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: model.getValue() } });
    });
    let timer = null;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => this.whenReady(() => {
        const doc = this.docs.get(uri);
        if (!doc) return;
        doc.version += 1;
        this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text: model.getValue() }] });
      }), 200);
    });
    return () => { sub.dispose(); clearTimeout(timer); if (this.docs.delete(uri)) this.notify('textDocument/didClose', { textDocument: { uri } }); };
  }

  // Send pending edits right away (before asking the server something).
  flush(model, rel) {
    const uri = this.smarts.toLspUri(rel);
    const doc = this.docs.get(uri);
    if (!doc) return uri;
    if (doc.sentVersion !== model.getAlternativeVersionId()) {
      doc.version += 1;
      doc.sentVersion = model.getAlternativeVersionId();
      this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text: model.getValue() }] });
    }
    return uri;
  }

  saved(rel) {
    const uri = this.smarts.toLspUri(rel);
    if (this.docs.has(uri)) this.notify('textDocument/didSave', { textDocument: { uri } });
  }

  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// Glue between Monaco, the editor and the language servers
// ---------------------------------------------------------------------------
export class Smarts {
  constructor(monaco, code) {
    this.monaco = monaco;
    this.code = code;            // CodePane: open(path), reveal(path, line, col), status, project
    this.clients = new Map();    // `${group}|${root}` -> LspClient
    this.models = new Map();     // model.uri.toString() -> { rel, client, detach }
    this.servers = null;
    this.listeners = new Set();
    this.register();
    this.loadServers();
  }

  async loadServers() {
    try { this.servers = await api('/api/lsp/servers'); } catch { this.servers = {}; }
    for (const [key, info] of this.models) {
      const model = this.monaco.editor.getModel(this.monaco.Uri.parse(key));
      if (model && !info.client) this.attach(model, info.rel, true);
    }
    this.changed();
  }

  onChange(fn) { this.listeners.add(fn); }
  changed() { for (const fn of this.listeners) try { fn(); } catch {} this.refreshSemantic(); }

  abs(rel) { return (this.code.ctx.status.root.replace(/\/$/, '') + (rel ? '/' + rel : '')); }
  toLspUri(rel) { return 'file://' + this.abs(rel).split('/').map(encodeURIComponent).join('/'); }
  fromLspUri(uri) {
    const root = this.code.ctx.status.root.replace(/\/$/, '');
    let p;
    try { p = decodeURIComponent(new URL(uri).pathname); } catch { return null; }
    if (p === root) return '';
    if (!p.startsWith(root + '/')) return null;
    return p.slice(root.length + 1);
  }

  groupOf(model) { return GROUPS[model.getLanguageId()] || null; }

  // Which folder a language server should treat as the project.
  rootFor(rel) {
    const proj = this.code.ctx.project.get();
    if (proj && (rel === proj || rel.startsWith(proj + '/'))) return proj;
    const repo = this.code.ctx.panes().git && this.code.ctx.panes().git.repo;
    if (repo && rel.startsWith(repo + '/')) return repo;
    return rel.split('/').slice(0, -1).join('/');
  }

  status(model) {
    const g = model && this.groupOf(model);
    if (!g) return null;
    const server = this.servers && this.servers[g[0]];
    const info = this.models.get(model.uri.toString());
    const client = info && info.client;
    return { group: g[0], server, state: client ? client.state : (server && server.available ? 'starting' : 'missing'), client };
  }

  attach(model, rel, retry = false) {
    const key = model.uri.toString();
    if (this.models.has(key) && !retry) return;
    const prev = this.models.get(key);
    if (prev && prev.detach) prev.detach();
    const entry = { rel, client: null, detach: null, lang: model.getLanguageId() };
    this.models.set(key, entry);
    const g = this.groupOf(model);
    if (!g || !this.servers || !this.servers[g[0]] || !this.servers[g[0]].available) { this.changed(); return; }
    const root = this.rootFor(rel);
    const ckey = `${g[0]}|${root}`;
    let client = this.clients.get(ckey);
    if (!client || client.state === 'failed' || client.state === 'stopped') { client = new LspClient(g[0], root, this); this.clients.set(ckey, client); }
    entry.client = client;
    entry.detach = client.open(model, rel, g[1]);
    const langSub = model.onDidChangeLanguage(() => { langSub.dispose(); this.attach(model, rel, true); });
    this.changed();
  }

  detach(model) {
    const key = model.uri.toString();
    const info = this.models.get(key);
    if (!info) return;
    if (info.detach) info.detach();
    this.models.delete(key);
    this.monaco.editor.setModelMarkers(model, 'lsp', []);
  }

  saved(rel) { for (const info of this.models.values()) if (info.rel === rel && info.client) info.client.saved(rel); }

  clientFor(model) {
    const info = this.models.get(model.uri.toString());
    return info && info.client && info.client.ready ? info : null;
  }

  diagnostics(client, params) {
    const rel = this.fromLspUri(params.uri);
    if (rel === null) return;
    const model = this.monaco.editor.getModels().find((m) => this.models.get(m.uri.toString()) && this.models.get(m.uri.toString()).rel === rel);
    if (!model) return;
    const S = this.monaco.MarkerSeverity;
    const sev = { 1: S.Error, 2: S.Warning, 3: S.Info, 4: S.Hint };
    this.monaco.editor.setModelMarkers(model, 'lsp', (params.diagnostics || []).map((d) => ({
      severity: sev[d.severity] || S.Error,
      message: d.message,
      source: d.source || this.servers[client.group].name,
      code: d.code !== undefined ? String(d.code) : undefined,
      startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
    })));
  }

  refreshSemantic() {
    clearTimeout(this.semTimer);
    this.semTimer = setTimeout(() => { for (const fn of this.semanticListeners || []) fn(); }, 50);
  }

  // ----- Monaco providers -----
  register() {
    const monaco = this.monaco;
    const langs = [...new Set([...Object.keys(GROUPS), 'java', 'csharp', 'kotlin', 'swift', 'scala', 'dart', 'javascript', 'typescript', 'php'])];
    const pos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
    const range = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
    const md = (c) => {
      if (!c) return [];
      if (Array.isArray(c)) return c.flatMap(md);
      if (typeof c === 'string') return [{ value: c }];
      if (c.kind === 'markdown' || c.kind === 'plaintext') return [{ value: c.kind === 'plaintext' ? '```\n' + c.value + '\n```' : c.value }];
      if (c.language) return [{ value: '```' + c.language + '\n' + c.value + '\n```' }];
      return [{ value: String(c.value || '') }];
    };
    const K = monaco.languages.CompletionItemKind;
    const kindMap = { 1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter };
    const SK = monaco.languages.SymbolKind;
    const toLocations = (res) => {
      if (!res) return [];
      const arr = Array.isArray(res) ? res : [res];
      return arr.map((l) => {
        const uri = l.targetUri || l.uri;
        const r = l.targetSelectionRange || l.range;
        const rel = this.fromLspUri(uri);
        if (rel === null) return null;
        return { uri: monaco.Uri.from({ scheme: 'file', path: '/' + rel }), range: range(r) };
      }).filter(Boolean);
    };

    this.semanticListeners = new Set();
    const self = this;
    for (const lang of langs) {
      const semEmitter = new monaco.Emitter();
      this.semanticListeners.add(() => semEmitter.fire());
      monaco.languages.registerDocumentSemanticTokensProvider(lang, {
        onDidChange: semEmitter.event,
        getLegend: () => ({ tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODS }),
        async provideDocumentSemanticTokens(model) {
          const info = self.clientFor(model);
          if (info && info.client.caps.semanticTokensProvider) {
            try {
              const uri = info.client.flush(model, info.rel);
              const res = await info.client.request('textDocument/semanticTokens/full', { textDocument: { uri } }, 8000);
              if (res && res.data) return { data: self.remapTokens(res.data, info.client.caps.semanticTokensProvider.legend) };
            } catch {}
          }
          return { data: heuristicTokens(model) };
        },
        releaseDocumentSemanticTokens() {},
      });
    }

    for (const lang of Object.keys(GROUPS)) {
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.', ':', '>', '(', '"', '/', '<', '#', ' '],
        async provideCompletionItems(model, position, context) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.completionProvider) return { suggestions: [] };
          if (context.triggerCharacter === ' ' || (context.triggerCharacter && !(info.client.caps.completionProvider.triggerCharacters || []).includes(context.triggerCharacter))) {
            if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter) return { suggestions: [] };
          }
          const uri = info.client.flush(model, info.rel);
          let res;
          try { res = await info.client.request('textDocument/completion', { textDocument: { uri }, position: pos(position), context: { triggerKind: context.triggerCharacter ? 2 : 1, triggerCharacter: context.triggerCharacter } }, 8000); }
          catch { return { suggestions: [] }; }
          const items = Array.isArray(res) ? res : (res && res.items) || [];
          const word = model.getWordUntilPosition(position);
          const defRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return {
            incomplete: !!(res && res.isIncomplete),
            suggestions: items.slice(0, 300).map((it) => {
              const edit = it.textEdit;
              return {
                label: it.label.trim(),
                kind: kindMap[it.kind] || K.Text,
                detail: it.detail,
                documentation: it.documentation ? md(it.documentation)[0] : undefined,
                insertText: (edit && edit.newText) || it.insertText || it.label.trim(),
                insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                range: edit && edit.range ? range(edit.range) : edit && edit.insert ? range(edit.insert) : defRange,
                sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
              };
            }),
          };
        },
      });
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.hoverProvider) return null;
          const uri = info.client.flush(model, info.rel);
          try {
            const res = await info.client.request('textDocument/hover', { textDocument: { uri }, position: pos(position) }, 8000);
            if (!res || !res.contents) return null;
            return { contents: md(res.contents), range: res.range ? range(res.range) : undefined };
          } catch { return null; }
        },
      });
      monaco.languages.registerSignatureHelpProvider(lang, {
        signatureHelpTriggerCharacters: ['(', ','],
        async provideSignatureHelp(model, position) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.signatureHelpProvider) return null;
          const uri = info.client.flush(model, info.rel);
          try {
            const res = await info.client.request('textDocument/signatureHelp', { textDocument: { uri }, position: pos(position) }, 6000);
            if (!res || !res.signatures || !res.signatures.length) return null;
            return {
              value: {
                signatures: res.signatures.map((s) => ({ label: s.label, documentation: s.documentation ? md(s.documentation)[0] : undefined, parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: p.documentation ? md(p.documentation)[0] : undefined })) })),
                activeSignature: res.activeSignature || 0, activeParameter: res.activeParameter || 0,
              },
              dispose() {},
            };
          } catch { return null; }
        },
      });
      monaco.languages.registerDefinitionProvider(lang, {
        async provideDefinition(model, position) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.definitionProvider) return null;
          const uri = info.client.flush(model, info.rel);
          try { return toLocations(await info.client.request('textDocument/definition', { textDocument: { uri }, position: pos(position) }, 10000)); }
          catch { return null; }
        },
      });
      monaco.languages.registerReferenceProvider(lang, {
        async provideReferences(model, position) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.referencesProvider) return null;
          const uri = info.client.flush(model, info.rel);
          try { return toLocations(await info.client.request('textDocument/references', { textDocument: { uri }, position: pos(position), context: { includeDeclaration: true } }, 15000)); }
          catch { return null; }
        },
      });
      monaco.languages.registerDocumentSymbolProvider(lang, {
        async provideDocumentSymbols(model) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.documentSymbolProvider) return [];
          const uri = info.client.flush(model, info.rel);
          try {
            const res = await info.client.request('textDocument/documentSymbol', { textDocument: { uri } }, 10000);
            const conv = (s) => ({
              name: s.name, detail: s.detail || '', kind: (s.kind || 1) - 1, tags: [],
              range: range(s.range || s.location.range), selectionRange: range(s.selectionRange || s.range || s.location.range),
              children: (s.children || []).map(conv),
            });
            void SK;
            return (res || []).map(conv);
          } catch { return []; }
        },
      });
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        async provideDocumentFormattingEdits(model, options) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.documentFormattingProvider) return [];
          const uri = info.client.flush(model, info.rel);
          try {
            const edits = await info.client.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }, 15000);
            return (edits || []).map((e) => ({ range: range(e.range), text: e.newText }));
          } catch { return []; }
        },
      });
      monaco.languages.registerRenameProvider(lang, {
        async provideRenameEdits(model, position, newName) {
          const info = self.clientFor(model);
          if (!info || !info.client.caps.renameProvider) return null;
          const uri = info.client.flush(model, info.rel);
          const res = await info.client.request('textDocument/rename', { textDocument: { uri }, position: pos(position), newName }, 15000);
          const edits = [];
          const add = (u, list) => {
            const rel = self.fromLspUri(u);
            if (rel === null) return;
            const target = monaco.Uri.from({ scheme: 'file', path: '/' + rel });
            for (const e of list) edits.push({ resource: target, textEdit: { range: range(e.range), text: e.newText }, versionId: undefined });
          };
          for (const [u, list] of Object.entries((res && res.changes) || {})) add(u, list);
          for (const dc of (res && res.documentChanges) || []) if (dc.textDocument) add(dc.textDocument.uri, dc.edits);
          return { edits };
        },
      });
    }

    // Go to definition in another file: open it in devbox's editor.
    if (monaco.editor.registerEditorOpener) {
      monaco.editor.registerEditorOpener({
        openCodeEditor: (source, resource, selectionOrPosition) => {
          const rel = resource.path.replace(/^\//, '');
          const p = selectionOrPosition;
          const line = p ? (p.startLineNumber || p.lineNumber) : 1;
          const col = p ? (p.startColumn || p.column) : 1;
          this.code.reveal(rel, line, col);
          return true;
        },
      });
    }
  }

  remapTokens(data, legend) {
    const typeMap = (legend.tokenTypes || []).map((t) => (t in T ? T[t] : t === 'enumConstant' ? T.enumMember : t === 'typeAlias' ? T.type : t === 'unknown' ? -1 : -1));
    const modMap = (legend.tokenModifiers || []).map((m) => TOKEN_MODS.indexOf(m));
    const out = [];
    // Drop tokens of types we don't style, fixing up the relative positions.
    let absLine = 0, absChar = 0, keptLine = 0, keptChar = 0;
    for (let i = 0; i + 4 < data.length + 1; i += 5) {
      const dl = data[i], dc = data[i + 1];
      absLine += dl; absChar = dl ? dc : absChar + dc;
      const t = typeMap[data[i + 3]];
      if (t === undefined || t < 0) continue;
      let mods = 0;
      for (let b = 0; b < modMap.length; b++) if ((data[i + 4] >> b) & 1 && modMap[b] >= 0) mods |= 1 << modMap[b];
      out.push(absLine - keptLine, absLine === keptLine ? absChar - keptChar : absChar, data[i + 2], t, mods);
      keptLine = absLine; keptChar = absChar;
    }
    return new Uint32Array(out);
  }
}
