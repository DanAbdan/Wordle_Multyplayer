'use strict';
// Tebak Kata KBBI - server multiplayer (HTTP statis + WebSocket + panel stiker)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 24;
const MAX_GUESSES = 6;
const COUNTDOWN_MS = 4000;
const RESULT_MS = 12000;
const LOBBY_GRACE_MS = 30000;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const MAX_ROOMS = 500;
const LIMITS = { rounds: [1, 20], time: [30, 600] };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// Mode skill
const SKILL_BLOCK = 3; // skill baru setiap 3 ronde (ronde 1, 4, 7, ...)
const SKILL_IDS = ['intip', 'coret', 'bekukan', 'perisai', 'ganda'];
const FREEZE_MS = 6000;
const GANDA_PENALTY = 100;

// Stiker
const MAX_STICKERS = 5;
const STICKER_MAX_BYTES = 120 * 1024;
const EMOTE_COOLDOWN_MS = 1200;

// Admin
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_ENABLED = ADMIN_USER.length > 0 && ADMIN_PASSWORD.length >= 8;
const SESSION_MS = 12 * 60 * 60 * 1000;
const SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('wordle-kbbi|' + ADMIN_USER + '|' + ADMIN_PASSWORD).digest('hex');

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));

function readList(file) {
  return fs
    .readFileSync(path.join(__dirname, 'data', file), 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((w) => /^[a-z]{5}$/.test(w));
}
const VALID = new Set(readList('valid.txt'));
const ANSWERS = readList('answers.txt').filter((w) => VALID.has(w));
console.log(`Kata KBBI valid: ${VALID.size}, kata jawaban: ${ANSWERS.length}`);
console.log(
  ADMIN_ENABLED
    ? 'Panel admin: aktif'
    : 'Panel admin: NONAKTIF (isi ADMIN_USER dan ADMIN_PASSWORD minimal 8 karakter untuk mengaktifkan)'
);

const rid = (n) => crypto.randomBytes(n).toString('hex');

// ---------- Penyimpanan stiker (Upstash Redis, atau memori kalau belum diisi) ----------
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
let stickers = new Map(); // id -> {id, mime, buf}
let stickerOrder = [];
let storageOk = !USE_REDIS;
let storageErr = '';
let lastLoadTry = 0;
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000),
  });
  let j = {};
  try {
    j = await r.json();
  } catch {}
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}

async function loadStickers() {
  lastLoadTry = Date.now();
  if (!USE_REDIS) {
    storageOk = true;
    return;
  }
  try {
    const idx = await redis(['GET', 'stk:index']);
    const ids = idx ? JSON.parse(idx) : [];
    const next = new Map();
    const nextOrder = [];
    for (const id of ids) {
      const raw = await redis(['GET', 'stk:' + id]);
      if (!raw) continue;
      const o = JSON.parse(raw);
      next.set(id, { id, mime: o.mime, buf: Buffer.from(o.b64, 'base64') });
      nextOrder.push(id);
    }
    stickers = next;
    stickerOrder = nextOrder;
    storageOk = true;
    storageErr = '';
    console.log(`Stiker dimuat dari Upstash: ${nextOrder.length}`);
  } catch (e) {
    storageOk = false;
    storageErr = String(e.message || e);
    console.error('Gagal memuat stiker:', storageErr);
  }
}

function requireStorage() {
  if (!storageOk) throw httpErr(503, 'Penyimpanan belum tersambung: ' + (storageErr || 'coba lagi sebentar'));
}

const addSticker = (mime, buf) =>
  serial(async () => {
    requireStorage();
    if (stickerOrder.length >= MAX_STICKERS) throw httpErr(400, `Maksimal ${MAX_STICKERS} emoticon. Hapus salah satu dulu.`);
    const id = rid(4);
    if (USE_REDIS) {
      await redis(['SET', 'stk:' + id, JSON.stringify({ mime, b64: buf.toString('base64') })]);
      try {
        await redis(['SET', 'stk:index', JSON.stringify([...stickerOrder, id])]);
      } catch (e) {
        redis(['DEL', 'stk:' + id]).catch(() => {});
        throw e;
      }
    }
    stickers.set(id, { id, mime, buf });
    stickerOrder = [...stickerOrder, id];
    return id;
  });

