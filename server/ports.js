'use strict';
/**
 * Dev servers on the Mac, and opening them from the phone.
 *
 * Most dev servers (Vite, Next, etc.) only listen on 127.0.0.1, which your
 * phone can't reach. "Open" starts a tiny forwarder on the Mac's Tailscale
 * address with the same port number, so http://<your-mac>:5173 on the phone
 * reaches localhost:5173 on the Mac. Raw TCP, so hot reload websockets work.
 */
const express = require('express');
const net = require('net');
const { execFile } = require('child_process');
const config = require('./config');
const netinfo = require('./netinfo');
const { HttpError, wrap } = require('./files');

const router = express.Router();
router.use(express.json());

const SYSTEM = /^(ControlCe|ControlCenter|rapportd|launchd|mDNSRespo|sharingd|remoted|identitys|AirPlayXP|WiFiAgent|screensharingd|ARDAgent|com\.apple|corespeechd|UserEventAgent|cupsd|netbiosd|Spotify|Dropbox|Adobe|Creative|figma_agent|OneDrive|GoogleDrive|zoom|Discord|Slack|tailscaled|Tailscale|IPNExtension|io\.tailscale)/i;

const forwards = new Map();   // port -> { servers: [], target }

// Every listening TCP socket on the Mac, grouped by port, leaving out
// devbox's own sockets (its web server and its forwarders).
function listListening() {
  return new Promise((ok) => {
    if (!config.bins.lsof) return ok([]);
    execFile(config.bins.lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeout: 6000, env: config.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const byPort = new Map();
      let pid = null, cmd = null;
      for (const line of (stdout || '').split('\n')) {
        const t = line[0], v = line.slice(1);
        if (t === 'p') pid = Number(v);
        else if (t === 'c') cmd = v;
        else if (t === 'n') {
          if (pid === process.pid) continue;
          const m = v.match(/^(.*):(\d+)$/);
          if (!m) continue;
          const addr = m[1].replace(/^\[|\]$/g, '');
          const port = Number(m[2]);
          if (!byPort.has(port)) byPort.set(port, { port, pid, command: cmd, addresses: new Set() });
          byPort.get(port).addresses.add(addr);
        }
      }
      ok([...byPort.values()].map((p) => ({ ...p, addresses: [...p.addresses] })));
    });
  });
}

const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.');
const isWildcard = (a) => a === '*' || a === '0.0.0.0' || a === '::';

function exposeAddresses() {
  const ts = netinfo.tailscaleIPs();
  if (ts.length) return ts;
  if (config.host && config.host !== '0.0.0.0' && config.host !== '::') return [config.host];
  if (config.host) return netinfo.lanIPv4();
  return [];
}

router.get('/', wrap(async (req, res) => {
  const list = await listListening();
  const servers = list.filter((p) => p.port !== config.port).map((p) => ({
    port: p.port,
    pid: p.pid,
    command: p.command,
    localOnly: p.addresses.every(isLoopback),
    direct: p.addresses.some((a) => !isLoopback(a)),
    forwarded: forwards.has(p.port),
    system: SYSTEM.test(p.command || '') || p.port < 1024 || p.port === config.vncPort,
  }));
  servers.sort((a, b) => (a.system - b.system) || a.port - b.port);
  res.json({ servers, canForward: exposeAddresses().length > 0 });
}));

function startForward(port, targetHost) {
  if (forwards.has(port)) return Promise.resolve(forwards.get(port));
  const addrs = exposeAddresses();
  if (!addrs.length) return Promise.reject(new HttpError(409, 'Tailscale isn\'t running on the Mac, so there\'s no address to share this on.'));
  const entry = { servers: [], addrs: [], target: targetHost };
  return Promise.all(addrs.map((addr) => new Promise((ok) => {
    const srv = net.createServer((client) => {
      const upstream = net.connect({ host: entry.target, port });
      client.pipe(upstream).pipe(client);
      const end = () => { client.destroy(); upstream.destroy(); };
      client.on('error', end); upstream.on('error', end);
    });
    srv.once('error', () => ok());          // e.g. app already listens there itself
    srv.listen(port, addr, () => { entry.servers.push(srv); entry.addrs.push(addr); ok(); });
  }))).then(() => {
    if (entry.servers.length) forwards.set(port, entry);
    return entry;
  });
}

router.post('/:port/open', wrap(async (req, res) => {
  const port = Number(req.params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === config.port) throw new HttpError(400, 'Bad port.');
  const list = await listListening();
  const p = list.find((x) => x.port === port);
  if (!p) throw new HttpError(404, `Nothing is listening on port ${port} anymore.`);
  const addrs = p.addresses;
  if (addrs.some((a) => !isLoopback(a))) return res.json({ ok: true, direct: true });
  const target = addrs.includes('127.0.0.1') ? '127.0.0.1' : addrs.includes('::1') ? '::1' : addrs[0];
  const entry = await startForward(port, target);
  res.json({ ok: true, forwarded: entry.servers.length > 0 });
}));

router.delete('/:port/open', wrap(async (req, res) => {
  const port = Number(req.params.port);
  const f = forwards.get(port);
  if (f) { f.servers.forEach((s) => s.close()); forwards.delete(port); }
  res.json({ ok: true });
}));

router.post('/:port/stop', wrap(async (req, res) => {
  const pid = Number(req.body.pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new HttpError(400, 'Bad process.');
  try { process.kill(pid, 'SIGTERM'); }
  catch (e) { throw new HttpError(e.code === 'EPERM' ? 403 : 404, e.code === 'EPERM' ? 'That process belongs to the system or another user.' : 'That process already stopped.'); }
  res.json({ ok: true });
}));

// Forwarders for apps that stopped are cleaned up periodically.
setInterval(async () => {
  if (!forwards.size) return;
  const live = new Set((await listListening()).map((p) => p.port));
  for (const [port, f] of forwards) {
    const stillThere = (await new Promise((ok) => { const s = net.connect({ host: f.target, port }); s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); }));
    if (!stillThere || !live.has(port)) { f.servers.forEach((s) => s.close()); forwards.delete(port); }
  }
}, 30000).unref();

module.exports = router;
