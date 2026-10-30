'use strict';
// Akun pemain: daftar, login (password di-hash dengan scrypt), foto profil, token sesi bertanda tangan.
// Data disimpan lewat store.js (Upstash Redis). Server berjalan di satu instance, jadi data akun
// disimpan juga di memori (cache) supaya login dan pengecekan sesi tidak memakai perintah Upstash.
const crypto = require('crypto');
const store = require('./store');

const USER_RE = /^[A-Za-z0-9_.-]{3,14}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'host', 'moderator', 'system', 'server', 'tamu', 'guest', 'null', 'undefined']);
const MIN_PASS = 8;
const MAX_PASS = 72;
const MAX_USERS = 500;
const TOKEN_DAYS = 30;
const AVATAR_MAX_BYTES = 60 * 1024;

// Kunci tanda tangan sesi: dari SESSION_SECRET kalau diisi; kalau tidak, dibuat acak sekali lalu disimpan di Upstash
// (tidak diturunkan dari password admin, supaya password admin tidak bisa ditebak dari cookie).
let KEY = crypto.createHash('sha256').update('wordle-kbbi-user|' + (process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'))).digest();
let stableSecret = !!process.env.SESSION_SECRET;
async function loadSecret() {
  if (process.env.SESSION_SECRET || !store.USE_REDIS) return;
  let sec = await store.run(['GET', 'sys:secret']);
  if (!sec) {
    sec = crypto.randomBytes(32).toString('hex');
    await store.run(['SET', 'sys:secret', sec, 'NX']);
    sec = await store.run(['GET', 'sys:secret']);
  }
  KEY = crypto.createHash('sha256').update('wordle-kbbi-user|' + sec).digest();
  stableSecret = true;
}

let pub = new Map(); // lower -> {u, av, c}  (info publik semua akun)
const recs = new Map(); // lower -> {u, salt, hash, pv, c}  (cache rekam lengkap)
const avatars = new Map(); // lower -> {mime, buf}
let ready = false;
let loadErr = '';
let lastTry = 0;

const lowerOf = (s) => String(s || '').toLowerCase();
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

async function load() {
  lastTry = Date.now();
  try {
    await loadSecret();
    const flat = await store.run(['HGETALL', 'usr:pub']);
    const m = new Map();
    for (let i = 0; i < (flat || []).length; i += 2) {
      try {
        m.set(flat[i], JSON.parse(flat[i + 1]));
      } catch {}
    }
    pub = m;
    ready = true;
    loadErr = '';
    console.log(`Akun dimuat: ${pub.size}`);
  } catch (e) {
    ready = false;
    loadErr = String(e.message || e);
    console.error('Gagal memuat akun:', loadErr);
  }
}
async function ensureReady() {
  if (!ready && Date.now() - lastTry > 15000) await load();
  if (!ready) throw httpErr(503, 'Penyimpanan akun belum tersambung, coba lagi sebentar');
}

// ---------- password ----------
let hashing = 0;
const waiters = [];
async function slot() {
  if (hashing >= 2) await new Promise((r) => waiters.push(r));
  hashing++;
}
function release() {
  hashing--;
  const w = waiters.shift();
  if (w) w();
}
async function scrypt(pw, salt) {
  await slot();
  try {
    return await new Promise((res, rej) =>
      crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k)))
    );
  } finally {
    release();
  }
}
const DUMMY_SALT = crypto.randomBytes(16);
async function checkPassword(rec, pw) {
  if (!rec) {
    await scrypt(pw, DUMMY_SALT); // samakan waktu agar username tidak bisa ditebak lewat kecepatan respons
    return false;
  }
  const k = await scrypt(pw, Buffer.from(rec.salt, 'hex'));
  const want = Buffer.from(rec.hash, 'hex');
  return k.length === want.length && crypto.timingSafeEqual(k, want);
}
function validPassword(pw) {
  pw = String(pw || '');
  if (pw.length < MIN_PASS) throw httpErr(400, `Password minimal ${MIN_PASS} karakter`);
  if (pw.length > MAX_PASS) throw httpErr(400, `Password maksimal ${MAX_PASS} karakter`);
  return pw;
}