const removeSticker = (id) =>
  serial(async () => {
    requireStorage();
    if (!stickers.has(id)) throw httpErr(404, 'Emoticon tidak ditemukan');
    const next = stickerOrder.filter((x) => x !== id);
    if (USE_REDIS) {
      await redis(['SET', 'stk:index', JSON.stringify(next)]);
      await redis(['DEL', 'stk:' + id]).catch(() => {}); // gagal hapus data tidak fatal (indeks sudah benar)
    }
    stickers.delete(id);
    stickerOrder = next;
  });

const stickerList = () => stickerOrder.map((id) => ({ id }));

// ---------- Auth admin ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return exp + '.' + sign(exp);
}
function verifyToken(t) {
  if (!t || typeof t !== 'string') return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEq(sig, sign(exp));
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const isAuthed = (req) => ADMIN_ENABLED && verifyToken(getCookie(req, 'adm'));
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

const fails = new Map(); // ip -> {n, first, lockUntil}
let globalFails = { n: 0, first: Date.now(), lockUntil: 0 };
function loginBlocked(ip) {
  const now = Date.now();
  if (globalFails.lockUntil > now) return true;
  const f = fails.get(ip);
  return !!(f && f.lockUntil > now);
}
function noteFail(ip) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || now - f.first > 10 * 60 * 1000) f = { n: 0, first: now, lockUntil: 0 };
  f.n++;
  if (f.n >= 5) f.lockUntil = now + 15 * 60 * 1000;
  fails.set(ip, f);
  if (now - globalFails.first > 15 * 60 * 1000) globalFails = { n: 0, first: now, lockUntil: 0 };
  globalFails.n++;
  if (globalFails.n >= 40) globalFails.lockUntil = now + 5 * 60 * 1000;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of fails) if (now - f.first > 30 * 60 * 1000 && f.lockUntil < now) fails.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const TEXTY = new Set(['.html', '.css', '.js', '.svg', '.json']);
