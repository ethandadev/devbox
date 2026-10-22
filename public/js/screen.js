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
    // live = full Screen Sharing (smooth, needs a good connection)
    // light = one window or the screen as JPEG frames, for slow networks
    this.kind = store.get('screen.kind', 'live');
    this.lite = null;
    this.liteFps = store.get('screen.liteFps', 2);
    this.liteQuality = store.get('screen.liteQuality', 'medium');
    this.liteTarget = store.get('screen.liteTarget', null);
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
    this.liteImg = h('img', { class: 'lite-img', alt: '', draggable: 'false' });
    this.liteRefresh = h('button', { class: 'lite-refresh', type: 'button', 'aria-label': 'Refresh picture', hidden: true, onclick: () => this.liteSend({ type: 'refresh' }) }, icon('refresh'));
    this.liteStage = h('div', { class: 'lite-stage', hidden: true }, this.liteImg, this.liteRefresh);
    this.wireLiteInput();
    this.catcher = h('textarea', { class: 'kbd-catcher', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type to the Mac' });
    this.view.append(this.canvasHost, this.liteStage, this.catcher);
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

    this.kindSeg = h('div', { class: 'seg kind-seg' },
      h('button', { type: 'button', dataset: { kind: 'live' } }, h('b', {}, 'Live'), h('small', {}, 'Whole screen, smooth')),
      h('button', { type: 'button', dataset: { kind: 'light' } }, h('b', {}, 'Light'), h('small', {}, 'One window, low data')));
    this.kindSeg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.setKind(b.dataset.kind)));
    const form = h('form', { class: 'inner' },
      h('h2', {}, `See and control ${this.ctx.status.host}`),
      h('p', {}, 'Log in with the same username and password you use on your Mac.'),
      this.kindSeg,
      this.statusLine,
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'scr-user' }, 'Mac username'), this.userIn),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'scr-pass' }, 'Mac password'), this.passIn),
      h('label', { class: 'check', for: 'scr-remember' }, this.remember, 'Remember the password on this phone'),
      this.setupError,
      this.connectBtn,
      h('p', {}, 'Tap to click · Two-finger tap to right-click · Two-finger drag to scroll · Press and hold, then drag, to drag things.'));
    form.addEventListener('submit', (e) => { e.preventDefault(); this.connect(); });
    this.renderStatus(this.ctx.status.vnc);
    setTimeout(() => this.setKind(this.kind), 0);
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
  setKind(kind) {
    this.kind = kind === 'light' ? 'light' : 'live';
    store.set('screen.kind', this.kind);
    this.kindSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.kind === this.kind));
  }

  async connect() {
    if (this.kind === 'light') return this.connectLite();
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
    if (this.lite) { const l = this.lite; this.lite = null; l.ws.onclose = null; l.ws.close(); }
    if (this.rfb) this.rfb.disconnect();
    else if (this.ws) this.ws.close();
    this.setLive(false);
  }

  setLive(on) {
    this.isLive = on;
    this.ctx.setTitle('screen', { title: this.ctx.status.host, sub: on ? (this.desktopName ? `Connected · ${this.desktopName}` : 'Connected') : 'Not connected' });
    this.setup.hidden = on;
    this.view.hidden = !on;
    const lite = on && !!this.lite;
    this.liteStage.hidden = !lite;
    this.canvasHost.hidden = lite;
    this.fitBtn.style.display = lite ? 'none' : '';
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
    if (this.lite) return this.liteMenu();
    const clip = this.ctx.status.features.clipboard;
    const choice = await menu(this.desktopName || 'Screen', [
      clip ? { label: 'Paste text on the Mac…', value: 'paste', icon: 'paste', sub: 'fastest way to type a lot' } : null,
      clip ? { label: 'Copy the Mac\'s clipboard', value: 'getclip', icon: 'clipboard' } : null,
      { label: this.mode === 'fit' ? 'Show full size' : 'Fit to screen', value: 'mode', icon: 'fit' },
      { label: this.rfb && this.rfb.dragViewport ? 'Stop panning' : 'Pan with one finger', value: 'pan', icon: 'mouse', sub: this.mode === 'full' ? '' : 'full size only' },
      { label: this.rfb && this.rfb.viewOnly ? 'Allow control' : 'View only', value: 'view', icon: 'eye' },
      { label: 'Switch to Light mode', value: 'light', icon: 'phone', sub: 'one window, low data' },
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
    else if (choice === 'light') { this.disconnect(); this.setKind('light'); this.connect(); }
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
  keyOut(keysym, down) {
    if (this.rfb) this.rfb.sendKey(keysym, null, down);
    else if (this.lite) this.liteSend({ type: 'key', keysym, down });
  }

  press(keysym, extraHeld = []) {
    if (!this.rfb && !this.lite) return;
    const held = [...extraHeld];
    for (const [m, on] of Object.entries(this.mods)) if (on) held.push(...MODS[m]);
    for (const k of held) this.keyOut(k, true);
    this.keyOut(keysym, true);
    this.keyOut(keysym, false);
    for (const k of held.reverse()) this.keyOut(k, false);
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
    if (!this.rfb && !this.lite && store.get('screen.auto') && this.passIn.value) this.connect();
  }
  hide() { this.visible = false; this.catcher.blur(); }
  onResume() {
    if (this.visible && this.wantConnected && !this.rfb && !this.lite) this.connect();
  }

  // ---------- Light mode: one window as JPEG frames ----------
  connectLite() {
    const username = this.userIn.value.trim();
    const password = this.passIn.value;
    if (!password) { this.showSetupError('Enter your Mac password.'); this.passIn.focus(); return; }
    store.set('screen.user', username);
    if (this.remember.checked) store.set('screen.pass', password); else store.remove('screen.pass');
    this.showSetupError(null);
    this.connectBtn.disabled = true;
    this.connectBtn.textContent = 'Connecting…';
    this.wantConnected = true;

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/lite`);
    ws.binaryType = 'blob';
    const lite = { ws, meta: null, stats: null, url: null };
    let ready = false;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', username, password }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        // A new JPEG frame.
        const url = URL.createObjectURL(ev.data);
        const old = lite.url;
        lite.url = url;
        this.liteImg.onload = () => { if (old) URL.revokeObjectURL(old); };
        this.liteImg.src = url;
        return;
      }
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ready') {
        ready = true;
        this.lite = lite;
        lite.name = msg.name;
        this.setLive(true);
        store.set('screen.auto', true);
        this.connectBtn.disabled = false;
        this.connectBtn.textContent = 'Connect';
        const t = this.liteTarget;
        if (t) this.liteSend({ type: 'view', target: t, fps: this.liteFps, quality: this.liteQuality });
        else this.pickWindow(true);
        this.updateLiteTitle();
      } else if (msg.type === 'meta') { lite.meta = msg; this.updateLiteTitle(); }
      else if (msg.type === 'stats') { lite.stats = msg; this.updateLiteTitle(); }
      else if (msg.type === 'gone') { toast(msg.message); this.pickWindow(true); }
      else if (msg.type === 'error') {
        if (!ready) {
          if (msg.code === 'bad_credentials') store.remove('screen.pass');
          if (msg.code === 'sharing_off') this.renderStatus({ reachable: false });
          this.failSetup(msg.message);
        } else toast(msg.message, 'bad');
      }
    };
    ws.onclose = () => {
      if (this.lite !== lite && ready) return;
      const wasLive = ready;
      this.lite = null;
      if (lite.url) URL.revokeObjectURL(lite.url);
      if (!ready) { this.failSetup('Lost the connection to your Mac.'); return; }
      this.setLive(false);
      if (this.wantConnected && wasLive && document.visibilityState === 'visible') {
        this.showSetupError('The connection dropped. Reconnecting…');
        setTimeout(() => this.wantConnected && !this.lite && !this.rfb && this.connect(), 1200);
      }
    };
  }

  liteSend(obj) { if (this.lite && this.lite.ws.readyState === 1) this.lite.ws.send(JSON.stringify(obj)); }

  updateLiteTitle() {
    if (!this.lite) return;
    const m = this.lite.meta, st = this.lite.stats;
    const rate = this.liteFps ? `${this.liteFps} fps` : 'manual';
    const data = st ? ` · ${st.kbps} KB/s` : '';
    this.ctx.setTitle('screen', {
      title: m ? m.title : (this.lite.name || this.ctx.status.host),
      sub: `Light · ${rate}${data}`,
      onClick: () => this.pickWindow(false),
    });
    this.liteRefresh.hidden = this.liteFps !== 0;
  }

  async pickWindow(initial) {
    let data = { windows: [] };
    try { data = await api('/api/screen/windows'); } catch (e) { toast(e.message, 'bad'); }
    const wins = (data.windows || []).slice(0, 40);
    const choice = await (await import('./ui.js')).menu('Show which window?', [
      { label: 'Whole screen', value: 'screen', icon: 'desktop', current: this.liteTarget && this.liteTarget.kind === 'screen' },
      ...wins.map((w) => ({ label: w.title || w.app, sub: w.title ? `${w.app} · ${Math.round(w.w)}×${Math.round(w.h)}` : `${Math.round(w.w)}×${Math.round(w.h)}`, value: 'w:' + w.id, icon: 'window', current: this.liteTarget && this.liteTarget.id === w.id })),
    ]);
    if (!choice) { if (initial && !this.liteTarget) this.liteSelect({ kind: 'screen' }); return; }
    this.liteSelect(choice === 'screen' ? { kind: 'screen' } : { kind: 'window', id: Number(choice.slice(2)) });
  }

  liteSelect(target) {
    this.liteTarget = target;
    store.set('screen.liteTarget', target);
    this.liteSend({ type: 'view', target, fps: this.liteFps, quality: this.liteQuality });
  }

  async liteMenu() {
    const clip = this.ctx.status.features.clipboard;
    const choice = await menu('Light mode', [
      { label: 'Show another window…', value: 'pick', icon: 'window' },
      { label: 'Speed', value: 'speed', icon: 'sync', sub: this.liteFps ? `${this.liteFps} fps` : 'manual' },
      { label: 'Quality', value: 'quality', icon: 'eye', sub: this.liteQuality },
      { label: 'Refresh now', value: 'refresh', icon: 'refresh' },
      clip ? { label: 'Paste text on the Mac…', value: 'paste', icon: 'paste' } : null,
      { label: 'Switch to Live mode', value: 'live', icon: 'desktop', sub: 'smooth, needs a good connection' },
      { label: 'Disconnect', value: 'off', icon: 'power', danger: true },
    ]);
    if (choice === 'pick') this.pickWindow(false);
    else if (choice === 'speed') {
      const v = await menu('Speed', [0, 1, 2, 5, 10].map((n) => ({ label: n ? `${n} frame${n === 1 ? '' : 's'} per second` : 'Manual (tap ↻ or after each tap)', value: String(n), current: n === this.liteFps, sub: n === 0 ? 'least data' : n >= 5 ? 'more data' : '' })));
      if (v !== null) { this.liteFps = Number(v); store.set('screen.liteFps', this.liteFps); this.liteSend({ type: 'view', fps: this.liteFps }); this.updateLiteTitle(); }
    } else if (choice === 'quality') {
      const v = await menu('Quality', [['low', 'Low', 'smallest, ~720 px wide'], ['medium', 'Medium', '~1080 px wide'], ['high', 'High', 'sharp text, more data']].map(([value, label, sub]) => ({ label, value, sub, current: value === this.liteQuality })));
      if (v) { this.liteQuality = v; store.set('screen.liteQuality', v); this.liteSend({ type: 'view', quality: v }); }
    } else if (choice === 'refresh') this.liteSend({ type: 'refresh' });
    else if (choice === 'paste') window.devboxSendToMacClipboard(() => setTimeout(() => this.combo(['cmd'], keysymFor('v')), 150));
    else if (choice === 'live') { this.disconnect(); this.setKind('live'); this.connect(); }
    else if (choice === 'off') this.disconnect();
  }

  // Touch on the picture -> mouse on the Mac. Tap = click, hold = right-click,
  // drag = drag, two fingers = scroll.
  wireLiteInput() {
    const img = this.liteImg;
    const norm = (cx, cy) => {
      const r = img.getBoundingClientRect();
      const iw = img.naturalWidth || r.width, ih = img.naturalHeight || r.height;
      const scale = Math.min(r.width / iw, r.height / ih);
      const w = iw * scale, hgt = ih * scale;
      const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - hgt) / 2;
      return { x: (cx - ox) / w, y: (cy - oy) / hgt, inside: cx >= ox && cx <= ox + w && cy >= oy && cy <= oy + hgt };
    };
    let start = null, moved = false, dragging = false, holdTimer = null, lastMove = 0, scrollY = null, scrollAcc = 0, lastTouch = 0;
    img.addEventListener('touchstart', (e) => {
      lastTouch = Date.now();
      if (e.touches.length === 2) {
        clearTimeout(holdTimer); start = null;
        scrollY = (e.touches[0].clientY + e.touches[1].clientY) / 2; scrollAcc = 0;
        return;
      }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, at: Date.now() };
      moved = false; dragging = false;
      holdTimer = setTimeout(() => {
        if (start && !moved) { const p = norm(start.x, start.y); if (p.inside) this.liteSend({ type: 'click', x: p.x, y: p.y, button: 'right' }); start = null; }
      }, 550);
    }, { passive: true });
    img.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 2 && scrollY !== null) {
        const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        scrollAcc += (scrollY - y) / 28; scrollY = y;
        if (Math.abs(scrollAcc) >= 1) {
          const p = norm(e.touches[0].clientX, e.touches[0].clientY);
          this.liteSend({ type: 'scroll', x: p.x, y: p.y, dy: Math.trunc(scrollAcc) });   // fingers up = scroll down, like a trackpad
          scrollAcc -= Math.trunc(scrollAcc);
        }
        return;
      }
      if (!start) return;
      const t = e.touches[0];
      if (!moved && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) {
        moved = true; clearTimeout(holdTimer);
        const p = norm(start.x, start.y);
        this.liteSend({ type: 'drag', x: p.x, y: p.y, down: true }); dragging = true;
      }
      if (dragging && Date.now() - lastMove > 60) {
        lastMove = Date.now();
        const p = norm(t.clientX, t.clientY);
        this.liteSend({ type: 'move', x: p.x, y: p.y, buttons: 1 });
      }
    }, { passive: false });
    img.addEventListener('touchend', (e) => {
      clearTimeout(holdTimer);
      if (scrollY !== null && e.touches.length < 2) { scrollY = null; return; }
      if (!start) return;
      const t = e.changedTouches[0];
      const p = norm(t.clientX, t.clientY);
      if (dragging) this.liteSend({ type: 'drag', x: p.x, y: p.y, down: false });
      else if (!moved && p.inside) this.liteSend({ type: 'click', x: p.x, y: p.y });
      start = null;
    });
    // Mouse (desktop browsers / iPad with trackpad).
    img.addEventListener('mousedown', (e) => {
      if (Date.now() - lastTouch < 1000) return;   // the browser's copy of a tap
      const p = norm(e.clientX, e.clientY);
      if (p.inside) this.liteSend({ type: 'click', x: p.x, y: p.y, button: e.button === 2 ? 'right' : 'left' });
    });
    img.addEventListener('contextmenu', (e) => e.preventDefault());
    img.addEventListener('wheel', (e) => { e.preventDefault(); const p = norm(e.clientX, e.clientY); this.liteSend({ type: 'scroll', x: p.x, y: p.y, dy: Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40)) }); }, { passive: false });
  }
}
