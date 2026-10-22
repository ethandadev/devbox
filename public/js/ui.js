// Small shared helpers: API calls, bottom sheets, toasts, icons, storage.

// Let UI code write `cond ? node : null` anywhere: DOM insertion skips empty
// values instead of printing the word "null".
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['append', 'prepend', 'replaceChildren']) {
    const orig = proto[m];
    proto[m] = function (...nodes) { return orig.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false)); };
  }
}

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('devbox.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('devbox.' + key, JSON.stringify(value)); } catch {}
  },
  remove(key) { try { localStorage.removeItem('devbox.' + key); } catch {} },
};

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

// Every request: credentials via cookie, a timeout, and a readable error.
export async function api(path, { method = 'GET', json, body, headers = {}, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const opts = { method, headers: { ...headers }, signal: ctrl.signal, credentials: 'same-origin' };
  if (json !== undefined) { opts.body = JSON.stringify(json); opts.headers['Content-Type'] = 'application/json'; }
  else if (body !== undefined) { opts.body = body; opts.headers['Content-Type'] = 'text/plain;charset=utf-8'; }
  let res;
  try { res = await fetch(path, opts); }
  catch (e) {
    throw new ApiError(0, e.name === 'AbortError' ? 'Your Mac took too long to answer.' : 'Can\'t reach your Mac. Check that Tailscale is connected on this phone.');
  } finally { clearTimeout(timer); }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('devbox:unauthorized'));
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data);
  }
  return data;
}

export const qs = (o) => new URLSearchParams(o).toString();

// ---------- DOM ----------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  files: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  power: '<path d="M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/>',
  text: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  branch: '<circle cx="6" cy="5.5" r="2.2"/><circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.7v8.6M18 10.2c0 4-6 3-11 6.5"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
  sync: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  minus: '<path d="M5 12h14"/>',
  discard: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6M12 8v4.5l3 2"/>',
  folder: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

export function iconButton(name, label, onClick, extra = {}) {
  const b = h('button', { class: 'icon-btn ' + (extra.class || ''), 'aria-label': label, title: label, type: 'button' }, icon(name));
  if (onClick) b.addEventListener('click', onClick);
  if (extra.keepFocus) b.addEventListener('pointerdown', (e) => e.preventDefault());
  return b;
}

// ---------- toasts ----------
// toast('Saved') or toast('Committed', 'ok', { label: 'Push', onClick })
export function toast(message, kind = '', action = null) {
  const el = h('div', { class: 'toast ' + kind, role: 'status' }, h('span', {}, message));
  if (action) el.append(h('button', { class: 'toast-action', type: 'button', onclick: () => { el.remove(); action.onClick(); } }, action.label));
  document.getElementById('toast-root').append(el);
  setTimeout(() => el.remove(), action ? 6000 : kind === 'bad' ? 5500 : 2600);
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24); if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

export const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]; };

// A small "folder ▾" chip that shows and changes the current project.
export function projectChip(ctx, onPick) {
  const label = h('span', {});
  const chip = h('button', { class: 'chip-btn project-chip', type: 'button', 'aria-label': 'Change project' }, icon('folder'), label, icon('down'));
  const render = () => { const p = ctx.project.get(); label.textContent = p ? p.split('/').pop() : (ctx.status.rootName || '~'); chip.title = p || ctx.status.root; };
  render();
  ctx.project.onChange(render);
  chip.addEventListener('click', () => pickProject(ctx).then((p) => { if (p !== null && onPick) onPick(p); }));
  return chip;
}

export async function pickProject(ctx) {
  let repos = [];
  try { repos = (await api('/api/git/repos', { timeout: 8000 })).repos; } catch {}
  const cur = ctx.project.get();
  const choice = await menu('Project', [
    ...repos.slice(0, 30).map((r) => ({ label: r.split('/').pop(), sub: r.split('/').slice(0, -1).join('/') || (ctx.status.rootName || '~'), value: 'p:' + r, current: r === cur, icon: 'branch' })),
    { label: 'Browse folders…', value: 'browse', icon: 'folder' },
    { label: `Whole ${ctx.status.rootName === '~' ? 'home folder' : 'root folder'}`, value: 'p:', icon: 'folder', current: cur === '' },
  ]);
  if (!choice) return null;
  if (choice === 'browse') { ctx.switchTab('code'); ctx.panes().code.toggleDrawer(true); return null; }
  const p = choice.slice(2);
  ctx.project.set(p);
  return p;
}

