'use strict';
/**
 * Screen bridge: phone <-WebSocket-> this server <-TCP-> macOS Screen Sharing.
 *
 * The server does the VNC login itself (Node has full crypto), then hands the
 * phone an already-authenticated stream. Two reasons:
 *   1. macOS's preferred login (your Mac username + password, "ARD" auth)
 *      needs browser crypto that only exists on HTTPS pages. Doing it here
 *      means plain http:// over Tailscale works.
 *   2. No separate "VNC password" to set up. Your normal Mac login works.
 *
 * Protocol on the WebSocket:
 *   phone  -> {"type":"auth","username":"...","password":"..."}   (text)
 *   server -> {"type":"ready","name":"..."} or {"type":"error",...} (text)
 *   then plain RFB bytes (binary). The server replays an RFB 3.8 handshake
 *   with "no auth" to the phone, so the viewer just works.
 */
const net = require('net');
const crypto = require('crypto');
const config = require('./config');

let DESECBCipher;
try { ({ DESECBCipher } = require('@novnc/novnc/lib/crypto/des.js')); } catch {}

const SEC_NONE = 1, SEC_VNC = 2, SEC_ARD = 30;

class Reader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._wake(); });
    socket.on('error', (e) => { this.error = e; this._wake(); });
    socket.on('close', () => { this.error = this.error || new Error('closed'); this._wake(); });
  }
  _wake() { const w = this.waiter; if (w) { this.waiter = null; w(); } }
  async read(n) {
    while (this.buf.length < n) {
      if (this.error) throw this.error;
      await new Promise((r) => { this.waiter = r; });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
  takeRest() { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
}

function friendly(err) {
  if (err.code === 'ECONNREFUSED') {
    return { code: 'sharing_off', message: 'Screen Sharing is off on your Mac. Turn it on in System Settings → General → Sharing → Screen Sharing.' };
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
    return { code: 'unreachable', message: `Couldn't reach the screen sharing service at ${config.vncHost}:${config.vncPort}.` };
  }
  return { code: err.code || 'vnc_error', message: err.message };
}

function leftPad(buf, len) {
  if (buf.length >= len) return buf.subarray(buf.length - len);
  return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
}

async function readReason(reader) {
  try {
    const len = (await reader.read(4)).readUInt32BE(0);
    return (await reader.read(Math.min(len, 4096))).toString('utf8');
  } catch { return ''; }
}

async function loginToMac(socket, reader, creds) {
  const version = (await reader.read(12)).toString('latin1');
  if (!version.startsWith('RFB ')) throw Object.assign(new Error('That port is not a screen sharing (VNC) server.'), { code: 'not_vnc' });
  socket.write('RFB 003.008\n');

  const count = (await reader.read(1))[0];
  if (count === 0) {
    const why = await readReason(reader);
    throw Object.assign(new Error(why || 'The Mac refused the connection.'), { code: 'refused' });
  }
  const types = [...(await reader.read(count))];

  const username = (creds.username || '').trim();
  const password = creds.password || '';
  let chosen;
  if (types.includes(SEC_ARD) && username) chosen = SEC_ARD;
  else if (types.includes(SEC_VNC) && password) chosen = SEC_VNC;
  else if (types.includes(SEC_NONE)) chosen = SEC_NONE;
  else if (types.includes(SEC_ARD)) throw Object.assign(new Error('Enter your Mac username and password.'), { code: 'need_credentials' });
  else throw Object.assign(new Error(`The Mac offered login methods this bridge doesn't support (${types.join(', ')}).`), { code: 'unsupported' });

  socket.write(Buffer.from([chosen]));

  if (chosen === SEC_ARD) {
    const generator = await reader.read(2);
    const keyLen = (await reader.read(2)).readUInt16BE(0);
    const prime = await reader.read(keyLen);
    const serverPub = await reader.read(keyLen);

    const dh = crypto.createDiffieHellman(prime, generator);
    const clientPub = leftPad(dh.generateKeys(), keyLen);
    const shared = leftPad(dh.computeSecret(serverPub), keyLen);
    const key = crypto.createHash('md5').update(shared).digest();

    const block = crypto.randomBytes(128);
    const u = Buffer.from(username, 'utf8').subarray(0, 63);
    const p = Buffer.from(password, 'utf8').subarray(0, 63);
    u.copy(block, 0); block[u.length] = 0;
    p.copy(block, 64); block[64 + p.length] = 0;

    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(block), cipher.final()]);
    socket.write(Buffer.concat([encrypted, clientPub]));
  } else if (chosen === SEC_VNC) {
    if (!DESECBCipher) throw new Error('VNC password login is unavailable (missing DES module).');
    const challenge = await reader.read(16);
    const keyBytes = [...Buffer.from(password, 'latin1').subarray(0, 8)];
    const des = DESECBCipher.importKey(keyBytes);
    socket.write(Buffer.from(des.encrypt(null, challenge)));
  }

  const result = (await reader.read(4)).readUInt32BE(0);
  if (result !== 0) {
    const why = await readReason(reader);
    throw Object.assign(new Error(chosen === SEC_NONE ? (why || 'Login failed.')
      : 'Wrong username or password. Use the login of a Mac account that is allowed to use Screen Sharing.'), { code: 'bad_credentials' });
  }
  return chosen;
}

