import { api, h, icon, store, sheet, toast, trackViewport, copyText } from './ui.js';
import { TerminalPane } from './terminal.js';
import { CodePane } from './editor.js';
import { GitPane } from './gitpane.js';
import { RunPane } from './run.js';
import { ScreenPane } from './screen.js';

const $ = (id) => document.getElementById(id);
const bootEl = $('boot'), bootMsg = $('boot-msg'), bootRetry = $('boot-retry');
const loginEl = $('login'), appEl = $('app');

let status = null;
let panes = {};
let current = null;
let started = false;

// ---------- boot ----------
async function boot() {
  bootEl.hidden = false; loginEl.hidden = true; bootRetry.hidden = true;
  bootMsg.textContent = 'Connecting to your Mac…';
  try {
    status = await api('/api/status', { timeout: 10000 });
  } catch (e) {
    if (e.status === 401) return showLogin();
    bootMsg.textContent = e.message;
    bootRetry.hidden = false;
    return;
  }
  bootEl.hidden = true;
  start();
}
bootRetry.addEventListener('click', boot);

function showLogin(message) {
  bootEl.hidden = true; appEl.hidden = true; loginEl.hidden = false;
  const err = $('login-error');
  err.hidden = !message; err.textContent = message || '';
  setTimeout(() => $('login-code').focus(), 50);
}
loginEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = loginEl.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('/api/login', { method: 'POST', json: { token: $('login-code').value.trim() } });
    loginEl.hidden = true;
    if (started) appEl.hidden = false; else boot();
  } catch (err) { showLogin(err.message); }
  finally { btn.disabled = false; }
});
window.addEventListener('devbox:unauthorized', () => showLogin('Sign in again to continue.'));

// ---------- shared "current project" ----------
// The folder you're working in. Code, Git and Run all follow it.
const project = (() => {
  const listeners = new Set();
  let value = store.get('code.workspace', '');
  return {
    get: () => value,
    set(p) {
      p = p || '';
      if (p === value) return;
      value = p;
      store.set('code.workspace', p);
      for (const fn of listeners) { try { fn(p); } catch (e) { console.error(e); } }
    },
    onChange: (fn) => listeners.add(fn),
  };
})();

// ---------- app ----------
function start() {
  started = true;
  appEl.hidden = false;
  trackViewport();
  document.title = `${status.host} · devbox`;

  const ctx = {
    status, project,
    topActions: $('top-actions'),
    setConnection,
    switchTab: (t) => select(t),
    panes: () => panes,
    setBadge: (tab, on) => { const b = $(`${tab}-badge`); if (b) b.hidden = !on; },
    setTitle,
    openSettings,
  };
  panes = {
    term: new TerminalPane($('pane-term'), ctx),
    code: new CodePane($('pane-code'), ctx),
    git: new GitPane($('pane-git'), ctx),
    run: new RunPane($('pane-run'), ctx),
    screen: new ScreenPane($('pane-screen'), ctx),
  };

  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)));
  const fromHash = location.hash.slice(1);
  select(panes[fromHash] ? fromHash : store.get('tab', 'term'));

  // Load the editor in the background so Code and Git open instantly later.
  setTimeout(() => panes.code.preload(), 600);
  setTimeout(() => panes.git.refreshBadge(), 1500);

  $('settings-btn').addEventListener('click', openSettings);
  $('title-btn').addEventListener('click', () => { const t = titles[current]; if (t && t.onClick) t.onClick(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      for (const p of Object.values(panes)) p.onResume && p.onResume();
    }
  });
}

function select(tab) {
  if (!panes[tab]) tab = 'term';
  if (current === tab) { panes[tab].onReselect && panes[tab].onReselect(); return; }
  if (current) panes[current].hide();
  current = tab;
  store.set('tab', tab);
  history.replaceState(null, '', '#' + tab);
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#top-actions > [data-for]').forEach((el) => el.classList.toggle('on', el.dataset.for === tab));
  renderTitle();
  panes[tab].show();
}

// ---------- contextual title ----------
// Each tab sets its own title and subtitle (the open file, the branch, …).
const DEFAULT_TITLES = { term: 'Terminal', code: 'Code', git: 'Git', run: 'Run', screen: 'Screen' };
const titles = {};
function setTitle(tab, t) {
  titles[tab] = t;
  if (tab === current) renderTitle();
}
function renderTitle() {
  const t = titles[current] || {};
  $('title-main').textContent = t.title || DEFAULT_TITLES[current] || 'devbox';
  $('title-sub').textContent = t.sub || (status ? status.host : '');
  $('title-chev').hidden = !t.onClick;
  $('title-btn').disabled = !t.onClick;
  $('title-btn').classList.toggle('dirty', !!t.dirty);
}

function setConnection(state) { $('conn-dot').dataset.state = state; }

