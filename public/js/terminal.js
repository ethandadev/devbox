import { api, h, icon, key, menu, sheet, store, toast, confirm, copyText } from './ui.js';

const THEME = {
  background: '#0e1013', foreground: '#e4e6ea', cursor: '#f2b25c', cursorAccent: '#0e1013',
  selectionBackground: 'rgba(242,178,92,0.30)',
  black: '#1b1f24', red: '#ef6b6b', green: '#56c98a', yellow: '#e8b04a', blue: '#6aa8f0', magenta: '#c792ea', cyan: '#5cc8d0', white: '#d5d8dd',
  brightBlack: '#5c636e', brightRed: '#ff8a8a', brightGreen: '#7ee0a5', brightYellow: '#f5c870', brightBlue: '#8cbcf5', brightMagenta: '#d7aef0', brightCyan: '#80dbe2', brightWhite: '#ffffff',
};

export class TerminalPane {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.ws = null;
    this.sessionId = store.get('term.session');
    this.sessionName = '';
    this.retry = 0;
    this.retryTimer = null;
    this.ctrl = false;
    this.alt = false;
    this.visible = false;
    this.fontSize = store.get('term.fontSize', 13);

    // top bar: session switcher + actions
    this.sessionChip = h('button', { class: 'chip-btn', type: 'button', 'aria-label': 'Switch terminal', onclick: () => this.sessionMenu() },
      h('span', {}, 'terminal'), icon('down'));
    this.top = h('div', { dataset: { for: 'term' } }, this.sessionChip,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Terminal options', onclick: () => this.optionsMenu() }, icon('more')));
    ctx.topActions.append(this.top);

    // body
    this.host = h('div', { class: 'term-host' });
    this.notice = h('div', { class: 'overlay-msg', hidden: true });
    this.host.append(this.notice);
    el.append(this.host, this.buildKeybar());

    this.term = new window.Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: this.fontSize,
      lineHeight: 1.12,
      theme: THEME,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try { this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener'))); } catch {}
    this.term.open(this.host);

    const ta = this.term.textarea;
    if (ta) for (const [k, v] of Object.entries({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send' })) ta.setAttribute(k, v);

    this.term.onData((d) => this.input(d));

    const ro = new ResizeObserver(() => this.scheduleFit());
    ro.observe(this.host);
    window.addEventListener('devbox:layout', () => this.scheduleFit());

    this.connect();
  }

  // ---------- connection ----------
  connect() {
    clearTimeout(this.retryTimer);
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.ctx.setConnection('connecting');
    try { this.fit.fit(); } catch {}
    const params = new URLSearchParams({ cols: this.term.cols, rows: this.term.rows });
    if (this.sessionId) params.set('id', this.sessionId);
    else if (this.pendingNew) {
      for (const [k, v] of Object.entries(this.pendingNew)) if (v !== undefined && v !== null) params.set(k, v);
      this.pendingNew = null;
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?${params}`);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => { opened = true; this.retry = 0; };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        if (this.sessionId !== msg.id || msg.resumed) this.term.reset();
        this.sessionId = msg.id;
        this.sessionName = msg.name;
        store.set('term.session', msg.id);
        this.sessionChip.querySelector('span').textContent = msg.name;
        this.ctx.setConnection('online');
        this.showNotice(null);
        this.sendResize();
      } else if (msg.type === 'data') {
        this.term.write(msg.data);
      } else if (msg.type === 'exit') {
        this.term.write(`\r\n\x1b[90m[shell exited${msg.code ? ' with code ' + msg.code : ''} — tap to start a new one]\x1b[0m\r\n`);
        this.sessionId = null;
        store.remove('term.session');
        this.exited = true;
      } else if (msg.type === 'error') {
        toast(msg.message, 'bad');
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.exited) { this.ctx.setConnection('online'); return; }
      this.ctx.setConnection('offline');
      if (!opened && ev.code === 1006 && this.retry > 2) {
        this.showNotice('Can\'t reach your Mac. Retrying…');
      } else if (opened) {
        this.showNotice('Reconnecting…');
      }
      const delay = Math.min(8000, 400 * 2 ** this.retry);
      this.retry += 1;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  onResume() {
    // Coming back from the background: the socket is often dead. Reconnect now
    // instead of waiting for the backoff timer.
    if (!this.ws || this.ws.readyState > 1) { this.retry = 0; this.connect(); }
    else this.send({ type: 'ping' });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  input(d) {
    if (this.exited) { this.exited = false; this.term.reset(); this.connect(); return; }
    if (this.ctrl && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
      else if (d === ' ') d = '\x00';
      this.setMod('ctrl', false);
    }
    if (this.alt && d.length >= 1 && !d.startsWith('\x1b')) {
      d = '\x1b' + d;
      this.setMod('alt', false);
    }
    if (!this.send({ type: 'input', data: d })) toast('Not connected yet — try again in a moment.');
  }

  sendResize() { this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows }); }

  scheduleFit() {
    if (!this.visible) return;
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      try {
        const before = `${this.term.cols}x${this.term.rows}`;
        this.fit.fit();
        if (`${this.term.cols}x${this.term.rows}` !== before) this.sendResize();
      } catch {}
    });
  }

  showNotice(text) {
    this.notice.hidden = !text;
    this.notice.textContent = text || '';
  }

  // ---------- keys ----------
  buildKeybar() {
    const arrow = (dir) => () => {
      const app = this.term.modes && this.term.modes.applicationCursorKeysMode;
      this.input((app ? '\x1bO' : '\x1b[') + dir);
    };
    this.ctrlKey = key('ctrl', () => this.setMod('ctrl', !this.ctrl), { cls: 'mod' });
    this.altKey = key('alt', () => this.setMod('alt', !this.alt), { cls: 'mod' });
    const send = (s) => () => this.input(s);
    return h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Extra keys' },
      key('esc', send('\x1b'), { cls: 'mod' }),
      key('tab', send('\t'), { cls: 'mod' }),
      this.ctrlKey,
      this.altKey,
      key('^C', send('\x03'), { cls: 'mod', title: 'Control-C' }),
      h('span', { class: 'sep' }),
      key('←', arrow('D'), { repeat: true, title: 'Left' }),
      key('↑', arrow('A'), { repeat: true, title: 'Up' }),
      key('↓', arrow('B'), { repeat: true, title: 'Down' }),
      key('→', arrow('C'), { repeat: true, title: 'Right' }),
      h('span', { class: 'sep' }),
      ...['/', '-', '|', '~', '_', '*', '&', '>', '$', '`'].map((c) => key(c, send(c))),
      h('span', { class: 'sep' }),
      key('^D', send('\x04'), { cls: 'mod', title: 'Control-D' }),
      key('^Z', send('\x1a'), { cls: 'mod', title: 'Control-Z' }),
      key('^R', send('\x12'), { cls: 'mod', title: 'Control-R (search history)' }),
      key('^L', send('\x0c'), { cls: 'mod', title: 'Control-L (clear)' }),
    );
  }

  setMod(which, on) {
    this[which] = on;
    (which === 'ctrl' ? this.ctrlKey : this.altKey).classList.toggle('on', on);
  }

  // ---------- menus ----------
  async sessionMenu() {
    let list = [];
    try { list = await api('/api/terminals'); } catch (e) { toast(e.message, 'bad'); return; }
    const choice = await menu('Terminals', [
      ...list.map((s) => ({ label: s.name, value: 'go:' + s.id, current: s.id === this.sessionId, sub: s.id === this.sessionId ? 'this one' : '' })),
      { label: 'New terminal', value: 'new', icon: 'plus' },
      this.sessionId ? { label: `Close ${this.sessionName}`, value: 'kill', icon: 'x', danger: true } : null,
    ]);
    if (!choice) return;
    if (choice === 'new') this.switchTo(null);
    else if (choice === 'kill') {
      if (!(await confirm(`Close ${this.sessionName}?`, 'Anything running in it will be stopped.', { ok: 'Close', danger: true }))) return;
      const id = this.sessionId;
      await api('/api/terminals/' + id, { method: 'DELETE' }).catch(() => {});
      const rest = list.filter((s) => s.id !== id);
      this.exited = false;
      this.switchTo(rest.length ? rest[0].id : null);
    } else this.switchTo(choice.slice(3));
  }

  switchTo(id) {
    this.sessionId = id;
    if (id) store.set('term.session', id); else store.remove('term.session');
    const old = this.ws;
    this.ws = null;
    if (old) { old.onclose = null; old.close(); }
    this.exited = false;
    this.term.reset();
    this.retry = 0;
    this.connect();
    this.term.focus();
  }

  async optionsMenu() {
    const choice = await menu('Terminal', [
      { label: 'Paste text…', value: 'paste', icon: 'paste' },
      { label: 'Copy visible output', value: 'copy', icon: 'copy' },
      { label: 'Larger text', value: 'bigger', icon: 'text', sub: `${this.fontSize}px` },
      { label: 'Smaller text', value: 'smaller', icon: 'text' },
      { label: 'Clear screen', value: 'clear', icon: 'x' },
    ]);
    if (choice === 'paste') this.pasteSheet();
    else if (choice === 'copy') copyText(this.visibleText());
    else if (choice === 'bigger' || choice === 'smaller') {
      this.fontSize = Math.max(9, Math.min(22, this.fontSize + (choice === 'bigger' ? 1 : -1)));
      store.set('term.fontSize', this.fontSize);
      this.term.options.fontSize = this.fontSize;
      this.scheduleFit();
    } else if (choice === 'clear') { this.term.clear(); this.input('\x0c'); }
  }

  pasteSheet() {
    // Reading the clipboard from script needs HTTPS; a text box works everywhere.
    sheet((panel, done) => {
      const ta = h('textarea', { class: 'input', placeholder: 'Paste here', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      const runIt = h('input', { type: 'checkbox', id: 'paste-enter' });
      panel.append(h('h3', {}, 'Paste into terminal'), ta,
        h('label', { class: 'check', for: 'paste-enter' }, runIt, 'Press Return after pasting'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
            let text = ta.value.replace(/\r?\n/g, '\r');
            if (!text) return done(null);
            // Bracketed paste so shells don't run multi-line pastes line by line.
            if (this.term.modes && this.term.modes.bracketedPasteMode) text = '\x1b[200~' + text + '\x1b[201~';
            this.input(text + (runIt.checked ? '\r' : ''));
            done(null);
          } }, 'Paste')));
    });
  }

  visibleText() {
    const buf = this.term.buffer.active;
    const lines = [];
    const start = Math.max(0, buf.length - 400);
    for (let i = start; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
    return lines.join('\n').replace(/\n+$/, '');
  }

  // ---------- pane lifecycle ----------
  show() {
    this.visible = true;
    this.scheduleFit();
    setTimeout(() => this.scheduleFit(), 60);
  }
  hide() { this.visible = false; }
  onReselect() { this.term.focus(); }

  // Used by the editor: "Open in terminal".
  runCommand(cmd) {
    this.input(cmd + '\r');
  }

  // Used by Run: a fresh terminal in a folder, running a command.
  openSession({ cwd = '', cmd = '', name = '' } = {}) {
    this.pendingNew = { cwd, cmd, name };
    this.switchTo(null);
  }
}
