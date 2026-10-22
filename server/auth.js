'use strict';
/**
 * Who may talk to devbox.
 *
 * Default (no access code): devbox is only reachable on your tailnet and on
 * this Mac. Two extra checks stop a *website* you visit on your phone from
 * driving devbox behind your back:
 *   - Host check: the request must be addressed to an IP, localhost, this
 *     Mac's name, or a *.ts.net name. Blocks DNS-rebinding tricks.
 *   - Origin check: anything that changes state (and every WebSocket) must
 *     come from devbox's own page, not another site.
 * Optional access code: set DEVBOX_TOKEN to also require sign-in.
 */
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const config = require('./config');

const COOKIE = 'devbox_auth';
const machine = os.hostname().toLowerCase().replace(/\.local$/, '');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

function hostAllowed(hostHeader) {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  if (net.isIP(h)) return true;
  if (h === 'localhost' || h.endsWith('.ts.net') || h.endsWith('.beta.tailscale.net')) return true;
  if (h === machine || h === machine + '.local') return true;
  if (!h.includes('.')) return true;          // MagicDNS short name, e.g. "ethans-mbp"
  return config.allowedHosts.includes(h);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                    // not a browser cross-site request
  try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); }
  catch { return false; }
}

function tokenMatches(candidate) {
  if (!config.token) return true;
  if (typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthed(req) {
  if (!config.authRequired) return true;
  return tokenMatches(parseCookies(req.headers.cookie)[COOKIE]) || tokenMatches(req.headers['x-devbox-token']);
}

function setAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(config.token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
}

// Express middleware for every request.
function guard(req, res, next) {
  if (!hostAllowed(req.headers.host)) {
    return res.status(403).type('text').send('devbox: unknown host name. Open devbox by its Tailscale name or IP address.');
  }
  const changes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (changes && !originAllowed(req)) {
    return res.status(403).json({ error: 'Blocked a request from another website.' });
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// For WebSocket upgrades.
function upgradeAllowed(req) {
  return hostAllowed(req.headers.host) && originAllowed(req) && isAuthed(req);
}

module.exports = { guard, requireAuth, upgradeAllowed, isAuthed, tokenMatches, setAuthCookie, clearAuthCookie, hostAllowed };
