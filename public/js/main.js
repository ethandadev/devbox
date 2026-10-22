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
  $('host-name').textContent = status.host;
  document.title = `${status.host} · devbox`;

  const ctx = {
    status, project,
    topActions: $('top-actions'),
    setConnection,
    switchTab: (t) => select(t),
    panes: () => panes,
    setBadge: (tab, on) => { const b = $(`${tab}-badge`); if (b) b.hidden = !on; },
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

  $('host-btn').addEventListener('click', showDetails);
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
  panes[tab].show();
}

function setConnection(state) { $('conn-dot').dataset.state = state; }

async function showDetails() {
  try { status = Object.assign(status, await api('/api/status')); } catch {}
  const ts = status.tailscale || {};
  sheet((panel, done) => {
    const rows = [
      ['Mac', `${status.host} (${status.user})`],
      ['Tailscale', ts.name || (ts.ips && ts.ips[0]) || 'not connected'],
      ['Shell', status.shell],
      ['Files', status.root],
      ['Screen Sharing', status.vnc.reachable ? 'On' : 'Off'],
      ['Keep awake', status.features.keepAwake ? 'On while devbox runs' : 'Off'],
      ['Search', status.features.search === 'ripgrep' ? 'ripgrep' : 'grep (brew install ripgrep for speed)'],
      ['devbox', status.version],
    ];
    const dl = h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
    const actions = h('div', { class: 'menu' });
    if (status.features.clipboard) {
      actions.append(
        h('button', { type: 'button', onclick: async () => { done(null); try { const r = await api('/api/system/clipboard'); copyText(r.text || ''); } catch (e) { toast(e.message, 'bad'); } } }, icon('clipboard'), h('span', {}, 'Copy from Mac clipboard')),
        h('button', { type: 'button', onclick: () => { done(null); sendToMacClipboard(); } }, icon('paste'), h('span', {}, 'Send text to Mac clipboard')));
    }
    actions.append(h('button', { type: 'button', onclick: () => { done(null); updateDevbox(); } }, icon('download'), h('span', {}, 'Update devbox'), h('span', { class: 'sub' }, 'git pull')));
    actions.append(h('button', { type: 'button', onclick: () => location.reload() }, icon('refresh'), h('span', {}, 'Reload devbox')));
    if (status.auth) actions.append(h('button', { type: 'button', onclick: async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); } }, icon('power'), h('span', {}, 'Sign out')));
    panel.append(h('h3', {}, status.host), dl, actions);
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