function handle(ws) {
  let socket = null;
  let phase = 'await-auth';   // await-auth -> connecting -> fake-handshake -> piping
  let clientBuf = Buffer.alloc(0);
  let fakeStep = 0;           // 0: expect 12-byte version, 1: expect 1-byte type
  let started = false;
  let pendingFromMac = [];

  const authTimer = setTimeout(() => {
    if (phase === 'await-auth') { sendJSON({ type: 'error', code: 'timeout', message: 'No login received.' }); ws.close(4000); }
  }, 20000);

  function sendJSON(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function fail(err) {
    sendJSON(Object.assign({ type: 'error' }, friendly(err)));
    try { ws.close(4001, 'vnc error'); } catch {}
    if (socket) socket.destroy();
  }

  ws.on('message', async (data, isBinary) => {
    if (phase === 'await-auth') {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type !== 'auth') return;
      clearTimeout(authTimer);
      phase = 'connecting';
      socket = net.connect({ host: config.vncHost, port: config.vncPort });
      socket.setNoDelay(true);
      socket.setTimeout(10000, () => socket.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      const reader = new Reader(socket);
      try {
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        await loginToMac(socket, reader, msg);
        socket.setTimeout(0);
      } catch (e) { return fail(e); }

      // Logged in. Anything the Mac sends from now on is queued until the
      // phone's viewer finishes its (fake, no-auth) handshake with us.
      const rest = reader.takeRest();
      if (rest.length) pendingFromMac.push(rest);
      socket.removeAllListeners('data');
      socket.on('data', (d) => {
        if (phase === 'piping') { if (ws.readyState === 1) ws.send(d); }
        else pendingFromMac.push(d);
      });
      socket.on('close', () => { try { ws.close(1000, 'mac closed'); } catch {} });
      socket.on('error', () => { try { ws.close(1011, 'mac error'); } catch {} });

      phase = 'fake-handshake';
      sendJSON({ type: 'ready' });
      return;
    }

    if (!isBinary) {
      // The phone says "start" once its viewer owns the socket; only then do
      // RFB bytes begin, so none can arrive before the viewer is listening.
      if (phase === 'fake-handshake' && !started) {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'start') { started = true; ws.send(Buffer.from('RFB 003.008\n', 'latin1')); }
      }
      return;
    }

    if (phase === 'fake-handshake') {
      clientBuf = Buffer.concat([clientBuf, data]);
      if (fakeStep === 0 && clientBuf.length >= 12) {
        clientBuf = clientBuf.subarray(12);
        ws.send(Buffer.from([1, SEC_NONE]));     // one security type: None
        fakeStep = 1;
      }
      if (fakeStep === 1 && clientBuf.length >= 1) {
        clientBuf = clientBuf.subarray(1);
        ws.send(Buffer.from([0, 0, 0, 0]));      // SecurityResult: OK
        phase = 'piping';
        for (const chunk of pendingFromMac) ws.send(chunk);
        pendingFromMac = [];
        if (clientBuf.length) socket.write(clientBuf);   // ClientInit etc.
        clientBuf = Buffer.alloc(0);
      }
      return;
    }

    if (phase === 'piping' && socket && !socket.destroyed) socket.write(data);
  });

  ws.on('close', () => { clearTimeout(authTimer); if (socket) socket.destroy(); });
  ws.on('error', () => { if (socket) socket.destroy(); });
}

// Quick reachability check for the status screen.
function probe() {
  return new Promise((resolve) => {
    const s = net.connect({ host: config.vncHost, port: config.vncPort });
    const done = (ok, reason) => { s.destroy(); resolve({ reachable: ok, reason }); };
    s.setTimeout(1200, () => done(false, 'timeout'));
    s.once('connect', () => done(true));
    s.once('error', (e) => done(false, e.code));
  });
}

module.exports = { handle, probe, _loginToMac: loginToMac };
