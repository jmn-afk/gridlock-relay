// Gridlock City multiplayer relay.
// A tiny WebSocket relay with no dependencies (Node 18+). It knows nothing about the game: it keeps rooms by
// 4-letter code, up to 4 players each, remembers each player's latest state ("presence") for newcomers, and passes
// state on to everyone else in the room. The first player in a room is the host; when they leave, the next player
// to have joined becomes host (each client works that out from the join order the server hands out).
//
// Messages (JSON text frames):
//   client -> server  {t:'host'}                 open a new room; reply {t:'room',code,id,seq,peers:[]}
//                     {t:'join',code:'KQ7M'}     join; reply {t:'room',...} or {t:'err',e:'full'|'nosuch'|'bad'}
//                     {t:'p',p:{...}}            my latest state (max 4 KB, max ~30 per second)
//                     {t:'b',d:{...}}            broadcast to the room, not stored (world snapshots, events)
//                     {t:'ka'}                   keep-alive
//                     {t:'leave'}                leave the room
//   server -> client  {t:'join',id,seq,p}  {t:'p',id,p}  {t:'b',id,d}  {t:'leave',id}
//
// Run:  PORT=8080 node server.js        Health check: GET /health  ->  {"ok":true,"rooms":n,"players":n}
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const MAX_ROOMS = +process.env.MAX_ROOMS || 5000;
const MAX_MSG = 32 * 1024;           // world snapshots from the host can be a few KB
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Optional: comma-separated list of allowed page origins (e.g. https://www.crazygames.com). Empty = allow all.
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const rooms = new Map();   // code -> {code, seq, members: Map(id -> client)}
let nextId = 1;

function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

// ---------- minimal WebSocket (RFC 6455) ----------
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  if (ORIGINS.length && !originOk(req.headers.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return null; }
  const acceptKey = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n');
  socket.setNoDelay(true);
  return socket;
}
function originOk(o) {
  if (!o) return false;
  return ORIGINS.some(a => a === o || (a.startsWith('*.') && o.endsWith(a.slice(1))));
}
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}
function send(c, obj) {
  if (c.dead) return;
  try { c.sock.write(frame(1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))); } catch (e) { drop(c); }
}

// ---------- rooms ----------
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  c.room = null;
  r.members.delete(c.id);
  if (!r.members.size) { rooms.delete(r.code); return; }
  const msg = JSON.stringify({ t: 'leave', id: c.id });
  for (const m of r.members.values()) send(m, msg);
}
function enterRoom(c, r) {
  c.room = r; c.seq = ++r.seq; c.p = c.p || {};
  const peers = [...r.members.values()].map(m => ({ id: m.id, seq: m.seq, p: m.p }));
  r.members.set(c.id, c);
  send(c, { t: 'room', code: r.code, id: c.id, seq: c.seq, peers });
  const msg = JSON.stringify({ t: 'join', id: c.id, seq: c.seq, p: c.p });
  for (const m of r.members.values()) if (m !== c) send(m, msg);
}
function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ka') return;
  if (m.t === 'host') {
    if (c.room) leaveRoom(c);
    if (rooms.size >= MAX_ROOMS) return send(c, { t: 'err', e: 'offline' });
    const code = newCode(); if (!code) return send(c, { t: 'err', e: 'offline' });
    const r = { code, seq: 0, members: new Map() }; rooms.set(code, r); enterRoom(c, r); return;
  }
  if (m.t === 'join') {
    const code = String(m.code || '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return send(c, { t: 'err', e: 'bad' });
    const r = rooms.get(code);
    if (!r) return send(c, { t: 'err', e: 'nosuch' });
    if (r.members.size >= MAX_PLAYERS) return send(c, { t: 'err', e: 'full' });
    if (c.room) leaveRoom(c);
    enterRoom(c, r); return;
  }
  if (m.t === 'p') {
    if (!c.room || typeof m.p !== 'object' || m.p === null) return;
    const now = Date.now();                         // simple rate limit: ~30 updates a second per player
    if (now - c.win > 1000) { c.win = now; c.n = 0; }
    if (++c.n > 40) return;
    c.p = m.p;
    const msg = JSON.stringify({ t: 'p', id: c.id, p: m.p });
    for (const o of c.room.members.values()) if (o !== c) send(o, msg);
    return;
  }
  if (m.t === 'b') {
    if (!c.room || typeof m.d !== 'object' || m.d === null) return;
    const now = Date.now();
    if (now - (c.winB || 0) > 1000) { c.winB = now; c.nb = 0; }
    if (++c.nb > 40) return;
    const msg = JSON.stringify({ t: 'b', id: c.id, d: m.d });
    for (const o of c.room.members.values()) if (o !== c) send(o, msg);
    return;
  }
  if (m.t === 'leave') { leaveRoom(c); return; }
}
function drop(c) {
  if (c.dead) return; c.dead = true;
  leaveRoom(c);
  try { c.sock.destroy(); } catch (e) {}
}

// ---------- connections ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    let players = 0; for (const r of rooms.values()) players += r.members.size;
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Gridlock City relay is running.\n');
});
server.on('upgrade', (req, socket) => {
  if (!accept(req, socket)) return;
  const c = { id: (nextId++).toString(36), sock: socket, buf: Buffer.alloc(0), room: null, p: {}, win: 0, n: 0, alive: true, dead: false };
  socket.on('data', d => {
    c.alive = true;
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > MAX_MSG * 4) return drop(c);
    while (c.buf.length >= 2) {
      const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (c.buf.length < 10) return; const big = c.buf.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return drop(c); len = Number(big); off = 10; }
      if (len > MAX_MSG) return drop(c);
      if (!masked) return drop(c);                 // browsers always mask; anything else is not a browser
      if (c.buf.length < off + 4 + len) return;
      const mask = c.buf.slice(off, off + 4), data = Buffer.from(c.buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      c.buf = c.buf.slice(off + 4 + len);
      if (op === 0x8) { try { socket.write(frame(0x8, Buffer.alloc(0))); } catch (e) {} return drop(c); }
      if (op === 0x9) { try { socket.write(frame(0xA, data)); } catch (e) {} continue; }
      if (op === 0xA) continue;
      // text messages may arrive split into fragments (Render's proxy splits larger ones), so put them back together
      const fin = b0 & 0x80;
      if (op === 0x1) { if (fin) onMessage(c, data.toString('utf8')); else c.frag = [data]; continue; }
      if (op === 0x0 && c.frag) {
        c.frag.push(data);
        if (c.frag.reduce((n, b) => n + b.length, 0) > MAX_MSG) { c.frag = null; return drop(c); }
        if (fin) { const all = Buffer.concat(c.frag); c.frag = null; onMessage(c, all.toString('utf8')); }
        continue;
      }
      // binary messages are not used by the game and are ignored
    }
  });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
  socket.setTimeout(0);
  conns.add(c); socket.on('close', () => conns.delete(c));
});
// drop connections that stop answering (closed laptops, lost mobile signal), so their room slot frees up
const conns = new Set();
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { drop(c); conns.delete(c); continue; }
    c.alive = false;
    try { c.sock.write(frame(0x9, Buffer.alloc(0))); } catch (e) { drop(c); }
  }
}, 20000);
server.listen(PORT, () => console.log('Gridlock City relay listening on port ' + PORT));
