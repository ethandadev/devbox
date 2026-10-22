'use strict';
// Where is this Mac on the tailnet?
const os = require('os');
const { execFile } = require('child_process');
const config = require('./config');

function isTailscaleV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;     // 100.64.0.0/10
}
function isTailscaleV6(ip) { return ip.toLowerCase().startsWith('fd7a:115c:a1e0'); }

function tailscaleIPs() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' && isTailscaleV4(a.address)) out.push(a.address);
      if (a.family === 'IPv6' && isTailscaleV6(a.address)) out.push(a.address);
    }
  }
  return out;
}

function lanIPv4() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && !isTailscaleV4(a.address)).map((a) => a.address);
}

let cachedName = null;
function tailscaleName() {
  if (!config.bins.tailscale) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(config.bins.tailscale, ['status', '--json'], { timeout: 4000, env: config.env }, (err, stdout) => {
      if (err) return resolve(cachedName);
      try {
        const j = JSON.parse(stdout);
        cachedName = (j.Self && j.Self.DNSName || '').replace(/\.$/, '') || null;
      } catch {}
      resolve(cachedName);
    });
  });
}

module.exports = { tailscaleIPs, lanIPv4, tailscaleName, isTailscaleV4 };