async function getRec(lower) {
  if (recs.has(lower)) return recs.get(lower);
  if (!pub.has(lower)) return null;
  const raw = await store.run(['GET', 'usr:' + lower]);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  recs.set(lower, rec);
  return rec;
}

// ---------- token sesi ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sig = (s) => crypto.createHmac('sha256', KEY).update(s).digest('base64url');
function issueToken(lower, rec) {
  const p = b64({ u: lower, pv: rec.pv, e: Date.now() + TOKEN_DAYS * 86400000 });
  return p + '.' + sig(p);
}
async function verifyToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const [p, s] = token.split('.');
    if (!p || !s) return null;
    const want = Buffer.from(sig(p));
    const got = Buffer.from(s);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!(o.e > Date.now())) return null;
    if (!ready) await ensureReady();
    const rec = await getRec(o.u);
    if (!rec || rec.pv !== o.pv) return null;
    return { lower: o.u, name: rec.u };
  } catch {
    return null;
  }
}

// ---------- operasi akun ----------
function validUsername(name) {
  name = String(name || '').trim();
  if (!USER_RE.test(name)) throw httpErr(400, 'Username 3-14 karakter: huruf, angka, titik, strip, atau underscore');
  if (RESERVED.has(name.toLowerCase())) throw httpErr(400, 'Username itu tidak boleh dipakai');
  return name;
}

async function register(username, password) {
  await ensureReady();
  const name = validUsername(username);
  validPassword(password);
  const lower = name.toLowerCase();
  if (pub.has(lower)) throw httpErr(409, 'Username sudah dipakai');
  if (pub.size >= MAX_USERS) throw httpErr(503, 'Pendaftaran penuh');
  const pubv = { u: name, av: 0, c: Date.now() };
  pub.set(lower, pubv); // tandai dulu supaya tidak ada pendaftar ganda bersamaan
  try {
    const salt = crypto.randomBytes(16);
    const hash = (await scrypt(password, salt)).toString('hex');
    const rec = { u: name, salt: salt.toString('hex'), hash, pv: 1, c: pubv.c };
    await store.runMany([
      ['SET', 'usr:' + lower, JSON.stringify(rec)],
      ['HSET', 'usr:pub', lower, JSON.stringify(pubv)],
    ]);
    recs.set(lower, rec);
    return { lower, rec };
  } catch (e) {
    pub.delete(lower);
    throw e;
  }
}

async function login(username, password) {
  await ensureReady();
  const lower = lowerOf(username);
  const rec = USER_RE.test(String(username || '')) ? await getRec(lower) : null;
  const ok = await checkPassword(rec, password);
  return ok ? { lower, rec } : null;
}

async function changePassword(lower, oldPw, newPw) {
  await ensureReady();
  const rec = await getRec(lower);
  if (!rec || !(await checkPassword(rec, oldPw))) throw httpErr(401, 'Password lama salah');
  validPassword(newPw);
  const salt = crypto.randomBytes(16);
  const next = { ...rec, salt: salt.toString('hex'), hash: (await scrypt(newPw, salt)).toString('hex'), pv: rec.pv + 1 };
  await store.run(['SET', 'usr:' + lower, JSON.stringify(next)]);
  recs.set(lower, next);
  return next;
}

// untuk admin: ganti password dengan sandi sementara (dilihat admin sekali saja)
async function adminReset(lower) {
  await ensureReady();
  const rec = await getRec(lower);
  if (!rec) throw httpErr(404, 'Akun tidak ditemukan');
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let temp = '';
  for (let i = 0; i < 10; i++) temp += chars[crypto.randomInt(chars.length)];
  const salt = crypto.randomBytes(16);
  const next = { ...rec, salt: salt.toString('hex'), hash: (await scrypt(temp, salt)).toString('hex'), pv: rec.pv + 1 };
  await store.run(['SET', 'usr:' + lower, JSON.stringify(next)]);
  recs.set(lower, next);
  return temp;
}

