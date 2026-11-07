// XENO.IO game server (Node 18+). Accounts/leaderboards live in accounts.js.
// Only optional dependency: "pg" (used when DATABASE_URL is set).
//   node server.js            -> http://localhost:8080  (game + WebSocket on the same port)
//   PORT=3000 node server.js
//
// The server serves index.html and runs two kinds of rooms:
//  - Free-for-All: up to 16 players, one 5-minute Extinction Event, then re-queue.
//  - Open World: up to 24 players, no timer. Eight world bosses (one per environment)
//    have server-owned health; the server tracks every player's damage and pays out
//    rewards by contribution when a boss falls, then respawns it 3 minutes later.
// Server tracks players, the timer and relays bites/hits. Wildlife is simulated on
// each player's device from the room's shared seed, so every player sees the
// same map layout.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const accounts = require('./accounts');

const PORT = +process.env.PORT || 8080;
const ROUND_MS = 300 * 1000;
const ROOM_MAX = 16, OPEN_MAX = 24;
const BOSS_IDS = ['dune', 'ice', 'dark', 'hell', 'water', 'jungle', 'robo', 'space', 'heaven', 'earth', 'mars', 'mega'];
const BOSS_UNITS = 10000, BOSS_RESPAWN_MS = 300 * 1000;
const PLANETS = ['dune', 'ice', 'dark', 'water', 'jungle', 'robo', 'space', 'heaven', 'earth', 'mars'];

// ------------------------------------------------------------------ HTTP
const page = path.join(__dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  if (await accounts.handle(req, res)) return;
  if (req.url === '/' || req.url.startsWith('/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(page).pipe(res);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }));
  } else { res.writeHead(404); res.end('Not found'); }
});

// ------------------------------------------------------------------ Minimal WebSocket (RFC 6455)
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const client = { socket, buf: Buffer.alloc(0), id: null, room: null, alive: true };
  socket.on('data', d => { client.buf = Buffer.concat([client.buf, d]); readFrames(client); });
  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));
});

function readFrames(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 0x0f, masked = b1 & 0x80;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 1 << 20) return c.socket.destroy();
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let data = c.buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) { const m = c.buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
    c.buf = c.buf.subarray(need);
    if (op === 8) { c.socket.end(); return; }
    if (op === 9) { sendRaw(c, data, 0xA); continue; }
    if (op === 1) { try { onMessage(c, JSON.parse(data.toString('utf8'))); } catch (e) { /* ignore bad input */ } }
  }
}
function sendRaw(c, payload, op = 1) {
  if (c.socket.destroyed) return;
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  c.socket.write(Buffer.concat([head, payload]));
}
const send = (c, obj) => sendRaw(c, Buffer.from(JSON.stringify(obj)));

// ------------------------------------------------------------------ Rooms
const rooms = new Map();
let nextId = 1, nextRoom = 1;

function newBosses() { const b = {}; for (const id of BOSS_IDS) b[id] = { hp: BOSS_UNITS, alive: true, respawnAt: 0, dmg: new Map() }; return b; }
const respawnMs = id => id === 'mega' ? 600 * 1000 : BOSS_RESPAWN_MS;
function findRoom(mode) {
  const open = mode === 'open';
  for (const r of rooms.values()) {
    if (r.open !== open) continue;
    if (open ? r.players.size < OPEN_MAX : (r.players.size < ROOM_MAX && r.endsAt - Date.now() > 60 * 1000)) return r;
  }
  const r = { id: nextRoom++, open, planet: PLANETS[Math.floor(Math.random() * PLANETS.length)], seed: Math.floor(Math.random() * 1e9), endsAt: open ? Infinity : Date.now() + ROUND_MS, players: new Map(), bosses: open ? newBosses() : null, emptySince: 0 };
  rooms.set(r.id, r);
  console.log(`room ${r.id} opened (${open ? 'open world' : 'free-for-all on ' + r.planet})`);
  return r;
}