const PUBLIC = path.join(__dirname, 'public');
const assets = new Map();
(function loadAssets(dir, base) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      loadAssets(full, base + f.name + '/');
      continue;
    }
    const buf = fs.readFileSync(full);
    const ext = path.extname(f.name);
    assets.set(base + f.name, {
      buf,
      gz: TEXTY.has(ext) ? zlib.gzipSync(buf, { level: 9 }) : null,
      type: MIME[ext] || 'application/octet-stream',
      etag: '"' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 20) + '"',
    });
  }
})(PUBLIC, '/');

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function baseHeaders(extra) {
  return Object.assign(
    {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': CSP,
    },
    extra
  );
}
function json(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, baseHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra)));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(httpErr(413, 'File terlalu besar'));
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => (over ? reject(httpErr(413, 'File terlalu besar')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function serveAsset(req, res, key) {
  const a = assets.get(key);
  if (!a) {
    res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Tidak ditemukan');
  }
  const h = { 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (key.startsWith('/admin')) h['X-Robots-Tag'] = 'noindex';
  if (req.headers['if-none-match'] === a.etag) {
    res.writeHead(304, baseHeaders(h));
    return res.end();
  }
  const useGz = a.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (useGz) h['Content-Encoding'] = 'gzip';
  const body = useGz ? a.gz : a.buf;
  h['Content-Length'] = body.length;
  res.writeHead(200, baseHeaders(h));
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handleAdminApi(req, res, p) {
  if (!ADMIN_ENABLED) return json(res, 503, { ok: false, enabled: false, error: 'Panel belum dikonfigurasi di server' });

  if (p === '/admin/api/me' && req.method === 'GET') {
    if (!isAuthed(req)) return json(res, 401, { ok: false, enabled: true });
    return json(res, 200, {
      ok: true,
      enabled: true,
      persistent: USE_REDIS,
      storageOk,
      storageErr,
      max: MAX_STICKERS,
      stickers: stickerList(),
    });
  }

  // semua perubahan wajib pakai header khusus (anti-CSRF)
  if (req.method !== 'GET' && req.headers['x-panel'] !== '1') return json(res, 403, { ok: false, error: 'Ditolak' });

  if (p === '/admin/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return json(res, 429, { ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    let body;
    try {
      body = JSON.parse(await readBody(req, 2048));
    } catch {
      return json(res, 400, { ok: false, error: 'Permintaan tidak valid' });
    }
    const okUser = safeEq(String(body.username || ''), ADMIN_USER);
    const okPass = safeEq(String(body.password || ''), ADMIN_PASSWORD);
    if (!(okUser && okPass)) {
      noteFail(ip);
      await new Promise((r) => setTimeout(r, 700));
      return json(res, 401, { ok: false, error: 'Username atau password salah' });
    }
    fails.delete(ip);
    const cookie = `adm=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` + (isHttps(req) ? '; Secure' : '');
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (p === '/admin/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (!isAuthed(req)) return json(res, 401, { ok: false, error: 'Belum login' });

  if (p === '/admin/api/stickers' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req, 220 * 1024));
    } catch (e) {
      return json(res, e.status || 400, { ok: false, error: e.status ? e.message : 'Permintaan tidak valid' });
    }
    const m = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) return json(res, 400, { ok: false, error: 'Format harus PNG, WebP, atau JPEG' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > STICKER_MAX_BYTES) return json(res, 413, { ok: false, error: 'Ukuran gambar maksimal 120 KB' });
    const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpg = buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const webp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    const okMagic = (m[1] === 'image/png' && png) || (m[1] === 'image/jpeg' && jpg) || (m[1] === 'image/webp' && webp);
    if (!okMagic) return json(res, 400, { ok: false, error: 'Isi file tidak cocok dengan formatnya' });
    try {
      const id = await addSticker(m[1], buf);
      return json(res, 200, { ok: true, id, stickers: stickerList() });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Gagal menyimpan' });
    }
  }

  const del = /^\/admin\/api\/stickers\/([a-f0-9]{8})$/.exec(p);
  if (del && req.method === 'DELETE') {
    try {
      await removeSticker(del[1]);
      return json(res, 200, { ok: true, stickers: stickerList() });
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Gagal menghapus' });
    }
  }

  return json(res, 404, { ok: false, error: 'Tidak ditemukan' });
}

const server = http.createServer(async (req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  try {
    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (p === '/api/stickers' && req.method === 'GET') {
      if (!storageOk && Date.now() - lastLoadTry > 20000) await loadStickers();
      return json(res, 200, { stickers: stickerList() }, { 'Cache-Control': 'no-cache' });
    }
    const sm = /^\/s\/([a-f0-9]{8})$/.exec(p);
    if (sm && (req.method === 'GET' || req.method === 'HEAD')) {
      const s = stickers.get(sm[1]);
      if (!s) {
        res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain' }));
        return res.end('Tidak ada');
      }
      res.writeHead(
        200,
        baseHeaders({ 'Content-Type': s.mime, 'Content-Length': s.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' })
      );
      return res.end(req.method === 'HEAD' ? undefined : s.buf);
    }
    if (p.startsWith('/admin/api/')) return await handleAdminApi(req, res, p);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    if (p === '/admin' || p === '/admin/') p = '/admin.html';
    if (p === '/') p = '/index.html';
    return serveAsset(req, res, p);
  } catch (e) {
    console.error('http error', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// ---------- State game ----------
const rooms = new Map();

function genCode() {
  for (let tries = 0; tries < 100; tries++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function resetRoundState(p) {
  p.guesses = [];
  p.solved = false;
  p.solvedMs = null;
  p.done = false;
  p.late = false;
  p.roundPoints = 0;
  p.hint = null;
  p.coret = [];
  p.ganda = false;
  p.frozenUntil = 0;
  p.frozenThisRound = false;
}

function newPlayer(name) {
  const p = {
    id: rid(3),
    token: rid(16),
    name,
    ws: null,
    connected: false,
    score: 0,
    solvedCount: 0,
    skill: null,
    lastEmote: 0,
    removeTimer: null,
  };
  resetRoundState(p);
  return p;
}

function cleanName(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendErr(ws, msg, code) {
  send(ws, { t: 'error', msg, code });
}
function sendAll(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

function evaluate(guess, answer) {
  const res = [0, 0, 0, 0, 0];
  const left = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) res[i] = 2;
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] !== 2 && left[guess[i]] > 0) {
      res[i] = 1;
      left[guess[i]]--;
    }
  }
  return res.join('');
}

function priv(p) {
  return {
    skill: p.skill ? { id: p.skill.id, used: p.skill.used } : null,
    hint: p.hint,
    coret: p.coret,
    ganda: p.ganda,
  };
}
const sendMy = (p) => send(p.ws, { t: 'my', my: priv(p) });

function snapshot(room, viewerId) {
  const reveal = room.phase === 'roundEnd' || room.phase === 'final';
  const me = room.players.get(viewerId);
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    serverNow: Date.now(),
    you: viewerId,
    hostId: room.hostId,
    settings: room.settings,
    round: room.round,
    maxPlayers: MAX_PLAYERS,
    skillBlock: SKILL_BLOCK,
    countdownEndsAt: room.countdownEndsAt,
    roundEndsAt: room.roundEndsAt,
    nextAt: room.nextAt,
    word: reveal ? room.word : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      host: p.id === room.hostId,
      done: p.done,
      solved: p.solved,
      late: p.late,
      rows: p.guesses.map((g) => g.pattern),
      roundPoints: p.roundPoints,
      solvedCount: p.solvedCount,
      solvedMs: p.solvedMs,
      frozenUntil: p.frozenUntil,
    })),
    myGuesses: me ? me.guesses.map((g) => ({ w: g.word, p: g.pattern })) : [],
    my: me ? priv(me) : null,
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.ws) send(p.ws, snapshot(room, p.id));
  }
}

function schedule(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    try {
      fn(room);
    } catch (e) {
      console.error(e);
    }
  }, ms);
}

function reassignHost(room) {
  const next = [...room.players.values()].find((p) => p.connected);
  if (next) room.hostId = next.id;
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) {
    clearTimeout(p.removeTimer);
    if (p.ws) {
      p.ws.ctx = null;
      p.ws.close();
    }
  }
  rooms.delete(room.code);
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.removeTimer);
  room.players.delete(id);
  if (room.players.size === 0) return deleteRoom(room);
  if (room.hostId === id) reassignHost(room);
  if (!room.players.has(room.hostId)) room.hostId = [...room.players.keys()][0];
  checkRoundDone(room);
  broadcast(room);
}

