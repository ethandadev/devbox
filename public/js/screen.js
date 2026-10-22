import { api, h, icon, iconButton, key, menu, store, toast, copyText } from './ui.js';

// X11 keysyms the Mac's screen sharing understands.
const KS = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffe7, Super: 0xffeb, space: 0x20,
};
// Command is sent as both Meta and Super: different VNC servers map one or the other.
const MODS = { cmd: [KS.Super, KS.Meta], opt: [KS.Alt], ctrl: [KS.Control], shift: [KS.Shift] };
const SENTINEL = '​';
const keysymFor = (ch) => { const c = ch.codePointAt(0); return c < 0x100 ? c : 0x1000000 | c; };

export class ScreenPane {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.rfb = null;
    this.ws = null;
    this.mode = store.get('screen.mode', 'fit');   // fit | full
    this.mods = { cmd: false, opt: false, ctrl: false, shift: false };
    this.wantConnected = false;

    // top bar (only while connected)
    this.kbdBtn = iconButton('keyboard', 'Keyboard', () => this.toggleKeyboard(), { keepFocus: true });
    this.fitBtn = iconButton('fit', 'Fit / full size', () => this.toggleMode());
    this.top = h('div', { dataset: { for: 'screen' } }, this.kbdBtn, this.fitBtn,
      iconButton('more', 'Screen options', () => this.optionsMenu()));
    ctx.topActions.append(this.top);
    this.top.querySelectorAll('.icon-btn').forEach((b) => (b.hidden = true));