async function deleteAccount(lower) {
  await ensureReady();
  if (!pub.has(lower)) throw httpErr(404, 'Akun tidak ditemukan');
  await store.runMany([['DEL', 'usr:' + lower], ['HDEL', 'usr:pub', lower], ['DEL', 'avt:' + lower]]);
  pub.delete(lower);
  recs.delete(lower);
  avatars.delete(lower);
}

// ---------- foto profil ----------
function checkImage(dataUri) {
  const m = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUri || ''));
  if (!m) throw httpErr(400, 'Format harus PNG, WebP, atau JPEG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) throw httpErr(413, `Ukuran foto maksimal ${AVATAR_MAX_BYTES / 1024} KB`);
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpg = buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const webp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!((m[1] === 'image/png' && png) || (m[1] === 'image/jpeg' && jpg) || (m[1] === 'image/webp' && webp))) {
    throw httpErr(400, 'Isi file tidak cocok dengan formatnya');
  }
  return { mime: m[1], buf, b64: m[2] };
}

async function setAvatar(lower, dataUri) {
  await ensureReady();
  const p = pub.get(lower);
  if (!p) throw httpErr(404, 'Akun tidak ditemukan');
  const img = checkImage(dataUri);
  const next = { ...p, av: (p.av || 0) + 1, ap: 1 }; // av = nomor versi (agar cache browser tidak basi), ap = punya foto
  await store.runMany([
    ['SET', 'avt:' + lower, JSON.stringify({ mime: img.mime, b64: img.b64 })],
    ['HSET', 'usr:pub', lower, JSON.stringify(next)],
  ]);
  pub.set(lower, next);
  avatars.set(lower, { mime: img.mime, buf: img.buf });
  return next.av;
}

async function deleteAvatar(lower) {
  await ensureReady();
  const p = pub.get(lower);
  if (!p) throw httpErr(404, 'Akun tidak ditemukan');
  if (!p.ap) return;
  const next = { ...p, ap: 0, av: (p.av || 0) + 1 };
  await store.runMany([['DEL', 'avt:' + lower], ['HSET', 'usr:pub', lower, JSON.stringify(next)]]);
  pub.set(lower, next);
  avatars.delete(lower);
}

async function getAvatar(lower) {
  const p = pub.get(lower);
  if (!p || !p.ap) return null;
  if (avatars.has(lower)) return avatars.get(lower);
  const raw = await store.run(['GET', 'avt:' + lower]);
  if (!raw) return null;
  const o = JSON.parse(raw);
  const v = { mime: o.mime, buf: Buffer.from(o.b64, 'base64') };
  avatars.set(lower, v);
  return v;
}

module.exports = {
  AVATAR_MAX_BYTES,
  MIN_PASS,
  isStableSecret: () => stableSecret,
  load,
  isReady: () => ready,
  loadError: () => loadErr,
  register,
  login,
  changePassword,
  adminReset,
  deleteAccount,
  setAvatar,
  deleteAvatar,
  getAvatar,
  issueToken,
  verifyToken,
  isReserved: (name) => pub.has(lowerOf(name)),
  info: (lower) => pub.get(lower) || null,
  avOf: (lower) => (lower && pub.get(lower) && pub.get(lower).ap ? pub.get(lower).av || 1 : 0),
  nameOf: (lower) => (pub.get(lower) ? pub.get(lower).u : null),
  list: () =>
    [...pub.entries()]
      .map(([lower, v]) => ({ lower, name: v.u, av: v.ap ? v.av || 1 : 0, created: v.c }))
      .sort((a, b) => a.created - b.created),
  count: () => pub.size,
  httpErr,
};
