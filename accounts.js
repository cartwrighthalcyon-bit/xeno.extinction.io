// XENO.IO accounts: Google sign-in, cloud saves and leaderboards.
//
// Environment variables (set them in Render -> your service -> Environment):
//   GOOGLE_CLIENT_ID  OAuth "Web application" client ID from Google Cloud Console (required for sign-in)
//   SESSION_SECRET    any long random text; keeps players signed in across server restarts
//   DATABASE_URL      Postgres connection string (Neon / Supabase). Without it, data goes to
//                     data/players.json, which Render's free plan wipes on every restart/deploy.
//   DEV_LOGIN=1       local testing only: allows sign-in without Google. Never set this online.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
// Stripe payments: set STRIPE_SECRET_KEY (sk_test_... or sk_live_...) on the server. STRIPE_WEBHOOK_SECRET (whsec_...) is optional but recommended.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '', STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || '';
console.log('[pay] payments ' + (STRIPE_KEY ? 'ON (' + (STRIPE_KEY.startsWith('sk_live') || STRIPE_KEY.startsWith('rk_live') ? 'live' : 'test') + ' mode)' + (STRIPE_WH ? ', webhook signed' : '') : 'OFF: set STRIPE_SECRET_KEY to turn them on'));
// Ads: ADSENSE_CLIENT = your AdSense publisher id (ca-pub-...). ADSENSE_TEST=1 shows test ads while you wait for approval.
const ADS_CLIENT = /^ca-pub-\d{6,20}$/.test(process.env.ADSENSE_CLIENT || '') ? process.env.ADSENSE_CLIENT : '';
const CATALOG = (() => { try { return require('./catalog.json'); } catch (e) { return { packs: [], aliens: [] }; } })();
const PREMIUM_IDS = new Set([...CATALOG.aliens.map(a => a.id), ...Object.values(CATALOG.codes || {})]); // paid or code-only: kept only by accounts entitled to them
function catalogItem(item) {
  const [type, id] = String(item || '').split(':');
  if (type === 'pack') { const p = CATALOG.packs.find(x => x.id === id); return p && { key: 'pack:' + p.id, name: p.name, cents: p.cents, grant: { type: 'pack', cur: p.cur, n: p.n } }; }
  if (type === 'alien') { const a = CATALOG.aliens.find(x => x.id === id); return a && { key: 'alien:' + a.id, name: a.name, cents: a.cents, grant: { type: 'alien', id: a.id } }; }
  return null;
}
async function stripe(method, pathName, form) {
  const r = await fetch((process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1/') + pathName, { method, headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form ? new URLSearchParams(form).toString() : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Payment provider error');
  return j;
}
function verifyStripeSig(raw, header) {
  if (!STRIPE_WH) return false;
  const parts = Object.fromEntries(String(header || '').split(',').map(kv => kv.split('=')).filter(x => x.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header || '').split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3)), t = +parts.t;
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac('sha256', STRIPE_WH).update(t + '.' + raw).digest('hex');
  return sigs.some(v => v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
}
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[accounts] SESSION_SECRET not set: players will be signed out whenever the server restarts.');
}
const BOARD_FIELDS = ['best', 'kills', 'wins', 'collected', 'onlineBest', 'openBest'];