    this.setup = this.buildSetup();
    this.view = h('div', { class: 'screen-view', hidden: true });
    this.canvasHost = h('div');
    this.catcher = h('textarea', { class: 'kbd-catcher', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type to the Mac' });
    this.view.append(this.canvasHost, this.catcher);
    this.keybar = this.buildKeybar();
    this.keybar.hidden = true;
    el.append(this.setup, this.view, this.keybar);
    this.wireCatcher();
    ctx.setTitle('screen', { title: ctx.status.host, sub: 'Not connected' });
  }

  // ---------- setup screen ----------
  buildSetup() {
    const savedUser = store.get('screen.user') || this.ctx.status.user;
    const savedPass = store.get('screen.pass') || '';
    this.statusLine = h('div', { class: 'status-line' });
    this.userIn = h('input', { class: 'input', id: 'scr-user', value: savedUser, autocapitalize: 'off', autocorrect: 'off', autocomplete: 'username', spellcheck: 'false' });
    this.passIn = h('input', { class: 'input', id: 'scr-pass', type: 'password', value: savedPass, autocomplete: 'current-password' });
    this.remember = h('input', { type: 'checkbox', id: 'scr-remember' });
    this.remember.checked = !!savedPass;
    this.setupError = h('p', { class: 'error-text', hidden: true });
    this.connectBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Connect');

    const form = h('form', { class: 'inner' },
      h('h2', {}, `See and control ${this.ctx.status.host}`),
      h('p', {}, 'Log in with the same username and password you use on your Mac.'),
      this.statusLine,
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'scr-user' }, 'Mac username'), this.userIn),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'scr-pass' }, 'Mac password'), this.passIn),
      h('label', { class: 'check', for: 'scr-remember' }, this.remember, 'Remember the password on this phone'),
      this.setupError,
      this.connectBtn,
      h('p', {}, 'Tap to click · Two-finger tap to right-click · Two-finger drag to scroll · Press and hold, then drag, to drag things.'));
    form.addEventListener('submit', (e) => { e.preventDefault(); this.connect(); });
    this.renderStatus(this.ctx.status.vnc);
    return h('div', { class: 'screen-setup' }, form);
  }

  renderStatus(vnc) {
    const on = vnc && vnc.reachable;
    const parts = [
      h('span', { class: 'dot', dataset: { state: on ? 'online' : 'offline' } }),
      h('div', { class: 'grow' },
        h('b', {}, on ? 'Screen Sharing is on' : 'Screen Sharing is off'),
        h('small', {}, on ? 'Ready to connect.' : 'On your Mac: System Settings → General → Sharing → turn on Screen Sharing. You only do this once.')),
    ];
    if (!on) parts.push(h('button', { class: 'btn', type: 'button', onclick: () => this.recheck() }, 'Check again'));
    this.statusLine.replaceChildren(...parts);
  }

  async recheck() {
    try { const s = await api('/api/status'); this.ctx.status.vnc = s.vnc; this.renderStatus(s.vnc); }
    catch (e) { toast(e.message, 'bad'); }
  }

  showSetupError(msg) {
    this.setupError.hidden = !msg;
    this.setupError.textContent = msg || '';
  }

  // ---------- connect ----------
  async connect() {
    const username = this.userIn.value.trim();
    const password = this.passIn.value;
    if (!password) { this.showSetupError('Enter your Mac password.'); this.passIn.focus(); return; }
    store.set('screen.user', username);
    if (this.remember.checked) store.set('screen.pass', password); else store.remove('screen.pass');
    this.creds = { username, password };
    this.showSetupError(null);
    this.connectBtn.disabled = true;
    this.connectBtn.textContent = 'Connecting…';
    this.wantConnected = true;

    let RFB;
    try { RFB = (await import('/vendor/novnc.js')).default; }
    catch { this.failSetup('Could not load the screen viewer from your Mac. Reload the page and try again.'); return; }

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/screen`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); this.failSetup('Your Mac didn\'t answer in time. Check that it\'s awake and online.'); } }, 20000);

    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', username, password }));
    ws.onerror = () => {};
    ws.onclose = () => { if (!settled) { settled = true; clearTimeout(timer); this.failSetup('Lost the connection to your Mac.'); } };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'error') {
        settled = true; clearTimeout(timer);
        if (msg.code === 'bad_credentials') store.remove('screen.pass');
        if (msg.code === 'sharing_off') this.renderStatus({ reachable: false });
        this.failSetup(msg.message);
        ws.onclose = null; ws.close();
      } else if (msg.type === 'ready') {
        settled = true; clearTimeout(timer);
        ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null;
        this.startViewer(RFB, ws);
      }
    };
  }

  startViewer(RFB, ws) {
    this.canvasHost.replaceChildren();
    const rfb = new RFB(this.canvasHost, ws, { shared: true });
    this.rfb = rfb;
    ws.send(JSON.stringify({ type: 'start' }));   // viewer now owns the socket
    rfb.background = '#000';
    rfb.focusOnClick = false;
    rfb.showDotCursor = true;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    this.applyMode();

    rfb.addEventListener('connect', () => {
      this.setLive(true);
      store.set('screen.auto', true);
      this.connectBtn.disabled = false;
      this.connectBtn.textContent = 'Connect';
      if (!store.get('screen.hinted')) { toast('Tap to click · two fingers to scroll or right-click'); store.set('screen.hinted', true); }
    });
    rfb.addEventListener('disconnect', (e) => {
      const wasLive = this.isLive;
      this.rfb = null;
      this.setLive(false);
      this.connectBtn.disabled = false;
      this.connectBtn.textContent = 'Connect';
      if (this.wantConnected && wasLive && document.visibilityState === 'visible') {
        this.showSetupError('The screen connection dropped. Reconnecting…');
        setTimeout(() => this.wantConnected && !this.rfb && this.connect(), 1200);
      } else if (this.wantConnected && !e.detail.clean) {
        this.showSetupError('The screen connection dropped.');
      }
    });
    rfb.addEventListener('desktopname', (e) => { this.desktopName = e.detail.name; });
  }

  failSetup(message) {
    this.connectBtn.disabled = false;
    this.connectBtn.textContent = 'Connect';
    this.wantConnected = false;
    this.setLive(false);
    this.showSetupError(message);
  }

  disconnect() {
    this.wantConnected = false;
    store.set('screen.auto', false);
    if (this.rfb) this.rfb.disconnect();
    else if (this.ws) this.ws.close();
    this.setLive(false);
  }

  setLive(on) {
    this.isLive = on;
    this.ctx.setTitle('screen', { title: this.ctx.status.host, sub: on ? (this.desktopName ? `Connected · ${this.desktopName}` : 'Connected') : 'Not connected' });
    this.setup.hidden = on;
    this.view.hidden = !on;
    this.keybar.hidden = !on;
    this.top.querySelectorAll('.icon-btn').forEach((b) => (b.hidden = !on));
    if (on) this.showSetupError(null);
    else this.catcher.blur();
  }

  // ---------- view mode ----------
  toggleMode() {
    this.mode = this.mode === 'fit' ? 'full' : 'fit';
    store.set('screen.mode', this.mode);
    this.applyMode();
    toast(this.mode === 'fit' ? 'Fit to screen' : 'Full size — drag with two fingers to look around');
  }

  applyMode() {
    if (!this.rfb) return;
    const fit = this.mode === 'fit';
    this.rfb.scaleViewport = fit;
    this.rfb.clipViewport = !fit;
    this.rfb.dragViewport = false;
    this.fitBtn.classList.toggle('on', !fit);
  }

  async optionsMenu() {
    const clip = this.ctx.status.features.clipboard;
    const choice = await menu(this.desktopName || 'Screen', [
      clip ? { label: 'Paste text on the Mac…', value: 'paste', icon: 'paste', sub: 'fastest way to type a lot' } : null,
      clip ? { label: 'Copy the Mac\'s clipboard', value: 'getclip', icon: 'clipboard' } : null,
      { label: this.mode === 'fit' ? 'Show full size' : 'Fit to screen', value: 'mode', icon: 'fit' },
      { label: this.rfb && this.rfb.dragViewport ? 'Stop panning' : 'Pan with one finger', value: 'pan', icon: 'mouse', sub: this.mode === 'full' ? '' : 'full size only' },
      { label: this.rfb && this.rfb.viewOnly ? 'Allow control' : 'View only', value: 'view', icon: 'eye' },
      { label: 'Disconnect', value: 'off', icon: 'power', danger: true },
    ]);
    if (!choice || !this.rfb) return;
    if (choice === 'paste') window.devboxSendToMacClipboard(() => setTimeout(() => this.combo(['cmd'], keysymFor('v')), 150));
    else if (choice === 'getclip') { try { const r = await api('/api/system/clipboard'); copyText(r.text || ''); } catch (e) { toast(e.message, 'bad'); } }
    else if (choice === 'mode') this.toggleMode();
    else if (choice === 'pan') {
      if (this.mode !== 'full') { this.mode = 'full'; store.set('screen.mode', 'full'); this.applyMode(); }
      this.rfb.dragViewport = !this.rfb.dragViewport;
      toast(this.rfb.dragViewport ? 'Drag to move around. Turn panning off to click again.' : 'Panning off');
    } else if (choice === 'view') this.rfb.viewOnly = !this.rfb.viewOnly;
    else if (choice === 'off') this.disconnect();
  }

  // ---------- keyboard ----------
  toggleKeyboard() {
    if (document.activeElement === this.catcher) { this.catcher.blur(); return; }
    this.resetCatcher();
    this.catcher.focus();
  }

  resetCatcher() {
    this.catcher.value = SENTINEL;
    try { this.catcher.setSelectionRange(1, 1); } catch {}
  }

  wireCatcher() {
    const ta = this.catcher;
    let composing = false;
    ta.addEventListener('focus', () => this.kbdBtn.classList.add('on'));
    ta.addEventListener('blur', () => this.kbdBtn.classList.remove('on'));
    ta.addEventListener('compositionstart', () => { composing = true; });
    ta.addEventListener('compositionend', () => { composing = false; this.flushCatcher(); });
    ta.addEventListener('input', () => { if (!composing) this.flushCatcher(); });
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || composing) return;
      const special = { Enter: KS.Return, Escape: KS.Escape, Tab: KS.Tab, ArrowLeft: KS.Left, ArrowRight: KS.Right, ArrowUp: KS.Up, ArrowDown: KS.Down, Delete: KS.Delete, Home: KS.Home, End: KS.End, PageUp: KS.PageUp, PageDown: KS.PageDown };
      if (special[e.key]) { e.preventDefault(); this.press(special[e.key]); }
      else if (e.key === 'Backspace' && ta.value === SENTINEL) { e.preventDefault(); this.press(KS.BackSpace); }
      else if ((e.metaKey || e.ctrlKey) && e.key.length === 1) {
        // Hardware keyboard shortcuts (e.g. ⌘C on an iPad keyboard).
        e.preventDefault();
        const held = [...(e.metaKey ? MODS.cmd : []), ...(e.ctrlKey ? MODS.ctrl : []), ...(e.altKey ? MODS.opt : []), ...(e.shiftKey ? MODS.shift : [])];
        this.press(keysymFor(e.key.toLowerCase()), held);
      }
    });
  }

  flushCatcher() {
    const v = this.catcher.value;
    if (!v.startsWith(SENTINEL)) {
      // The sentinel got deleted: that was a Backspace.
      this.press(KS.BackSpace);
    } else {
      const text = v.slice(SENTINEL.length);
      for (const ch of text) {
        if (ch === '\n') this.press(KS.Return);
        else this.press(keysymFor(ch));
      }
    }
    this.resetCatcher();
  }

  // Send one key, wrapped in whichever sticky modifiers are armed.
  press(keysym, extraHeld = []) {
    if (!this.rfb) return;
    const held = [...extraHeld];
    for (const [m, on] of Object.entries(this.mods)) if (on) held.push(...MODS[m]);
    for (const k of held) this.rfb.sendKey(k, null, true);
    this.rfb.sendKey(keysym, null, true);
    this.rfb.sendKey(keysym, null, false);
    for (const k of held.reverse()) this.rfb.sendKey(k, null, false);
    if (Object.values(this.mods).some(Boolean)) this.clearMods();
  }

  combo(mods, keysym) { this.press(keysym, mods.flatMap((m) => MODS[m])); }

  clearMods() {
    for (const m of Object.keys(this.mods)) this.mods[m] = false;
    this.modKeys && Object.entries(this.modKeys).forEach(([m, b]) => b.classList.toggle('on', false));
  }

  buildKeybar() {
    const toggle = (m) => () => { this.mods[m] = !this.mods[m]; this.modKeys[m].classList.toggle('on', this.mods[m]); };
    this.modKeys = {
      cmd: key('⌘', toggle('cmd'), { cls: 'mod glyph', title: 'Command (applies to the next key)' }),
      opt: key('⌥', toggle('opt'), { cls: 'mod glyph', title: 'Option' }),
      ctrl: key('⌃', toggle('ctrl'), { cls: 'mod glyph', title: 'Control' }),
      shift: key('⇧', toggle('shift'), { cls: 'mod glyph', title: 'Shift' }),
    };
    const k = (s) => () => this.press(s);
    return h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Mac keys' },
      this.modKeys.cmd, this.modKeys.opt, this.modKeys.ctrl, this.modKeys.shift,
      h('span', { class: 'sep' }),
      key('esc', k(KS.Escape), { cls: 'mod' }),
      key('tab', k(KS.Tab), { cls: 'mod' }),
      key('⌫', k(KS.BackSpace), { cls: 'mod glyph', repeat: true, title: 'Delete' }),
      key('↵', k(KS.Return), { cls: 'mod glyph', title: 'Return' }),
      h('span', { class: 'sep' }),
      key('←', k(KS.Left), { repeat: true, title: 'Left' }),
      key('↑', k(KS.Up), { repeat: true, title: 'Up' }),
      key('↓', k(KS.Down), { repeat: true, title: 'Down' }),
      key('→', k(KS.Right), { repeat: true, title: 'Right' }),
      h('span', { class: 'sep' }),
      key('⌘Tab', () => this.combo(['cmd'], KS.Tab), { cls: 'wide', title: 'Switch apps' }),
      key('Spotlight', () => this.combo(['cmd'], KS.space), { cls: 'wide', title: 'Command-Space' }),
      key('⌘C', () => this.combo(['cmd'], keysymFor('c')), { cls: 'wide', title: 'Copy' }),
      key('⌘V', () => this.combo(['cmd'], keysymFor('v')), { cls: 'wide', title: 'Paste' }),
      key('⌘Z', () => this.combo(['cmd'], keysymFor('z')), { cls: 'wide', title: 'Undo' }),
      key('⌘W', () => this.combo(['cmd'], keysymFor('w')), { cls: 'wide', title: 'Close window' }),
      key('⌘Q', () => this.combo(['cmd'], keysymFor('q')), { cls: 'wide', title: 'Quit app' }),
    );
  }

  // ---------- pane lifecycle ----------
  show() {
    this.visible = true;
    // Auto-reconnect if a password is remembered and we were connected before.
    if (!this.rfb && store.get('screen.auto') && this.passIn.value) this.connect();
  }
  hide() { this.visible = false; this.catcher.blur(); }
  onResume() {
    if (this.visible && this.wantConnected && !this.rfb) this.connect();
  }
}
