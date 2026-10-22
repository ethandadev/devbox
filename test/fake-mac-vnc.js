const fs = require('fs');
// A fake macOS Screen Sharing server for testing: speaks RFB 3.889 like Apple,
// offers ARD (Mac username/password) and/or classic VNC password auth,
// draws a test pattern, and logs the keys/pointer events it receives.
const net = require('net');
const crypto = require('crypto');
const { DESECBCipher } = require(require('path').join(__dirname, '..', 'node_modules/@novnc/novnc/lib/crypto/des.js'));

const PORT = Number(process.env.FAKE_PORT || 5911);
const TYPES = (process.env.FAKE_TYPES || '30,2').split(',').map(Number);
const USER = 'ethan', PASS = 'correct horse', VNCPASS = 'vncpw123';
const LOG = process.env.FAKE_LOG || require('path').join(__dirname, '.run', 'fake-vnc.log');
const log = (s) => fs.appendFileSync(LOG, s + '\n');
const W = 640, H = 400;

// RFC 3526 group 2-ish small prime is fine for a test; Apple uses 128-byte keys.
const dhServer = crypto.createDiffieHellman(1024);

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let waiters = [];
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); flush(); });
  sock.on('error', () => {});
  function flush() { while (waiters.length && buf.length >= waiters[0].n) { const w = waiters.shift(); const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.r(Buffer.from(out)); } }
  const read = (n) => new Promise((r) => { waiters.push({ n, r }); flush(); });

  (async () => {
    sock.write('RFB 003.889\n');
    const v = (await read(12)).toString();
    log('client version ' + v.trim());
    sock.write(Buffer.from([TYPES.length, ...TYPES]));
    const t = (await read(1))[0];
    log('chosen type ' + t);
    let ok = false;
    if (t === 30) {
      const keyLen = 128;
      const prime = dhServer.getPrime();
      const gen = Buffer.from([0, 2]);
      const dh = crypto.createDiffieHellman(prime, Buffer.from([2]));
      const pub = dh.generateKeys();
      const pad = (b) => Buffer.concat([Buffer.alloc(keyLen - b.length), b]);
      const hdr = Buffer.alloc(4); gen.copy(hdr, 0); hdr.writeUInt16BE(keyLen, 2);
      sock.write(Buffer.concat([hdr, pad(prime), pad(pub)]));
      const enc = await read(128);
      const clientPub = await read(keyLen);
      const shared = pad(dh.computeSecret(clientPub));
      const key = crypto.createHash('md5').update(shared).digest();
      const d = crypto.createDecipheriv('aes-128-ecb', key, null); d.setAutoPadding(false);
      const plain = Buffer.concat([d.update(enc), d.final()]);
      const u = plain.subarray(0, 64).toString('utf8').split('\0')[0];
      const p = plain.subarray(64).toString('utf8').split('\0')[0];
      log(`ard user=${u} passOk=${p === PASS}`);
      ok = u === USER && p === PASS;
    } else if (t === 2) {
      const challenge = crypto.randomBytes(16);
      sock.write(challenge);
      const resp = await read(16);
      const des = DESECBCipher.importKey([...Buffer.from(VNCPASS, 'latin1').subarray(0, 8)]);
      const expect = Buffer.from(des.encrypt(null, challenge));
      ok = expect.equals(resp);
      log('vncauth ok=' + ok);
    }
    if (!ok) {
      const reason = Buffer.from('Authentication failed');
      const b = Buffer.alloc(8); b.writeUInt32BE(1, 0); b.writeUInt32BE(reason.length, 4);
      sock.end(Buffer.concat([b, reason]));
      return;
    }
    sock.write(Buffer.from([0, 0, 0, 0]));
    const shared = (await read(1))[0];
    log('clientinit shared=' + shared);
    const name = Buffer.from('Fake Mac');
    const si = Buffer.alloc(24);
    si.writeUInt16BE(W, 0); si.writeUInt16BE(H, 2);
    // pixel format: 32bpp, depth 24, LE, truecolor, max 255, shifts 16/8/0
    Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(si, 4);
    si.writeUInt32BE(name.length, 20);
    sock.write(Buffer.concat([si, name]));

    let pf = { rs: 16, gs: 8, bs: 0 };
    let frame = 0;
    const sendFrame = () => {
      frame++;
      const px = Buffer.alloc(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = (x * 255 / W) | 0, g = 120 + ((y * 100 / H) | 0), b = 60;
        const val = (r << pf.rs) | (g << pf.gs) | (b << pf.bs);
        px.writeUInt32LE(val >>> 0, i);
      }
      // a "window" block in the middle
      for (let y = 120; y < 280; y++) for (let x = 180; x < 460; x++) px.writeUInt32LE(((235 << pf.rs) | (235 << pf.gs) | (240 << pf.bs)) >>> 0, (y * W + x) * 4);
      const hdr = Buffer.alloc(16);
      hdr[0] = 0; hdr.writeUInt16BE(1, 2);
      hdr.writeUInt16BE(0, 4); hdr.writeUInt16BE(0, 6); hdr.writeUInt16BE(W, 8); hdr.writeUInt16BE(H, 10); hdr.writeInt32BE(0, 12);
      sock.write(Buffer.concat([hdr, px]));
    };
    let sentFull = false;
    for (;;) {
      const type = (await read(1))[0];
      if (type === 0) { const b = await read(19); pf = { rs: b[13], gs: b[14], bs: b[15] }; log(`setpixelformat bpp=${b[3]} shifts=${b[13]},${b[14]},${b[15]}`); }
      else if (type === 2) { const b = await read(3); const n = b.readUInt16BE(1); await read(n * 4); }
      else if (type === 3) { const b = await read(9); if (!b[0] || !sentFull) { sentFull = true; sendFrame(); } }
      else if (type === 4) { const b = await read(7); log(`key ${b[0] ? 'down' : 'up'} 0x${b.readUInt32BE(3).toString(16)}`); }
      else if (type === 5) { const b = await read(5); log(`pointer mask=${b[0]} x=${b.readUInt16BE(1)} y=${b.readUInt16BE(3)}`); }
      else if (type === 6) { const b = await read(7); await read(b.readUInt32BE(3)); }
      else if (type === 150 || type === 248 || type === 251 || type === 252 || type === 255) { log('ext msg ' + type); return sock.destroy(); }
      else { log('unknown msg ' + type); return sock.destroy(); }
    }
  })().catch((e) => log('err ' + e.message));
}).listen(PORT, '127.0.0.1', () => log(`listening ${PORT} types=${TYPES}`));