// ------------------------------------------------------------------ storage
function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'players.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new file */ }
  const rfile = path.join(path.dirname(file), 'reports.json');
  let timer = null;
  const flush = () => { timer = null; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); };
  console.log('[accounts] storage: file ' + file + (process.env.RENDER ? '  (WARNING: wiped on every Render restart, set DATABASE_URL)' : ''));
  return {
    kind: 'file',
    async get(id) { return db[id] || null; },
    async put(id, rec) { db[id] = rec; if (!timer) timer = setTimeout(flush, 1000); },
    async top(field, n) { return Object.values(db).filter(r => (r.stats && r.stats[field]) > 0).sort((a, b) => b.stats[field] - a.stats[field]).slice(0, n); },
    async rank(field, value) { return 1 + Object.values(db).filter(r => (r.stats && r.stats[field] || 0) > value).length; },
    async byCode(code) { return Object.values(db).find(r => r.code === code) || null; },
    async addReport(r) { let list = []; try { list = JSON.parse(fs.readFileSync(rfile, 'utf8')); } catch (e) { /* first report */ } list.push(r); if (list.length > 2000) list = list.slice(-2000); fs.mkdirSync(path.dirname(rfile), { recursive: true }); fs.writeFileSync(rfile, JSON.stringify(list)); },
    async listReports(n) { try { return JSON.parse(fs.readFileSync(rfile, 'utf8')).slice(-n).reverse(); } catch (e) { return []; } },
  };
}
function pgStore(url) {
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) { throw new Error('DATABASE_URL is set but the "pg" package is missing. Make sure the build command is "npm install".'); }
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 5 });
  const ready = pool.query('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())').then(() => pool.query('CREATE TABLE IF NOT EXISTS reports (id SERIAL PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())'));
  ready.then(() => console.log('[accounts] storage: Postgres ready')).catch(e => console.error('[accounts] Postgres error:', e.message));
  const num = f => `COALESCE((data->'stats'->>'${f}')::numeric, 0)`;
  return {
    kind: 'postgres',
    async get(id) { await ready; const r = await pool.query('SELECT data FROM players WHERE id = $1', [id]); return r.rows[0] ? r.rows[0].data : null; },
    async put(id, rec) { await ready; await pool.query('INSERT INTO players (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [id, rec]); },
    async top(field, n) { if (!BOARD_FIELDS.includes(field)) return []; await ready; const r = await pool.query(`SELECT data FROM players WHERE ${num(field)} > 0 ORDER BY ${num(field)} DESC LIMIT $1`, [n]); return r.rows.map(x => x.data); },
    async rank(field, value) { if (!BOARD_FIELDS.includes(field)) return 0; await ready; const r = await pool.query(`SELECT COUNT(*)::int AS c FROM players WHERE ${num(field)} > $1`, [value]); return 1 + r.rows[0].c; },
    async byCode(code) { await ready; const r = await pool.query("SELECT data FROM players WHERE data->>'code' = $1 LIMIT 1", [code]); return r.rows[0] ? r.rows[0].data : null; },
    async addReport(rep) { await ready; await pool.query('INSERT INTO reports (data) VALUES ($1)', [rep]); },
    async listReports(n) { await ready; const r = await pool.query('SELECT data FROM reports ORDER BY id DESC LIMIT $1', [n]); return r.rows.map(x => x.data); },
  };
}
const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore();

// ------------------------------------------------------------------ Google ID token verification
let jwksCache = null, jwksAt = 0;
async function getJwks(force) {
  if (process.env.GOOGLE_JWKS_FILE) return JSON.parse(fs.readFileSync(process.env.GOOGLE_JWKS_FILE, 'utf8'));
  if (!force && jwksCache && Date.now() - jwksAt < 3600e3) return jwksCache;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('Could not download Google keys');
  jwksCache = await r.json(); jwksAt = Date.now();
  return jwksCache;
}
const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
async function verifyGoogle(idToken) {
  if (!CLIENT_ID) throw new Error('Google sign-in is not configured on this server');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, sig] = parts, header = b64json(h), payload = b64json(p);
  if (header.alg !== 'RS256') throw new Error('Unexpected algorithm');
  let jwk = (await getJwks()).keys.find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getJwks(true)).keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const ok = crypto.verify('sha256', Buffer.from(h + '.' + p), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('Bad signature');
  if (payload.aud !== CLIENT_ID) throw new Error('Token is for a different app');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('Bad issuer');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('Token expired');
  if (!payload.sub) throw new Error('No user id');
  return payload;
}

// ------------------------------------------------------------------ sessions (signed tokens, 30 days)
function sign(obj) { const body = Buffer.from(JSON.stringify(obj)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); }
function readToken(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const [body, mac] = m[1].split('.'); if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}