// ---------- settings ----------
async function openSettings() {
  try { status = Object.assign(status, await api('/api/status')); } catch {}
  const ts = status.tailscale || {};
  const prefs = panes;
  sheet((panel, done) => {
    panel.classList.add('sheet-tall', 'settings');

    const row = (label, value, opts = {}) => h(opts.onClick ? 'button' : 'div', { class: 'set-row' + (opts.onClick ? ' tappable' : ''), type: opts.onClick ? 'button' : undefined, onclick: opts.onClick },
      opts.icon ? icon(opts.icon) : null,
      h('span', { class: 'set-label' }, label, opts.hint ? h('small', {}, opts.hint) : null),
      value instanceof Node ? value : h('span', { class: 'set-value' + (opts.state ? ` state-${opts.state}` : '') }, value ?? ''),
      opts.onClick ? icon('chevron') : null);
    const group = (title, ...rows) => h('section', { class: 'set-group' }, h('h4', {}, title), h('div', { class: 'set-card' }, ...rows));
    const stepper = (value, onChange, min, max) => {
      const out = h('span', { class: 'stepper-val' }, String(value));
      const step = (d) => { value = Math.max(min, Math.min(max, value + d)); out.textContent = String(value); onChange(value); };
      return h('span', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Smaller', onclick: () => step(-1) }, '−'), out, h('button', { type: 'button', 'aria-label': 'Larger', onclick: () => step(1) }, '+'));
    };
    const toggle = (on, onChange, id) => {
      const input = h('input', { type: 'checkbox', class: 'switch', id, 'aria-label': id });
      input.checked = !!on;
      input.addEventListener('change', () => onChange(input.checked));
      return input;
    };
    const segmented = (options, value, onChange) => {
      const wrap = h('span', { class: 'seg mini' });
      for (const [v, label] of options) {
        const b = h('button', { type: 'button', class: v === value ? 'on' : '' }, label);
        b.addEventListener('click', () => { wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onChange(v); });
        wrap.append(b);
      }
      return wrap;
    };

    const term = prefs.term, code = prefs.code;
    panel.append(
      h('div', { class: 'settings-head' }, h('h3', {}, 'Settings'), h('button', { class: 'btn small-btn', type: 'button', onclick: () => done(null) }, 'Done')),
      group('Your Mac',
        row('Mac', `${status.host}`, { hint: status.user }),
        row('Tailscale', ts.name ? ts.name.split('.')[0] : (ts.ips && ts.ips[0]) || 'Not connected', { state: ts.ips && ts.ips.length ? 'ok' : 'bad', hint: ts.ips && ts.ips[0] }),
        row('Screen Sharing', status.vnc.reachable ? 'On' : 'Off', { state: status.vnc.reachable ? 'ok' : 'bad', hint: status.vnc.reachable ? null : 'System Settings → General → Sharing' }),
        row('Keep awake', status.features.keepAwake ? 'On' : 'Off', { hint: 'Mac won\'t sleep while devbox runs' }),
        row('Files', status.rootName === '~' ? 'Home folder' : status.rootName, { hint: status.root })),
      group('Terminal',
        row('Typing', segmented([[true, 'Line'], [false, 'Live']], term.lineMode, (v) => term.setLineMode(v)), { hint: 'Line: instant, sent on Return' }),
        row('Text size', stepper(term.fontSize, (v) => term.setFontSize(v), 9, 22))),
      group('Editor',
        row('Text size', stepper(code.getFontSize(), (v) => code.setFontSize(v), 10, 24)),
        row('Word wrap', toggle(code.getWordWrap(), (v) => code.setWordWrap(v), 'Word wrap')),
        row('Minimap', toggle(code.getMinimap(), (v) => code.setMinimap(v), 'Minimap')),
        row('Format on save', toggle(store.get('code.formatOnSave', false), (v) => store.set('code.formatOnSave', v), 'Format on save'), { hint: 'Uses the language\'s formatter' })),
      status.features.clipboard ? group('Clipboard',
        row('Copy from Mac', '', { icon: 'clipboard', onClick: async () => { done(null); try { const r = await api('/api/system/clipboard'); copyText(r.text || ''); } catch (e) { toast(e.message, 'bad'); } } }),
        row('Send text to Mac', '', { icon: 'paste', onClick: () => { done(null); sendToMacClipboard(); } })) : null,
      group('devbox',
        row('Version', status.version),
        row('Update devbox', '', { icon: 'download', hint: 'Pull the latest from GitHub and restart', onClick: () => { done(null); updateDevbox(); } }),
        row('Reload app', '', { icon: 'refresh', onClick: () => location.reload() }),
        status.auth ? row('Sign out', '', { icon: 'power', onClick: async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); } }) : null),
      h('p', { class: 'set-foot' }, `Reachable only on your tailnet · ${location.host}`));
  });
}

// Pull the latest devbox from GitHub, install, and restart (pm2) in a terminal
// you can watch. The page reconnects by itself after the restart.
function updateDevbox() {
  const dir = status.appDir.replace(/'/g, "'\\''");
  const restart = status.managedByPm2
    ? 'pm2 restart devbox && echo "devbox restarted. This page reconnects in a moment."'
    : 'echo "Updated. Restart devbox (Ctrl-C in its window, then npm start) to finish."';
  const cmd = `cd '${dir}' && git pull --ff-only && npm install --no-audit --no-fund && ${restart}`;
  select('term');
  panes.term.openSession({ cmd, name: 'update devbox' });
}

export function sendToMacClipboard(then) {
  return sheet((panel, done) => {
    const ta = h('textarea', { class: 'input', placeholder: 'Type or paste text here', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    panel.append(h('h3', {}, 'Send to Mac clipboard'), ta,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          try { await api('/api/system/clipboard', { method: 'PUT', body: ta.value }); done(true); toast('On your Mac\'s clipboard'); if (then) then(); }
          catch (e) { toast(e.message, 'bad'); }
        } }, then ? 'Send and paste' : 'Send')));
  });
}
window.devboxSendToMacClipboard = sendToMacClipboard;

window.addEventListener('error', (e) => {
  if (e.message && !String(e.message).includes('ResizeObserver')) toast('Something went wrong: ' + e.message, 'bad');
});
window.addEventListener('unhandledrejection', (e) => {
  const m = e.reason && e.reason.message;
  if (m && !/Canceled|AbortError/.test(m)) toast(m, 'bad');
});

boot();
