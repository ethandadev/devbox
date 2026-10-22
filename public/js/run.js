import { api, qs, h, icon, iconButton, menu, confirm, toast, store, copyText, projectChip } from './ui.js';

export class RunPane {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.visible = false;
    this.showSystem = false;
    this.servers = [];

    this.top = h('div', { dataset: { for: 'run' } }, iconButton('refresh', 'Refresh', () => this.refresh()));
    ctx.topActions.append(this.top);

    this.body = h('div', { class: 'scroll-pane' });
    this.scriptsEl = h('div');
    this.serversEl = h('div', { class: 'list' });
    this.overlay = h('div', { class: 'overlay preview', hidden: true });
    this.body.append(
      h('div', { class: 'pane-bar' }, projectChip(ctx)),
      h('div', { class: 'section-head' }, h('span', {}, 'Scripts')),
      this.scriptsEl,
      h('div', { class: 'section-head' }, h('span', {}, 'Running on your Mac'), h('span', { class: 'muted small' }, 'updates live')),
      this.serversEl);
    el.append(this.body, this.overlay);

    ctx.project.onChange(() => { if (this.visible) this.loadScripts(); });
    setInterval(() => { if (document.visibilityState === 'visible' && (this.visible || !this.serversLoaded)) this.loadServers(); }, 4000);
    setTimeout(() => this.loadServers(), 2000);
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }
  onResume() { if (this.visible) this.refresh(); }
  refresh() { this.loadScripts(); this.loadServers(); }

  // ---------- scripts ----------
  async loadScripts() {
    let r;
    try { r = await api('/api/project/scripts?' + qs({ path: this.ctx.project.get() })); }
    catch (e) { this.scriptsEl.replaceChildren(h('p', { class: 'pane-msg' }, e.message)); return; }
    if (!r.groups.length) {
      this.scriptsEl.replaceChildren(h('p', { class: 'pane-msg' }, 'No package.json or Makefile in this project. Pick a project with the folder button above, or run commands in the terminal.'));
      return;
    }
    this.scriptsEl.replaceChildren(...r.groups.map((g) => h('div', { class: 'script-group' },
      h('div', { class: 'group-title' }, h('b', {}, g.title), g.file ? h('small', {}, g.dir ? `${g.dir}/${g.file}` : g.file) : null),
      g.error ? h('p', { class: 'error-text' }, g.error) : null,
      h('div', { class: 'list' }, ...g.items.map((it) => h('button', { class: 'script-row' + (it.suggested ? ' suggested' : ''), type: 'button', onclick: () => this.run(it, g) },
        h('span', { class: 'play' }, icon('play')),
        h('span', { class: 'sr-text' }, h('b', {}, it.name), h('small', {}, it.suggested ? `${it.detail} · ${it.command}` : (it.detail || it.command)))))))));
  }

  run(item, group) {
    const term = this.ctx.panes().term;
    this.ctx.switchTab('term');
    term.openSession({ cwd: item.dir !== undefined ? item.dir : group.dir, cmd: item.command, name: item.command });
    toast(`Started “${item.command}” in a new terminal`);
  }

  // ---------- servers ----------
  async loadServers() {
    let r;
    try { r = await api('/api/ports', { timeout: 8000 }); } catch { return; }
    this.serversLoaded = true;
    this.servers = r.servers;
    this.canForward = r.canForward;
    const dev = r.servers.filter((s) => !s.system);
    this.ctx.setBadge('run', dev.length > 0);
    if (this.visible) this.renderServers();
  }

  renderServers() {
    const dev = this.servers.filter((s) => !s.system);
    const sys = this.servers.filter((s) => s.system);
    const rows = [];
    if (!dev.length) rows.push(h('p', { class: 'pane-msg' }, 'No dev servers running. Start one from Scripts above or in the terminal (for example npm run dev) and it appears here.'));
    rows.push(...dev.map((s) => this.serverRow(s)));
    if (sys.length) {
      rows.push(h('button', { class: 'link-btn sys-toggle', type: 'button', onclick: () => { this.showSystem = !this.showSystem; this.renderServers(); } },
        this.showSystem ? `Hide ${sys.length} system service${sys.length === 1 ? '' : 's'}` : `Show ${sys.length} system service${sys.length === 1 ? '' : 's'}`));
      if (this.showSystem) rows.push(...sys.map((s) => this.serverRow(s)));
    }
    if (!this.canForward && dev.some((s) => s.localOnly)) rows.push(h('p', { class: 'pane-msg' }, 'Tailscale isn\'t connected on the Mac, so local-only servers can\'t be opened from here.'));
    this.serversEl.replaceChildren(...rows);
  }

  serverRow(s) {
    const reach = s.direct ? 'shared' : s.forwarded ? 'shared via devbox' : 'this Mac only';
    return h('div', { class: 'server-row' + (s.system ? ' system' : '') },
      h('span', { class: 'port' }, String(s.port)),
      h('span', { class: 'sv-text' }, h('b', {}, s.command || 'unknown'), h('small', {}, `pid ${s.pid} · ${reach}`)),
      h('button', { class: 'btn small-btn', type: 'button', onclick: () => this.preview(s) }, 'Open'),
      iconButton('more', `More for port ${s.port}`, () => this.serverMenu(s)));
  }

  async ensureReachable(s) {
    if (s.direct) return true;
    try { await api(`/api/ports/${s.port}/open`, { method: 'POST', json: {} }); return true; }
    catch (e) { toast(e.message, 'bad'); return false; }
  }

  urlFor(port, path = '/') {
    return `${location.protocol}//${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:${port}${path}`;
  }

  async serverMenu(s) {
    const choice = await menu(`Port ${s.port} · ${s.command}`, [
      { label: 'Preview here', value: 'preview', icon: 'phone' },
      { label: 'Open in a new tab', value: 'tab', icon: 'external' },
      { label: 'Copy link', value: 'copy', icon: 'copy' },
      s.forwarded ? { label: 'Stop sharing to phone', value: 'unshare', icon: 'x' } : null,
      { label: 'Stop this server', value: 'stop', icon: 'stop', danger: true, sub: `kills pid ${s.pid}` },
    ]);
    if (!choice) return;
    if (choice === 'preview') this.preview(s);
    else if (choice === 'tab') { if (await this.ensureReachable(s)) window.open(this.urlFor(s.port), '_blank', 'noopener'); }
    else if (choice === 'copy') { if (await this.ensureReachable(s)) copyText(this.urlFor(s.port)); }
    else if (choice === 'unshare') { await api(`/api/ports/${s.port}/open`, { method: 'DELETE' }).catch(() => {}); this.loadServers(); }
    else if (choice === 'stop') {
      if (!(await confirm(`Stop ${s.command} on port ${s.port}?`, 'Sends it a normal quit signal, like pressing Ctrl-C.', { ok: 'Stop', danger: true }))) return;
      try { await api(`/api/ports/${s.port}/stop`, { method: 'POST', json: { pid: s.pid } }); toast('Stopped', 'ok'); }
      catch (e) { toast(e.message, 'bad'); }
      setTimeout(() => this.loadServers(), 600);
    }
  }

  // ---------- preview ----------
  async preview(s) {
    if (!(await this.ensureReachable(s))) return;
    this.loadServers();
    let desktop = store.get('run.desktopPreview', false);
    const url = this.urlFor(s.port);
    const frame = h('iframe', { class: 'preview-frame', src: url, title: `Preview of port ${s.port}`, allow: 'clipboard-read; clipboard-write; fullscreen' });
    const stage = h('div', { class: 'preview-stage' }, frame);
    const deviceBtn = iconButton(desktop ? 'desktop' : 'phone', 'Toggle desktop width', () => { desktop = deviceBtn.classList.toggle('on'); store.set('run.desktopPreview', desktop); deviceBtn.replaceChildren(icon(desktop ? 'desktop' : 'phone')); layout(); });
    if (desktop) deviceBtn.classList.add('on');
    const layout = () => {
      // Desktop mode renders at 1280px wide and scales down to fit the phone.
      if (desktop) {
        const w = stage.clientWidth || 1, scale = w / 1280;
        Object.assign(frame.style, { width: '1280px', height: `${stage.clientHeight / scale}px`, transform: `scale(${scale})`, transformOrigin: '0 0' });
      } else Object.assign(frame.style, { width: '100%', height: '100%', transform: '', transformOrigin: '' });
    };
    this.overlay.hidden = false;
    this.overlay.replaceChildren(
      h('div', { class: 'overlay-head' },
        iconButton('x', 'Close preview', () => { this.overlay.hidden = true; this.overlay.replaceChildren(); window.removeEventListener('devbox:layout', layout); }),
        h('div', { class: 'oh-title' }, h('b', {}, `:${s.port}`), h('small', {}, s.command)),
        deviceBtn,
        iconButton('refresh', 'Reload', () => { frame.src = url; }),
        h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener', 'aria-label': 'Open in a new tab', title: 'Open in a new tab' }, icon('external'))),
      stage);
    window.addEventListener('devbox:layout', layout);
    requestAnimationFrame(layout);
  }
}