function onMessage(c, m) {
  if (m.t === 'join' && !c.room) {
    const r = findRoom(m.mode);
    c.id = nextId++; c.room = r;
    c.state = { id: c.id, n: String(m.name || 'Alien').slice(0, 14), al: String(m.alien || 'blipling').slice(0, 30), x: 0, y: 0, a: 0, l: 1, hp: 1, mh: 1, s: 0, alive: true, inv: false };
    r.players.set(c.id, c);
    send(c, { t: 'welcome', id: c.id, mode: r.open ? 'open' : 'ffa', planet: r.planet, seed: r.seed, left: r.open ? 0 : (r.endsAt - Date.now()) / 1000, count: r.players.size });
    return;
  }
  if (!c.room) return;
  if (m.t === 'state') {
    const s = c.state;
    s.x = +m.x || 0; s.y = +m.y || 0; s.a = +m.a || 0; s.l = Math.min(5, Math.max(1, m.l | 0));
    s.hp = +m.hp || 0; s.mh = +m.mh || 1; s.s = +m.s || 0; s.alive = !!m.alive; s.inv = !!m.inv;
    if (typeof m.al === 'string') s.al = m.al.slice(0, 30);
    s.sk = typeof m.sk === 'string' ? m.sk.slice(0, 16) : ''; s.pr = !!m.pr; s.ti = !!m.ti; s.fo = typeof m.fo === 'string' ? m.fo.slice(0, 10) : '';
  } else if (m.t === 'hit') {
    const target = c.room.players.get(m.target);
    if (!target || !c.state.alive || !target.state.alive) return;
    // sanity check: attacker must be close to the target
    const dx = target.state.x - c.state.x, dy = target.state.y - c.state.y;
    if (dx * dx + dy * dy > 500 * 500) return;
    send(target, { t: 'hurt', from: c.id, dmg: Math.min(300, Math.max(0, +m.dmg || 0)) });
  } else if (m.t === 'titanPass') {
    // a Titan was slain by another player: the killer inherits the Titan evolution
    const target = c.room.players.get(m.to); if (target && c.state.ti) { c.state.ti = false; send(target, { t: 'titanGain', from: c.state.n }); }
  } else if (m.t === 'bhit' && c.room.bosses) {
    // damage to a world boss, in boss units (the boss has BOSS_UNITS health)
    const b = c.room.bosses[m.b]; if (!b || !b.alive || !c.state.alive) return;
    const now = Date.now(); c.bhitT = c.bhitT || []; c.bhitT = c.bhitT.filter(t => now - t < 1000); if (c.bhitT.length > 20) return; c.bhitT.push(now);
    const dmg = Math.min(450, Math.max(0, +m.dmg || 0)); if (!dmg) return;
    const real = Math.min(dmg, b.hp); b.hp -= real; b.dmg.set(c.id, (b.dmg.get(c.id) || 0) + real);
    if (b.hp <= 0) bossDown(c.room, m.b, b);
  }
}

function bossDown(r, id, b) {
  b.alive = false; b.hp = 0; b.respawnAt = Date.now() + respawnMs(id);
  const total = [...b.dmg.values()].reduce((a, v) => a + v, 0) || 1;
  const ranked = [...b.dmg.entries()].sort((a, z) => z[1] - a[1]);
  ranked.forEach(([pid, d], i) => { const pc = r.players.get(pid); if (pc) send(pc, { t: 'bossDown', b: id, share: d / total, rank: i + 1, of: ranked.length }); });
  for (const pc of r.players.values()) if (!b.dmg.has(pc.id)) send(pc, { t: 'bossDown', b: id, share: 0, rank: 0, of: ranked.length });
  b.dmg = new Map();
  console.log(`room ${r.id}: ${id} boss defeated by ${ranked.length} players`);
}
function leave(c) {
  if (!c.room) return;
  c.room.players.delete(c.id);
  c.room = null;
}

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    const left = (r.endsAt - now) / 1000;
    if (left <= 0) {
      for (const c of r.players.values()) { send(c, { t: 'end' }); c.room = null; }
      rooms.delete(r.id);
      console.log(`room ${r.id} ended — extinction event`);
      continue;
    }
    if (r.players.size === 0) { if (!r.open) { rooms.delete(r.id); continue; } if (!r.emptySince) r.emptySince = now; if (now - r.emptySince > 60 * 1000) { rooms.delete(r.id); console.log(`room ${r.id} closed (empty)`); } continue; }
    r.emptySince = 0;
    const list = [...r.players.values()].map(c => c.state);
    if (r.bosses) for (const id of BOSS_IDS) { const b = r.bosses[id]; if (!b.alive && now >= b.respawnAt) { b.alive = true; b.hp = BOSS_UNITS; b.dmg = new Map(); } }
    for (const c of r.players.values()) {
      const msg = { t: 'players', list, left: r.open ? 0 : left };
      if (r.bosses) { msg.bosses = {}; for (const id of BOSS_IDS) { const b = r.bosses[id], tot = [...b.dmg.values()].reduce((a, v) => a + v, 0); msg.bosses[id] = [Math.round(b.hp), b.alive ? 1 : 0, tot ? +((b.dmg.get(c.id) || 0) / tot).toFixed(3) : 0, b.dmg.size, b.alive ? 0 : Math.ceil((b.respawnAt - now) / 1000)]; } }
      send(c, msg);
    }
  }
}, 100);

server.listen(PORT, () => console.log(`XENO.IO server on http://localhost:${PORT}`));