// ---------- Alur permainan ----------
function pickWord(room) {
  let pool = ANSWERS.filter((w) => !room.used.has(w));
  if (pool.length === 0) {
    room.used.clear();
    pool = ANSWERS;
  }
  const w = pool[crypto.randomInt(pool.length)];
  room.used.add(w);
  return w;
}

function giveSkill(p) {
  const prev = p.skill && p.skill.id;
  const pool = SKILL_IDS.filter((s) => s !== prev);
  p.skill = { id: pool[crypto.randomInt(pool.length)], used: false };
}

function startCountdown(room) {
  room.round += 1;
  room.phase = 'countdown';
  room.word = pickWord(room);
  room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  room.roundEndsAt = null;
  room.nextAt = null;
  for (const p of room.players.values()) resetRoundState(p);
  if (room.settings.mode === 'skill') {
    const fresh = (room.round - 1) % SKILL_BLOCK === 0;
    for (const p of room.players.values()) if (fresh || !p.skill) giveSkill(p);
  } else {
    for (const p of room.players.values()) p.skill = null;
  }
  schedule(room, COUNTDOWN_MS, startRound);
  broadcast(room);
}

function startRound(room) {
  room.phase = 'playing';
  room.roundStartedAt = Date.now();
  room.roundEndsAt = room.roundStartedAt + room.settings.time * 1000;
  schedule(room, room.settings.time * 1000, endRound);
  broadcast(room);
}

