'use strict';
/**
 * Light screen mode: stream ONE window (or the whole screen) as small JPEG
 * frames, only when something changed, at a rate you choose — made for slow
 * or flaky connections where full live screen sharing is too heavy.
 *
 * devbox logs in to the Mac's own Screen Sharing (like the full mode), asks it
 * only for the rectangle of the chosen window, keeps a copy of those pixels,
 * and re-encodes them as JPEG at the chosen size and quality. Taps and keys go
 * back through the same Screen Sharing connection, so no extra macOS
 * permissions are needed.
 */
const net = require('net');
const express = require('express');
const jpeg = require('jpeg-js');
const { execFile } = require('child_process');
const config = require('./config');
const { loginToMac, Reader, friendly } = require('./vnc');

const QUALITY = {
  low: { maxW: 720, q: 45 },
  medium: { maxW: 1080, q: 60 },
  high: { maxW: 1600, q: 78 },
};

// ---------- window list (macOS, via JavaScript for Automation) ----------
const LIST_JXA = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
const f = $.NSScreen.mainScreen.frame;
JSON.stringify({
  display: { w: f.size.width, h: f.size.height },
  windows: list.filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 60 && w.kCGWindowBounds.Height > 40)
    .map((w) => ({ id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '',
      x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height })),
});`;

function osa(script) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut || err.message).trim()));
      resolve(out.trim());
    });
  });
}

async function listWindows() {
  if (process.env.DEVBOX_FAKE_WINDOWS) return JSON.parse(process.env.DEVBOX_FAKE_WINDOWS);
  if (process.platform !== 'darwin') return { display: null, windows: [], unsupported: true };
  const out = await osa(LIST_JXA);
  const data = JSON.parse(out);
  // Hide devbox-irrelevant system surfaces.
  data.windows = data.windows.filter((w) => !/^(Window Server|Dock|Control Center|Notification Center|SystemUIServer|Spotlight)$/.test(w.app));
  return data;
}

function activateApp(pid) {
  if (process.env.DEVBOX_FAKE_WINDOWS || process.platform !== 'darwin' || !pid) return Promise.resolve();
  return osa(`ObjC.import('AppKit'); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); if (a) a.activateWithOptions($.NSApplicationActivateIgnoringOtherApps); 'ok'`).catch(() => {});
}

const router = express.Router();
router.get('/windows', async (req, res) => {
  try { res.json(await listWindows()); }
  catch (e) { res.status(500).json({ error: 'Couldn\'t list windows: ' + e.message }); }
});

// ---------- image helpers ----------
// Crop the region out of the framebuffer (BGRX from the Mac) into RGBA,
// shrinking it with a box filter to at most maxW wide.
function cropScale(fb, fbW, region, maxW) {
  const scale = Math.min(1, maxW / region.w);
  const outW = Math.max(1, Math.round(region.w * scale));
  const outH = Math.max(1, Math.round(region.h * scale));
  const out = Buffer.alloc(outW * outH * 4);
  const step = 1 / scale;
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = region.y + Math.floor(oy * step), sy1 = Math.max(sy0 + 1, region.y + Math.floor((oy + 1) * step));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = region.x + Math.floor(ox * step), sx1 = Math.max(sx0 + 1, region.x + Math.floor((ox + 1) * step));
      let r = 0, g = 0, b = 0, n = 0;
      // Sample at most a 3x3 grid inside the box: fast and smooth enough.
      const dy = Math.max(1, Math.floor((sy1 - sy0) / 3)), dx = Math.max(1, Math.floor((sx1 - sx0) / 3));
      for (let y = sy0; y < sy1; y += dy) {
        for (let x = sx0; x < sx1; x += dx) {
          const i = (y * fbW + x) * 4;
          b += fb[i]; g += fb[i + 1]; r += fb[i + 2]; n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

const clampRegion = (r, w, h) => {
  const x = Math.max(0, Math.min(w - 1, Math.round(r.x))), y = Math.max(0, Math.min(h - 1, Math.round(r.y)));
  return { x, y, w: Math.max(1, Math.min(w - x, Math.round(r.w))), h: Math.max(1, Math.min(h - y, Math.round(r.h))) };
};

// ---------- one phone connection ----------
function handle(ws) {
  let socket = null, reader = null;
  let fb = null, fbW = 0, fbH = 0, desktopName = '';
  let target = { kind: 'screen' };
  let region = null;
  let fps = 2, quality = 'medium';
  let dirty = false, encoding = false, waitingUpdate = false, closed = false;
  let timer = null, boundsTimer = null;
  let display = null;
  let lastActivate = 0;
  let bytesSent = 0, framesSent = 0, statsAt = Date.now();

  const sendJSON = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const fail = (e) => { sendJSON(Object.assign({ type: 'error' }, friendly(e))); cleanup(); try { ws.close(4001); } catch {} };
  function cleanup() {
    closed = true;
    clearInterval(timer); clearInterval(boundsTimer);
    if (socket) socket.destroy();
  }

  // --- RFB client ---
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  function requestUpdate(incremental) {
    if (!socket || !region || closed) return;
    const b = Buffer.alloc(10);
    b[0] = 3; b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(region.x, 2); b.writeUInt16BE(region.y, 4); b.writeUInt16BE(region.w, 6); b.writeUInt16BE(region.h, 8);
    socket.write(b);
    waitingUpdate = true;
  }
  function pointer(mask, x, y) {
    const b = Buffer.alloc(6);
    b[0] = 5; b[1] = mask; b.writeUInt16BE(Math.max(0, Math.min(fbW - 1, Math.round(x))), 2); b.writeUInt16BE(Math.max(0, Math.min(fbH - 1, Math.round(y))), 4);
    socket.write(b);
  }
  function key(keysym, down) {
    const b = Buffer.alloc(8);
    b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym >>> 0, 4);
    socket.write(b);
  }

  async function readLoop() {
    try {
      for (;;) {
        const type = (await reader.read(1))[0];
        if (type === 0) {
          await reader.read(1);
          const n = (await reader.read(2)).readUInt16BE(0);
          for (let i = 0; i < n; i++) {
            const h = await reader.read(12);
            const x = h.readUInt16BE(0), y = h.readUInt16BE(2), w = h.readUInt16BE(4), hh = h.readUInt16BE(6), enc = h.readInt32BE(8);
            if (enc === 0) {
              const px = await reader.read(w * hh * 4);
              for (let row = 0; row < hh; row++) {
                if (y + row >= fbH) break;
                px.copy(fb, ((y + row) * fbW + x) * 4, row * w * 4, row * w * 4 + Math.min(w, fbW - x) * 4);
              }
            } else if (enc === 1) {
              const src = await reader.read(4);
              const sx = src.readUInt16BE(0), sy = src.readUInt16BE(2);
              const tmp = Buffer.alloc(w * hh * 4);
              for (let row = 0; row < hh; row++) fb.copy(tmp, row * w * 4, ((sy + row) * fbW + sx) * 4, ((sy + row) * fbW + sx + w) * 4);
              for (let row = 0; row < hh; row++) tmp.copy(fb, ((y + row) * fbW + x) * 4, row * w * 4, (row + 1) * w * 4);
            } else {
              throw new Error(`The Mac sent an unexpected screen encoding (${enc}).`);
            }
          }
          dirty = true;
          waitingUpdate = false;
          if (fps > 0) requestUpdate(true);          // keep listening for the next change
          else flush();                               // manual mode: send right away
        } else if (type === 1) {
          const h = await reader.read(5);
          await reader.read(h.readUInt16BE(3) * 6);
        } else if (type === 2) {
          /* bell */
        } else if (type === 3) {
          const h = await reader.read(7);
          await reader.read(h.readUInt32BE(3));
        } else {
          throw new Error(`The Mac sent an unexpected message (${type}).`);
        }
      }
    } catch (e) {
      if (!closed) fail(e);
    }
  }

  async function connect(creds) {
    socket = net.connect({ host: config.vncHost, port: config.vncPort });
    socket.setNoDelay(true);
    reader = new Reader(socket);
    await new Promise((ok, bad) => { socket.once('connect', ok); socket.once('error', bad); });
    await loginToMac(socket, reader, creds);
    socket.write(Buffer.from([1]));                    // ClientInit: shared
    const si = await reader.read(24);
    fbW = si.readUInt16BE(0); fbH = si.readUInt16BE(2);
    desktopName = (await reader.read(si.readUInt32BE(20))).toString('utf8');
    fb = Buffer.alloc(fbW * fbH * 4);
    // 32-bit little-endian true colour, shifts 16/8/0 (B,G,R,X in memory).
    socket.write(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]));
    // Encodings: Raw + CopyRect (the Mac is on the same machine, so raw is cheap).
    socket.write(Buffer.concat([Buffer.from([2, 0]), u16(2), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]));
    readLoop();
  }

  // --- what to show ---
  async function resolveRegion() {
    if (target.kind === 'screen') return { x: 0, y: 0, w: fbW, h: fbH };
    const data = await listWindows();
    display = data.display;
    const win = (data.windows || []).find((w) => w.id === target.id);
    if (!win) throw Object.assign(new Error('That window was closed or minimized.'), { code: 'window_gone' });
    target.pid = win.pid;
    target.title = win.title || win.app;
    target.app = win.app;
    const scale = display && display.w ? fbW / display.w : 1;    // points -> Screen Sharing pixels
    return clampRegion({ x: win.x * scale, y: win.y * scale, w: win.w * scale, h: win.h * scale }, fbW, fbH);
  }

  async function setTarget(t) {
    target = t.kind === 'window' ? { kind: 'window', id: Number(t.id) } : { kind: 'screen' };
    region = await resolveRegion();
    sendJSON({ type: 'meta', region, title: target.kind === 'screen' ? desktopName || 'Screen' : target.title, app: target.app || '', fbW, fbH });
    if (target.kind === 'window') activate(true);
    requestUpdate(false);
    // Follow the window if it moves or resizes.
    clearInterval(boundsTimer);
    if (target.kind === 'window') {
      boundsTimer = setInterval(async () => {
        try {
          const r = await resolveRegion();
          if (r.x !== region.x || r.y !== region.y || r.w !== region.w || r.h !== region.h) {
            region = r;
            sendJSON({ type: 'meta', region, title: target.title, app: target.app || '', fbW, fbH });
            requestUpdate(false);
          }
        } catch (e) { if (e.code === 'window_gone') sendJSON({ type: 'gone', message: e.message }); }
      }, 2500);
    }
  }

  function activate(force) {
    if (target.kind !== 'window' || !target.pid) return Promise.resolve();
    if (!force && Date.now() - lastActivate < 8000) return Promise.resolve();
    lastActivate = Date.now();
    return activateApp(target.pid);
  }

  function setRate(n) {
    fps = Math.max(0, Math.min(15, Number(n) || 0));
    clearInterval(timer);
    if (fps > 0) {
      timer = setInterval(flush, Math.round(1000 / fps));
      if (!waitingUpdate) requestUpdate(true);
    }
  }

  function flush() {
    if (!dirty || encoding || !region || ws.readyState !== 1 || ws.bufferedAmount > 512 * 1024) return;
    encoding = true;
    dirty = false;
    try {
      const q = QUALITY[quality] || QUALITY.medium;
      const img = cropScale(fb, fbW, region, q.maxW);
      const out = jpeg.encode(img, q.q).data;
      ws.send(out);
      bytesSent += out.length; framesSent += 1;
      const now = Date.now();
      if (now - statsAt > 2000) {
        sendJSON({ type: 'stats', kbps: Math.round(bytesSent / 1024 / ((now - statsAt) / 1000)), fps: +(framesSent / ((now - statsAt) / 1000)).toFixed(1), w: img.width, h: img.height });
        bytesSent = 0; framesSent = 0; statsAt = now;
      }
    } finally { encoding = false; }
  }

  const toFb = (nx, ny) => [region.x + Math.max(0, Math.min(1, nx)) * region.w, region.y + Math.max(0, Math.min(1, ny)) * region.h];
  const afterInput = () => { if (fps === 0) setTimeout(() => requestUpdate(false), 350); };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    try {
      if (m.type === 'auth') {
        await connect(m);
        sendJSON({ type: 'ready', name: desktopName, fbW, fbH });
      } else if (!socket) {
        return;
      } else if (m.type === 'view') {
        if (m.quality) quality = QUALITY[m.quality] ? m.quality : 'medium';
        if (m.fps !== undefined) setRate(m.fps);
        if (m.target) await setTarget(m.target);
        else { dirty = true; flush(); }
      } else if (m.type === 'refresh') {
        requestUpdate(false);
      } else if (m.type === 'click' && region) {
        await activate(false);
        const [x, y] = toFb(m.x, m.y);
        const btn = m.button === 'right' ? 4 : m.button === 'middle' ? 2 : 1;
        pointer(0, x, y);
        for (let i = 0; i < (m.double ? 2 : 1); i++) { pointer(btn, x, y); pointer(0, x, y); }
        afterInput();
      } else if (m.type === 'drag' && region) {
        const [x, y] = toFb(m.x, m.y);
        pointer(m.down ? 1 : 0, x, y);
        if (!m.down) afterInput();
      } else if (m.type === 'move' && region) {
        const [x, y] = toFb(m.x, m.y);
        pointer(m.buttons ? 1 : 0, x, y);
      } else if (m.type === 'scroll' && region) {
        await activate(false);
        const [x, y] = toFb(m.x, m.y);
        const steps = Math.min(15, Math.max(1, Math.round(Math.abs(m.dy))));
        const mask = m.dy < 0 ? 8 : 16;          // wheel up / down
        for (let i = 0; i < steps; i++) { pointer(mask, x, y); pointer(0, x, y); }
        afterInput();
      } else if (m.type === 'key') {
        await activate(false);
        key(m.keysym, !!m.down);
        if (!m.down) afterInput();
      }
    } catch (e) {
      if (m.type === 'auth') fail(e);
      else sendJSON(Object.assign({ type: 'error' }, friendly(e)));
    }
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

module.exports = { router, handle, listWindows };
