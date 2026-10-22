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
    // Line mode: type in a box on the phone (instant, no round trip), and the
    // line is sent when you press Return. Live mode sends every key at once.
    // Full-screen programs (vim, top, less) always get live keys.
    this.lineMode = store.get('term.lineMode', true);
    this.altScreen = false;
    this.history = store.get('term.history', []);
    this.histIdx = null;
    this.draft = '';

    // top bar: the title shows this terminal's name (tap to switch terminals)
    this.top = h('div', { dataset: { for: 'term' } },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'New terminal', onclick: () => this.switchTo(null) }, icon('plus')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Terminal options', onclick: () => this.optionsMenu() }, icon('more')));
    ctx.topActions.append(this.top);

    // body
    this.host = h('div', { class: 'term-host' });
    this.notice = h('div', { class: 'overlay-msg', hidden: true });
    this.host.append(this.notice);
    el.append(this.host, this.buildCompose(), this.buildKeybar());

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
    // In line mode, tapping the terminal opens the line box, not live typing.
    if (ta) ta.addEventListener('focus', () => { if (!this.direct) setTimeout(() => this.lineInput.focus(), 0); });
    this.host.addEventListener('click', () => { if (!this.direct) this.lineInput.focus(); });

    this.term.onData((d) => this.input(d));
    this.term.buffer.onBufferChange((buf) => {
      this.altScreen = buf.type === 'alternate';
      this.applyMode();
    });
    this.applyMode();

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
        this.ctx.setTitle('term', { title: msg.name, sub: `${this.ctx.status.user}@${this.ctx.status.host}`, onClick: () => this.sessionMenu() });
        this.ctx.setConnection('online');
        this.showNotice(null);
        this.sendResize();
      } else if (msg.type === 'data') {
        this.term.write(msg.data, () => this.checkPrompt());
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

  get direct() { return !this.lineMode || this.altScreen; }

  // Bytes straight to the shell, no modifiers applied.
  raw(d) {
    if (this.exited) { this.exited = false; this.term.reset(); this.connect(); return; }
    if (!this.send({ type: 'input', data: d })) toast('Not connected yet. Try again in a moment.');
  }

  // Live typing (xterm) and the key bar in live mode.
  input(d) {
    if (this.exited) { this.exited = false; this.term.reset(); this.connect(); return; }
    if (!this.direct) { this.send({ type: 'input', data: d }); return; }   // automatic terminal replies
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
    if (!this.send({ type: 'input', data: d })) toast('Not connected yet. Try again in a moment.');
  }

  // ---------- line mode ----------
  buildCompose() {
    this.lineInput = h('input', {
      class: 'line-input', type: 'text', id: 'term-line', 'aria-label': 'Command to send', placeholder: 'Type a command',
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send',
    });
    const sendBtn = h('button', { class: 'send-btn', type: 'submit', 'aria-label': 'Send' }, icon('play'));
    sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.compose = h('form', { class: 'compose' }, h('span', { class: 'prompt', 'aria-hidden': 'true' }, '›'), this.lineInput, sendBtn);
    this.compose.addEventListener('submit', (e) => { e.preventDefault(); this.submitLine(); this.lineInput.focus(); });

    const li = this.lineInput;
    li.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Backspace' && li.value === '') { e.preventDefault(); this.raw('\x7f'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.historyStep(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.historyStep(1); }
      else if (e.key === 'Tab') { e.preventDefault(); this.flush('\t'); }
      else if (e.key === 'Escape') { e.preventDefault(); this.flush('\x1b'); }
      else if (e.ctrlKey && e.key.length === 1) { e.preventDefault(); this.ctrlChar(e.key); }
    });
    // Sticky ctrl/alt from the key bar apply to the next letter typed here.
    li.addEventListener('beforeinput', (e) => {
      if (!(this.ctrl || this.alt) || e.inputType !== 'insertText' || !e.data) return;
      e.preventDefault();
      if (this.ctrl) this.ctrlChar(e.data[0]);
      else { this.setMod('alt', false); this.flush('\x1b' + e.data); }
    });
    return this.compose;
  }

  // Send what's in the box plus a special key (Tab, Esc, Ctrl-…), so the
  // shell can complete or act on it. Typing then continues in the box.
  flush(seq) {
    const t = this.lineInput.value;
    this.lineInput.value = '';
    this.histIdx = null;
    this.raw(t + seq);
  }

  ctrlChar(ch) {
    this.setMod('ctrl', false);
    const c = ch.toUpperCase().charCodeAt(0);
    const seq = c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : ch === ' ' ? '\x00' : null;
    if (!seq) return;
    if (seq === '\x03') { this.lineInput.value = ''; this.histIdx = null; this.raw(seq); }   // ^C discards the line, like a shell
    else this.flush(seq);
  }

  submitLine() {
    const t = this.lineInput.value;
    const secret = this.lineInput.type === 'password';
    if (t.trim() && !secret && this.history[this.history.length - 1] !== t) {
      this.history.push(t);
      if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
      store.set('term.history', this.history);
    }
    this.lineInput.value = '';
    this.histIdx = null;
    this.raw(t + '\r');
    this.term.scrollToBottom();
  }

  historyStep(dir) {
    const li = this.lineInput;
    if (!this.history.length) {
      // Nothing typed here yet: fall back to the shell's own history.
      const app = this.term.modes && this.term.modes.applicationCursorKeysMode;
      this.raw((app ? '\x1bO' : '\x1b[') + (dir < 0 ? 'A' : 'B'));
      return;
    }
    if (dir < 0) {
      if (this.histIdx === null) { this.draft = li.value; this.histIdx = this.history.length - 1; }
      else this.histIdx = Math.max(0, this.histIdx - 1);
      li.value = this.history[this.histIdx];
    } else {
      if (this.histIdx === null) return;
      this.histIdx += 1;
      if (this.histIdx >= this.history.length) { this.histIdx = null; li.value = this.draft; }
      else li.value = this.history[this.histIdx];
    }
    const end = li.value.length;
    try { li.setSelectionRange(end, end); } catch {}
  }

  insertText(text) {
    const li = this.lineInput;
    const start = li.selectionStart ?? li.value.length, end = li.selectionEnd ?? li.value.length;
    li.setRangeText(text, start, end, 'end');
    li.focus();
  }

  moveCaret(dir) {
    const li = this.lineInput;
    const pos = Math.max(0, Math.min(li.value.length, (li.selectionStart ?? li.value.length) + dir));
    li.focus();
    li.setSelectionRange(pos, pos);
  }

  // Password prompts: hide what you type and keep it out of history.
  checkPrompt() {
    if (this.direct) return;
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY);
    const text = line ? line.translateToString(true) : '';
    const secret = /(password|passphrase|passcode)[^:\n]*:\s*$/i.test(text) || /^\[sudo\]/i.test(text.trim());
    const type = secret ? 'password' : 'text';
    if (this.lineInput.type !== type) {
      this.lineInput.type = type;
      this.lineInput.placeholder = secret ? 'Password (hidden)' : 'Type a command';
    }
  }

  applyMode() {
    const direct = this.direct;
    this.compose.hidden = direct;
    if (this.modeKey) {
      this.modeKey.textContent = this.altScreen ? 'app' : this.lineMode ? 'line' : 'live';
      this.modeKey.classList.toggle('on', !direct);
    }
    if (direct && document.activeElement === this.lineInput) this.term.focus();
    if (!direct && document.activeElement === this.term.textarea) this.lineInput.focus();
    this.scheduleFit();
  }

  setLineMode(on) {
    this.lineMode = on;
    store.set('term.lineMode', on);
    this.applyMode();
    this.focusInput();
    toast(on ? 'Line mode: type instantly, sent when you press Return' : 'Live mode: every key goes straight to the Mac');
  }

  setFontSize(n) {
    this.fontSize = Math.max(9, Math.min(22, n));
    store.set('term.fontSize', this.fontSize);
    this.term.options.fontSize = this.fontSize;
    this.scheduleFit();
  }

  focusInput() { if (this.direct) this.term.focus(); else this.lineInput.focus(); }

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
    const seqArrow = (dir) => {
      const app = this.term.modes && this.term.modes.applicationCursorKeysMode;
      return (app ? '\x1bO' : '\x1b[') + dir;
    };
    // Each key does the right thing in both modes.
    const special = (seq) => () => (this.direct ? this.input(seq) : this.flush(seq));
    const arrow = (dir) => () => {
      if (this.direct) return this.input(seqArrow(dir));
      if (dir === 'A' || dir === 'B') return this.historyStep(dir === 'A' ? -1 : 1);
      if (this.lineInput.value) return this.moveCaret(dir === 'D' ? -1 : 1);
      this.raw(seqArrow(dir));
    };
    const char = (c) => () => (this.direct ? this.input(c) : this.insertText(c));
    const interrupt = () => {
      if (this.direct) return this.input('\x03');
      this.lineInput.value = ''; this.histIdx = null; this.raw('\x03');
    };
    this.modeKey = key('line', () => this.setLineMode(!this.lineMode), { cls: 'mod mode-key', title: 'Switch between line typing (instant) and live typing' });
    this.ctrlKey = key('ctrl', () => { this.setMod('ctrl', !this.ctrl); if (!this.direct) this.lineInput.focus(); }, { cls: 'mod' });
    this.altKey = key('alt', () => { this.setMod('alt', !this.alt); if (!this.direct) this.lineInput.focus(); }, { cls: 'mod' });
    return h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Extra keys' },
      this.modeKey,
      key('esc', special('\x1b'), { cls: 'mod' }),
      key('tab', special('\t'), { cls: 'mod' }),
      this.ctrlKey,
      this.altKey,
      key('^C', interrupt, { cls: 'mod', title: 'Control-C' }),
      h('span', { class: 'sep' }),
      key('←', arrow('D'), { repeat: true, title: 'Left' }),
      key('↑', arrow('A'), { repeat: true, title: 'Up (history)' }),
      key('↓', arrow('B'), { repeat: true, title: 'Down (history)' }),
      key('→', arrow('C'), { repeat: true, title: 'Right' }),
      h('span', { class: 'sep' }),
      ...['/', '-', '|', '~', '_', '*', '&', '>', '$', '`'].map((c) => key(c, char(c))),
      h('span', { class: 'sep' }),
      key('^D', special('\x04'), { cls: 'mod', title: 'Control-D' }),
      key('^Z', special('\x1a'), { cls: 'mod', title: 'Control-Z' }),
      key('^R', special('\x12'), { cls: 'mod', title: 'Control-R (search history)' }),
      key('^L', special('\x0c'), { cls: 'mod', title: 'Control-L (clear)' }),
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
    this.focusInput();
  }

  async optionsMenu() {
    const choice = await menu('Terminal', [
      this.lineMode
        ? { label: 'Switch to live typing', value: 'live', icon: 'keyboard', sub: 'every key sent at once' }
        : { label: 'Switch to line typing', value: 'line', icon: 'keyboard', sub: 'instant, sent on Return' },
      { label: 'Paste text…', value: 'paste', icon: 'paste' },
      { label: 'Copy visible output', value: 'copy', icon: 'copy' },
      { label: 'Larger text', value: 'bigger', icon: 'text', sub: `${this.fontSize}px` },
      { label: 'Smaller text', value: 'smaller', icon: 'text' },
      { label: 'Clear screen', value: 'clear', icon: 'x' },
    ]);
    if (choice === 'live' || choice === 'line') this.setLineMode(choice === 'line');
    else if (choice === 'paste') this.pasteSheet();
    else if (choice === 'copy') copyText(this.visibleText());
    else if (choice === 'bigger' || choice === 'smaller') {
      this.setFontSize(this.fontSize + (choice === 'bigger' ? 1 : -1));
    } else if (choice === 'clear') { this.term.clear(); this.raw('\x0c'); }
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
            this.raw(text + (runIt.checked ? '\r' : ''));
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
  onReselect() { this.focusInput(); }

  // Used by the editor: "Open in terminal".
  runCommand(cmd) {
    this.raw(cmd + '\r');
  }

  // Used by "Run this file": reuse one terminal per file, so runs don't pile up.
  async runInNamedSession(name, cwd, cmd) {
    try {
      const list = await api('/api/terminals');
      for (const t of list) if (t.name === name) await api('/api/terminals/' + t.id, { method: 'DELETE' }).catch(() => {});
    } catch {}
    this.openSession({ cwd, cmd, name });
  }

  // Used by Run: a fresh terminal in a folder, running a command.
  openSession({ cwd = '', cmd = '', name = '' } = {}) {
    this.pendingNew = { cwd, cmd, name };
    this.switchTo(null);
  }
}