function endRound(room) {
  if (room.phase !== 'playing') return;
  room.phase = 'roundEnd';
  room.nextAt = Date.now() + RESULT_MS;
  // Skor Ganda: gagal = kena penalti
  for (const p of room.players.values()) {
    if (p.ganda && !p.solved) {
      const loss = Math.min(GANDA_PENALTY, p.score);
      p.score -= loss;
      p.roundPoints = -loss;
    }
  }
  schedule(room, RESULT_MS, advance);
  broadcast(room);
}

function advance(room) {
  if (room.phase !== 'roundEnd') return;
  if (room.round >= room.settings.rounds) {
    clearTimeout(room.timer);
    room.phase = 'final';
    room.nextAt = null;
    broadcast(room);
  } else {
    startCountdown(room);
  }
}

function checkRoundDone(room) {
  if (room.phase !== 'playing') return;
  const active = [...room.players.values()].filter((p) => p.connected && !p.late);
  if (active.length === 0) return;
  if (active.every((p) => p.done)) endRound(room);
}

function backToLobby(room) {
  clearTimeout(room.timer);
  room.phase = 'lobby';
  room.round = 0;
  room.word = null;
  room.countdownEndsAt = room.roundEndsAt = room.nextAt = null;
  for (const p of [...room.players.values()]) {
    if (!p.connected) {
      room.players.delete(p.id);
      continue;
    }
    p.score = 0;
    p.solvedCount = 0;
    p.skill = null;
    resetRoundState(p);
  }
  if (!room.players.has(room.hostId)) reassignHost(room);
}

// ---------- Skill ----------
function useSkill(room, player, ws) {
  if (room.settings.mode !== 'skill' || room.phase !== 'playing') return;
  const s = player.skill;
  if (!s || s.used || player.done || player.late) return;
  const note = (msg) => send(ws, { t: 'note', msg });

  switch (s.id) {
    case 'intip': {
      const known = new Set();
      for (const g of player.guesses) for (let i = 0; i < 5; i++) if (g.pattern[i] === '2') known.add(i);
      const cand = [0, 1, 2, 3, 4].filter((i) => !known.has(i));
      if (cand.length === 0) return note('Semua huruf sudah kamu temukan');
      const pos = cand[crypto.randomInt(cand.length)];
      player.hint = { pos, letter: room.word[pos] };
      break;
    }
    case 'coret': {
      const tried = new Set();
      for (const g of player.guesses) for (const ch of g.word) tried.add(ch);
      const pool = 'abcdefghijklmnopqrstuvwxyz'.split('').filter((ch) => !room.word.includes(ch) && !tried.has(ch));
      if (pool.length === 0) return note('Tidak ada huruf yang bisa dicoret');
      const pick = [];
      while (pick.length < 3 && pool.length) pick.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
      player.coret = pick;
      break;
    }
    case 'bekukan': {
      const now = Date.now();
      const el = [...room.players.values()].filter(
        (q) => q.id !== player.id && q.connected && !q.done && !q.late && !q.frozenThisRound && q.frozenUntil <= now
      );
      if (el.length === 0) return note('Belum ada target yang bisa dibekukan');
      const top = Math.max(...el.map((q) => q.score));
      const tops = el.filter((q) => q.score === top);
      const target = tops[crypto.randomInt(tops.length)];
      s.used = true;
      const shield = target.skill && target.skill.id === 'perisai' && !target.skill.used;
      if (shield) {
        target.skill.used = true;
        sendMy(target);
        sendAll(room, { t: 'fx', k: 'freeze', from: player.id, to: target.id, blocked: true });
      } else {
        target.frozenUntil = now + FREEZE_MS;
        target.frozenThisRound = true;
        sendAll(room, { t: 'fx', k: 'freeze', from: player.id, to: target.id, blocked: false, until: target.frozenUntil, serverNow: now });
      }
      return sendMy(player);
    }
    case 'perisai':
      return note('Perisai aktif otomatis: menangkal 1 serangan Bekukan');
    case 'ganda':
      player.ganda = true;
      break;
    default:
      return;
  }
  s.used = true;
  sendMy(player);
}