// ---------- bottom sheets ----------
let openSheet = null;
export function sheet(build) {
  closeSheet();
  return new Promise((resolve) => {
    const root = document.getElementById('sheet-root');
    const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }));
    const scrim = h('div', { class: 'sheet-scrim' }, panel);
    const done = (value) => { if (openSheet && openSheet.scrim === scrim) { scrim.remove(); openSheet = null; } resolve(value); };
    scrim.addEventListener('click', (e) => { if (e.target === scrim) done(null); });
    build(panel, done);
    root.append(scrim);
    openSheet = { scrim, done };
    const first = panel.querySelector('input, textarea');
    if (first) setTimeout(() => { first.focus(); if (first.select && first.dataset.select !== 'no') first.select(); }, 60);
  });
}
export function closeSheet() { if (openSheet) openSheet.done(null); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openSheet) openSheet.done(null); });

export function menu(title, items) {
  return sheet((panel, done) => {
    if (title) panel.append(h('h3', {}, title));
    const list = h('div', { class: 'menu' });
    for (const it of items) {
      if (!it) continue;
      list.append(h('button', { class: (it.danger ? 'danger ' : '') + (it.current ? 'current' : ''), type: 'button', onclick: () => done(it.value) },
        it.icon ? icon(it.icon) : null, h('span', {}, it.label), it.sub ? h('span', { class: 'sub' }, it.sub) : null));
    }
    panel.append(list);
  });
}

export function prompt(title, { value = '', placeholder = '', ok = 'OK', message = '', selectStem = false } = {}) {
  return sheet((panel, done) => {
    const input = h('input', { class: 'input mono', value, placeholder, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off' });
    if (selectStem) {
      input.dataset.select = 'no';
      setTimeout(() => { const dot = value.lastIndexOf('.'); input.focus(); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 70);
    }
    const form = h('form', { class: 'field' }, input);
    form.addEventListener('submit', (e) => { e.preventDefault(); done(input.value.trim() || null); });
    panel.append(h('h3', {}, title), message ? h('p', {}, message) : null, form,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => done(input.value.trim() || null) }, ok)));
  });
}

export function confirm(title, message, { ok = 'OK', danger = false } = {}) {
  return sheet((panel, done) => {
    panel.append(h('h3', {}, title), message ? h('p', {}, message) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'button', onclick: () => done(true) }, ok)));
  }).then((v) => v === true);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); return; } catch {}
  // Plain http pages can't use the clipboard API; show it selectable instead.
  sheet((panel, done) => {
    const ta = h('textarea', { class: 'input', readonly: true }, text);
    panel.append(h('h3', {}, 'Copy'), h('p', {}, 'Press and hold to select, then Copy.'), ta,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Done')));
  });
}

// ---------- viewport that respects the phone keyboard ----------
// iOS doesn't shrink the layout when the keyboard opens; the visual viewport
// does. Size the app to the visual viewport so the key bars sit right on top
// of the keyboard and nothing hides behind it.
export function trackViewport() {
  const app = document.getElementById('app');
  const vv = window.visualViewport;
  const apply = () => {
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${height}px`);
    if (vv) app.style.transform = `translateY(${vv.offsetTop}px)`;
    const kb = vv ? window.innerHeight - vv.height > 120 : false;
    document.documentElement.classList.toggle('kb-open', kb);
    window.dispatchEvent(new Event('devbox:layout'));
  };
  if (vv) { vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply); }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  apply();
}

// A key-bar button that never steals focus (so the phone keyboard stays up).
export function key(label, onPress, { cls = '', title, repeat = false } = {}) {
  const b = h('button', { class: 'key ' + cls, type: 'button', 'aria-label': title || (typeof label === 'string' ? label : '') });
  if (typeof label === 'string') b.textContent = label; else b.append(label);
  // Fires on release, and only if the finger didn't move, so swiping the
  // scrollable bar never types anything. Held repeat keys auto-repeat.
  let timer = null, interval = null, startX = 0, startY = 0, active = false, repeated = false;
  const stop = () => { clearTimeout(timer); clearInterval(interval); timer = interval = null; };
  b.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus where it is
  b.addEventListener('pointerdown', (e) => {
    active = true; repeated = false; startX = e.clientX; startY = e.clientY;
    if (repeat) timer = setTimeout(() => { repeated = true; onPress(e); interval = setInterval(() => onPress(e), 70); }, 380);
  });
  b.addEventListener('pointermove', (e) => {
    if (active && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) { active = false; stop(); }
  });
  b.addEventListener('pointerup', (e) => {
    stop();
    if (active && !repeated) onPress(e);
    active = false;
  });
  b.addEventListener('pointercancel', () => { active = false; stop(); });
  b.addEventListener('click', (e) => e.preventDefault());
  return b;
}