// ------------------------------------------------------------------ validation
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
const ChatFilter = require('./chatfilter');
const cleanName = s => ChatFilter.clean(String(s || '').replace(/[<>&"'`\u0000-\u001f]/g, ''), 14).replace(/\*+/g, '').trim().slice(0, 14);
function cleanSave(s) {
  if (!s || typeof s !== 'object') return null;
  const tokens = {};
  if (s.tokens && typeof s.tokens === 'object') for (const k of Object.keys(s.tokens).slice(0, 20)) tokens[String(k).slice(0, 40)] = int(s.tokens[k], 1e6);
  const owned = Array.isArray(s.owned) ? [...new Set(s.owned.filter(x => typeof x === 'string' && /^[a-z0-9]{1,40}$/.test(x)))].slice(0, 800) : [];
  const st = s.stats || {};
  const numMap = (o, maxKeys, max) => { const r = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(0, maxKeys)) if (/^[a-z0-9_]{1,40}$/i.test(k)) r[k] = int(o[k], max); return r; };
  const flagMap = (o, maxKeys) => { const r = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(0, maxKeys)) if (/^[a-z0-9]{1,40}$/.test(k)) r[k] = !!o[k]; return r; };
  const skins = {}; if (s.skins && typeof s.skins === 'object') for (const k of Object.keys(s.skins).slice(0, 900)) if (/^[a-z0-9]{1,40}$/.test(k) && Array.isArray(s.skins[k])) skins[k] = s.skins[k].filter(x => /^[a-z]{1,16}$/.test(x)).slice(0, 10);
  const skinSel = {}; if (s.skinSel && typeof s.skinSel === 'object') for (const k of Object.keys(s.skinSel).slice(0, 900)) if (/^[a-z0-9]{1,40}$/.test(k) && /^[a-z]{0,16}$/.test(s.skinSel[k])) skinSel[k] = s.skinSel[k];
  const b = s.bag || {};
  return {
    mdna: int(s.mdna, 1e6), shards: numMap(s.shards, 20, 1e5), bag: { parts: numMap(b.parts, 20, 1e5), titanCore: int(b.titanCore, 1e5), titanParts: int(b.titanParts, 1e5), tfrag: int(b.tfrag, 1e6), pdna: int(b.pdna, 1e6) },
    skins, skinSel, primordial: flagMap(s.primordial, 900), primoOn: flagMap(s.primoOn, 900), titan: flagMap(s.titan, 900), holPity: numMap(s.holPity, 20, 100),
    settings: s.settings && typeof s.settings === 'object' ? { sound: !!s.settings.sound, vol: Math.max(0, Math.min(1, +s.settings.vol || 0)), quality: ['auto', 'high', 'low'].includes(s.settings.quality) ? s.settings.quality : 'auto', names: !!s.settings.names } : undefined,
    dna: int(s.dna, 1e8), adna: int(s.adna, 1e6), tokens, owned,
    equipped: String(s.equipped || '').slice(0, 40), name: cleanName(s.name), story: int(s.story, 10),
    tutorialDone: !!s.tutorialDone, planetPref: String(s.planetPref || 'random').slice(0, 10),
    stats: { kills: int(st.kills, 1e8), matches: int(st.matches, 1e8), wins: int(st.wins, 1e8) },
  };
}
const publicName = rec => (rec.save && rec.save.name) || rec.given || 'Alien';

// ------------------------------------------------------------------ HTTP API
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function friendCode(id) { return crypto.createHash('sha256').update('fc:' + id).digest('hex').slice(0, 8).toUpperCase(); }
const GIFT_ITEMS = { pack: 1, alien: 1 }, lastGifts = new Map();
function profileOut(rec) { return { code: rec.code || friendCode(rec.id), gifts: (rec.gifts || []).length, acct: crypto.createHash('sha256').update(rec.id).digest('hex').slice(0, 16), name: publicName(rec), given: rec.given || '', save: rec.save || null, stats: rec.stats }; }
const lastScore = new Map();
const lastReports = new Map();

function readRaw(req) {
  return new Promise((resolve, reject) => { let n = 0; const chunks = []; req.on('data', c => { n += c.length; if (n > 512 * 1024) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });
}
// A paid Stripe checkout session becomes a gift in the recipient's inbox (the buyer, or the friend they bought for).
async function grantSession(sess) {
  if (!sess || sess.payment_status !== 'paid') return { ok: false, status: sess ? sess.payment_status : 'missing' };
  const md = sess.metadata || {}, it = catalogItem(md.item); if (!it) return { ok: false, status: 'unknown item' };
  const buyer = await store.get(md.uid); if (!buyer) return { ok: false, status: 'unknown buyer' };
  const to = md.to ? await store.byCode(md.to) : buyer; if (!to) return { ok: false, status: 'unknown recipient' };
  to.purchases = to.purchases || [];
  if (to.purchases.some(x => x.id === sess.id)) return { ok: true, status: 'already granted' };
  to.purchases.push({ id: sess.id, item: it.key, cents: sess.amount_total, at: Date.now(), from: buyer.id }); to.purchases = to.purchases.slice(-500);
  if (it.grant.type === 'alien') { to.entitled = [...new Set([...(to.entitled || []), it.grant.id])]; }
  to.gifts = (to.gifts || []).slice(-49); to.gifts.push({ from: to === buyer ? 'Store purchase' : publicName(buyer), item: it.grant, at: Date.now(), paid: true });
  await store.put(to.id, to);
  console.log('[pay] granted', it.key, 'session', sess.id, to === buyer ? '' : '(gift)');
  return { ok: true, status: 'granted' };
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    const route = req.method + ' ' + url.pathname;
    if (route === 'GET /api/config') return send(res, 200, { login: !!CLIENT_ID || DEV_LOGIN, googleClientId: CLIENT_ID, dev: DEV_LOGIN, storage: store.kind, payments: !!STRIPE_KEY, testMode: STRIPE_KEY.startsWith('sk_test_'), ads: ADS_CLIENT ? { client: ADS_CLIENT, test: process.env.ADSENSE_TEST === '1' } : null }), true;

    if (route === 'POST /api/login') {
      const body = await readBody(req);
      let sub, given;
      if (body.credential) { const g = await verifyGoogle(body.credential); sub = 'g:' + g.sub; given = cleanName(g.given_name || (g.name || '').split(' ')[0]); }
      else if (DEV_LOGIN && body.dev) { sub = 'dev:' + cleanName(body.dev).toLowerCase(); given = cleanName(body.dev); }
      else return send(res, 400, { error: 'No credential' }), true;
      let rec = await store.get(sub);
      if (!rec) rec = { id: sub, given, created: Date.now(), save: null, stats: { best: 0, kills: 0, wins: 0, matches: 0, collected: 0, alien: 'blipling' } };
      rec.given = given || rec.given; rec.lastLogin = Date.now(); rec.code = rec.code || friendCode(sub);
      await store.put(sub, rec);
      return send(res, 200, { token: sign({ uid: sub, exp: Date.now() + 30 * 864e5 }), ...profileOut(rec) }), true;
    }

    if (route === 'POST /api/stripe/webhook') {
      const raw = await readRaw(req);
      if (!verifyStripeSig(raw, req.headers['stripe-signature'])) return send(res, 400, { error: 'Bad signature' }), true;
      const ev = JSON.parse(raw);
      if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await grantSession(ev.data.object);
      return send(res, 200, { received: true }), true;
    }
    const auth = readToken(req);
    // Reports: players can report another player or a game bug. Works signed in or not; rate limited per address.
    if (route === 'POST /api/report') {
      const body = await readBody(req), ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim(), now = Date.now();
      const recent = (lastReports.get(ip) || []).filter(t => now - t < 3600e3); if (recent.length >= 6) return send(res, 429, { error: 'Too many reports from you this hour. Please try again later.' }), true;
      const kind = ['player', 'bug', 'other'].includes(body.kind) ? body.kind : 'other', text = String(body.text || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 1500).trim();
      if (text.length < 5) return send(res, 400, { error: 'Please describe the problem (at least 5 characters).' }), true;
      const c0 = body.ctx && typeof body.ctx === 'object' ? body.ctx : {}, str = (v, n) => String(v == null ? '' : v).slice(0, n);
      const ctx = { mode: str(c0.mode, 20), planet: str(c0.planet, 20), alien: str(c0.alien, 40), lvl: int(c0.lvl, 10), ver: str(c0.ver, 20), ua: str(c0.ua, 160), errors: Array.isArray(c0.errors) ? c0.errors.slice(-5).map(e => str(e, 240)) : [] };
      let by = null; if (auth) { const r0 = await store.get(auth.uid); if (r0) by = { id: r0.id, name: publicName(r0), code: r0.code || friendCode(r0.id) }; }
      const report = { id: crypto.randomBytes(6).toString('hex'), at: now, kind, target: String(body.target || '').slice(0, 40), text, ctx, by, ip: crypto.createHash('sha256').update('ip:' + ip).digest('hex').slice(0, 12) };
      await store.addReport(report); recent.push(now); lastReports.set(ip, recent);
      console.log('[report]', kind, report.id, report.target ? 'target=' + report.target : '', text.slice(0, 80));
      return send(res, 200, { ok: true, id: report.id }), true;
    }
    if (route === 'GET /api/reports') {
      const key = String(url.searchParams.get('key') || ''), ADMIN = process.env.ADMIN_KEY || '';
      if (!ADMIN || key.length !== ADMIN.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN))) return send(res, 403, { error: 'Admin key required' }), true;
      return send(res, 200, { reports: await store.listReports(Math.min(500, int(url.searchParams.get('n') || 200, 500) || 200)) }), true;
    }
    if (route === 'GET /api/leaderboard') {
      const type = BOARD_FIELDS.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'best';
      const rows = (await store.top(type, 50)).map((r, i) => ({ rank: i + 1, name: publicName(r), value: r.stats[type], alien: r.stats.alien || 'blipling', me: !!auth && r.id === auth.uid }));
      let me = null;
      if (auth) { const rec = await store.get(auth.uid); if (rec) { const v = rec.stats[type] || 0; me = { name: publicName(rec), value: v, rank: v > 0 ? await store.rank(type, v) : null }; } }
      return send(res, 200, { type, rows, me }), true;
    }

    if (!auth) return send(res, 401, { error: 'Not signed in' }), true;
    const rec = await store.get(auth.uid);
    if (!rec) return send(res, 401, { error: 'Unknown player' }), true;

    if (route === 'GET /api/me') return send(res, 200, profileOut(rec)), true;

    if (route === 'POST /api/redeem') { // exclusive-creature codes; only hashes are stored
      const body = await readBody(req), now = Date.now(), recent = (lastGifts.get('r:' + rec.id) || []).filter(t => now - t < 3600e3);
      if (recent.length >= 10) return send(res, 429, { error: 'Too many attempts, try again later' }), true; recent.push(now); lastGifts.set('r:' + rec.id, recent);
      const h = crypto.createHash('sha256').update('xeno:' + String(body.code || '').toUpperCase().replace(/\s+/g, '')).digest('hex'), id = (CATALOG.codes || {})[h];
      if (!id) return send(res, 404, { error: 'Code not recognised' }), true;
      rec.entitled = [...new Set([...(rec.entitled || []), id])]; rec.redeemed = [...new Set([...(rec.redeemed || []), id])]; await store.put(rec.id, rec);
      return send(res, 200, { ok: true, id }), true;
    }
    if (route === 'POST /api/checkout') {
      if (!STRIPE_KEY) return send(res, 503, { error: 'Payments are not set up on this server yet' }), true;
      const body = await readBody(req), it = catalogItem(body.item); if (!it) return send(res, 400, { error: 'Unknown item' }), true;
      let to = '';
      if (body.to) { to = String(body.to).toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 8); if (to.length !== 8) return send(res, 400, { error: 'Enter an 8-character friend code' }), true; if (to === (rec.code || friendCode(rec.id))) return send(res, 400, { error: 'You cannot gift yourself' }), true; if (!(await store.byCode(to))) return send(res, 404, { error: 'No player has that friend code' }), true; }
      const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('https://' + req.headers.host)).replace(/\/$/, '');
      const sess = await stripe('POST', 'checkout/sessions', {
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(it.cents),
        'line_items[0][price_data][product_data][name]': 'XENO.IO: ' + it.name + (to ? ' (gift)' : ''),
        success_url: base + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}', cancel_url: base + '/?checkout=cancel',
        client_reference_id: rec.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200), 'metadata[uid]': rec.id, 'metadata[item]': it.key, 'metadata[to]': to,
      });
      return send(res, 200, { url: sess.url }), true;
    }
    if (route === 'POST /api/checkout/confirm') { // backup path when the webhook is not set up: ask Stripe directly
      if (!STRIPE_KEY) return send(res, 503, { error: 'Payments are not set up' }), true;
      const body = await readBody(req), id = String(body.session || ''); if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return send(res, 400, { error: 'Bad session' }), true;
      const sess = await stripe('GET', 'checkout/sessions/' + id);
      if ((sess.metadata || {}).uid !== rec.id) return send(res, 403, { error: 'Not your purchase' }), true;
      return send(res, 200, await grantSession(sess)), true;
    }

    if (route === 'POST /api/save') {
      const body = await readBody(req);
      const sv = cleanSave(body.save);
      if (!sv) return send(res, 400, { error: 'Bad save' }), true;
      { const ent = new Set(rec.entitled || []), codeIds = new Set(Object.values(CATALOG.codes || {})); sv.owned = sv.owned.filter(id => ent.has(id) || (codeIds.has(id) ? false : (!STRIPE_KEY || !PREMIUM_IDS.has(id)))); }
      rec.save = sv; rec.stats.collected = sv.owned.length; if (sv.equipped) rec.stats.alien = sv.equipped;
      await store.put(rec.id, rec);
      return send(res, 200, { ok: true }), true;
    }

    if (route === 'POST /api/score') {
      const body = await readBody(req);
      const now = Date.now();
      if (now - (lastScore.get(rec.id) || 0) < 15000) return send(res, 429, { error: 'Too many scores' }), true;
      lastScore.set(rec.id, now);
      const score = int(body.score, 60000), kills = int(body.kills, 300);
      rec.stats.matches = (rec.stats.matches || 0) + 1;
      rec.stats.kills = (rec.stats.kills || 0) + kills;
      if (body.win && body.mode === 'online') rec.stats.wins = (rec.stats.wins || 0) + 1;
      if (body.mode === 'online' && score > (rec.stats.onlineBest || 0)) rec.stats.onlineBest = score;
      if (body.mode === 'open' && score > (rec.stats.openBest || 0)) rec.stats.openBest = score;
      if (score > (rec.stats.best || 0)) { rec.stats.best = score; rec.stats.alien = String(body.alien || rec.stats.alien).slice(0, 40); }
      await store.put(rec.id, rec);
      return send(res, 200, { ok: true, stats: rec.stats, rank: await store.rank('best', rec.stats.best) }), true;
    }

    // Gifts: send a bought item to another player by their friend code; they claim it next time they sign in.
    if (route === 'POST /api/gift') {
      if (STRIPE_KEY) return send(res, 402, { error: 'Gifts are bought through checkout now' }), true;
      const body = await readBody(req), code = String(body.to || '').toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 8), it = body.item || {};
      if (code.length !== 8) return send(res, 400, { error: 'Enter an 8-character friend code' }), true;
      if (code === (rec.code || friendCode(rec.id))) return send(res, 400, { error: 'You cannot gift yourself' }), true;
      const now = Date.now(), recent = (lastGifts.get(rec.id) || []).filter(t => now - t < 3600e3); if (recent.length >= 20) return send(res, 429, { error: 'Gift limit reached, try again later' }), true;
      let item;
      if (it.type === 'pack' && ['dna', 'adna', 'mdna'].includes(it.cur)) item = { type: 'pack', cur: it.cur, n: int(it.n, it.cur === 'dna' ? 50000 : 100) };
      else if (it.type === 'alien' && /^[a-z0-9]{1,40}$/.test(it.id || '')) item = { type: 'alien', id: it.id };
      if (!item || (item.type === 'pack' && !item.n)) return send(res, 400, { error: 'That item cannot be gifted' }), true;
      const to = await store.byCode(code); if (!to) return send(res, 404, { error: 'No player has that friend code' }), true;
      to.gifts = (to.gifts || []).slice(-49); to.gifts.push({ from: publicName(rec), item, at: now }); await store.put(to.id, to);
      recent.push(now); lastGifts.set(rec.id, recent);
      return send(res, 200, { ok: true, to: publicName(to) }), true;
    }
    if (route === 'GET /api/gifts') return send(res, 200, { gifts: rec.gifts || [] }), true;
    if (route === 'POST /api/gifts/claim') { const g = rec.gifts || []; rec.gifts = []; await store.put(rec.id, rec); return send(res, 200, { gifts: g }), true; }

    return send(res, 404, { error: 'Unknown endpoint' }), true;
  } catch (e) {
    console.error('[api]', e.message);
    return send(res, 400, { error: e.message }), true;
  }
}

module.exports = { handle, store };