// ---------- Koneksi ----------
function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) {
    player.ws.ctx = null;
    player.ws.close();
  }
  clearTimeout(player.removeTimer);
  player.ws = ws;
  player.connected = true;
  ws.ctx = { room, player };
  const host = room.players.get(room.hostId);
  if (!host || !host.connected) room.hostId = player.id;
  room.lastActive = Date.now();
  send(ws, { t: 'joined', code: room.code, id: player.id, token: player.token });
  broadcast(room);
}

function detach(ws) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const { room, player } = ctx;
  if (player.ws !== ws) return;
  player.ws = null;
  player.connected = false;
  if (room.hostId === player.id) reassignHost(room);
  if (room.phase === 'lobby') {
    player.removeTimer = setTimeout(() => {
      if (!player.connected && rooms.get(room.code) === room) removePlayer(room, player.id);
    }, LOBBY_GRACE_MS);
  } else {
    checkRoundDone(room);
  }
  broadcast(room);
}

function doCreate(ws, m) {
  const name = cleanName(m.name);
  if (name.length < 2) return sendErr(ws, 'Nickname minimal 2 huruf', 'name');
  if (rooms.size >= MAX_ROOMS) return sendErr(ws, 'Server sedang penuh, coba lagi nanti', 'full');
  const code = genCode();
  if (!code) return sendErr(ws, 'Gagal membuat room', 'full');
  detach(ws);
  const room = {
    code,
    hostId: null,
    players: new Map(),
    settings: { rounds: 5, time: 120, mode: m.mode === 'skill' ? 'skill' : 'normal' },
    phase: 'lobby',
    round: 0,
    word: null,
    used: new Set(),
    timer: null,
    countdownEndsAt: null,
    roundStartedAt: null,
    roundEndsAt: null,
    nextAt: null,
    lastActive: Date.now(),
  };
  const player = newPlayer(name);
  room.players.set(player.id, player);
  room.hostId = player.id;
  rooms.set(code, room);
  attach(ws, room, player);
}

function doJoin(ws, m) {
  const code = String(m.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return sendErr(ws, 'Room tidak ditemukan atau sudah ditutup', 'noroom');

  if (m.token) {
    const existing = [...room.players.values()].find((p) => p.token === String(m.token));
    if (existing) {
      if (ws.ctx && ws.ctx.player !== existing) detach(ws);
      return attach(ws, room, existing);
    }
  }

  const name = cleanName(m.name);
  if (name.length < 2) return sendErr(ws, 'Nickname minimal 2 huruf', 'name');
  const same = [...room.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (same) {
    if (same.connected) return sendErr(ws, 'Nickname sudah dipakai di room ini', 'name');
    same.token = rid(16);
    detach(ws);
    return attach(ws, room, same);
  }
  if (room.players.size >= MAX_PLAYERS) return sendErr(ws, `Room penuh (${MAX_PLAYERS}/${MAX_PLAYERS})`, 'full');
  detach(ws);
  const player = newPlayer(name);
  if (room.phase !== 'lobby' && room.settings.mode === 'skill') giveSkill(player);
  if (room.phase === 'playing') {
    player.done = true;
    player.late = true;
  }
  room.players.set(player.id, player);
  attach(ws, room, player);
}

function clampInt(v, [lo, hi], fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function handle(ws, m) {
  if (m.t === 'ping') return send(ws, { t: 'pong' });
  if (m.t === 'create') return doCreate(ws, m);
  if (m.t === 'join') return doJoin(ws, m);
  const ctx = ws.ctx;
  if (!ctx) return;
  const { room, player } = ctx;
  const isHost = room.hostId === player.id;
  room.lastActive = Date.now();

  switch (m.t) {
    case 'settings': {
      if (!isHost || room.phase !== 'lobby') return;
      room.settings.rounds = clampInt(m.rounds, LIMITS.rounds, room.settings.rounds);
      room.settings.time = clampInt(m.time, LIMITS.time, room.settings.time);
      if (m.mode === 'skill' || m.mode === 'normal') room.settings.mode = m.mode;
      return broadcast(room);
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      room.round = 0;
      for (const p of room.players.values()) {
        p.score = 0;
        p.solvedCount = 0;
        p.skill = null;
      }
      return startCountdown(room);
    }
    case 'guess': {
      if (room.phase !== 'playing' || player.done || player.late) return;
      if (player.frozenUntil > Date.now()) return send(ws, { t: 'invalid', msg: 'Kamu sedang dibekukan!' });
      const w = String(m.word || '').toLowerCase();
      if (!/^[a-z]{5}$/.test(w)) return send(ws, { t: 'invalid', msg: 'Kata harus 5 huruf' });
      if (!VALID.has(w)) return send(ws, { t: 'invalid', msg: 'Kata tidak ada di KBBI' });
      const pattern = evaluate(w, room.word);
      player.guesses.push({ word: w, pattern });
      if (pattern === '22222') {
        const elapsed = Date.now() - room.roundStartedAt;
        const total = room.settings.time * 1000;
        const ratio = Math.max(0, 1 - elapsed / total);
        player.solved = true;
        player.solvedMs = elapsed;
        player.done = true;
        player.roundPoints = (100 + Math.round(400 * ratio)) * (player.ganda ? 2 : 1);
        player.score += player.roundPoints;
        player.solvedCount += 1;
      } else if (player.guesses.length >= MAX_GUESSES) {
        player.done = true;
      }
      // hanya kirim perubahan kecil (hemat bandwidth)
      const d = {
        t: 'pd',
        id: player.id,
        row: pattern,
        n: player.guesses.length,
        done: player.done,
        solved: player.solved,
        score: player.score,
        rp: player.roundPoints,
        sm: player.solvedMs,
        sc: player.solvedCount,
      };
      sendAll(room, d, player.id);
      send(ws, Object.assign({ w }, d));
      return checkRoundDone(room);
    }
    case 'skill':
      return useSkill(room, player, ws);
    case 'emote': {
      const sid = String(m.sid || '');
      if (!stickers.has(sid)) return;
      const now = Date.now();
      if (now - player.lastEmote < EMOTE_COOLDOWN_MS) return;
      player.lastEmote = now;
      return sendAll(room, { t: 'emote', from: player.id, sid });
    }
    case 'next': {
      if (isHost && room.phase === 'roundEnd') advance(room);
      return;
    }
    case 'again': {
      if (isHost && room.phase === 'final') {
        backToLobby(room);
        broadcast(room);
      }
      return;
    }
    case 'kick': {
      if (!isHost) return;
      const target = room.players.get(String(m.id));
      if (!target || target.id === player.id) return;
      if (target.ws) {
        send(target.ws, { t: 'kicked' });
        target.ws.ctx = null;
      }
      return removePlayer(room, target.id);
    }
    case 'leave': {
      ws.ctx = null;
      send(ws, { t: 'left' });
      return removePlayer(room, player.id);
    }
  }
}

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.bucket = { n: 0, t: Date.now() };
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - ws.bucket.t > 5000) ws.bucket = { n: 0, t: now };
    if (++ws.bucket.n > 40) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    try {
      handle(ws, m);
    } catch (e) {
      console.error(e);
    }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.lastActive > ROOM_IDLE_MS) deleteRoom(room);
  }
}, 60000);

loadStickers().finally(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`Server jalan di http://localhost:${PORT}`));
});
