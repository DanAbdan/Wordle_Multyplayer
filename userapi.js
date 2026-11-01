'use strict';
// Rute HTTP untuk akun pemain, foto profil, dan peringkat.
const accounts = require('./accounts');
const ranks = require('./ranks');

const COOKIE = 'tk_u';
const MAX_AGE = 30 * 86400;

function limiter(max, windowMs) {
  const m = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of m) if (now - v.t > windowMs) m.delete(k);
  }, 60000).unref();
  return {
    hit(key) {
      const now = Date.now();
      let v = m.get(key);
      if (!v || now - v.t > windowMs) v = { n: 0, t: now };
      v.n += 1;
      m.set(key, v);
      return v.n <= max;
    },
    over(key) {
      const v = m.get(key);
      return !!v && Date.now() - v.t <= windowMs && v.n >= max;
    },
    clear(key) {
      m.delete(key);
    },
  };
}

function init({ json, readBody, getCookie, clientIp, isHttps, baseHeaders }) {
  const loginIp = limiter(60, 10 * 60 * 1000);
  const loginFail = limiter(8, 15 * 60 * 1000);
  const regIp = limiter(30, 60 * 60 * 1000);
  const readIp = limiter(120, 60 * 1000);
  const avIp = limiter(10, 60 * 60 * 1000);

  const cookieOpts = (req) => 'HttpOnly; SameSite=Lax; Path=/' + (isHttps(req) ? '; Secure' : '');
  const setCookie = (req, token) => ({ 'Set-Cookie': `${COOKIE}=${token}; ${cookieOpts(req)}; Max-Age=${MAX_AGE}` });
  const clearCookie = (req) => ({ 'Set-Cookie': `${COOKIE}=; ${cookieOpts(req)}; Max-Age=0` });

  // anti-CSRF: permintaan yang mengubah data wajib punya header khusus, dan Origin (kalau ada) harus sama dengan Host
  function sameSite(req) {
    if (req.headers['x-app'] !== '1') return false;
    const o = req.headers.origin;
    if (!o) return true;
    try {
      return new URL(o).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function body(req, limit) {
    try {
      const b = JSON.parse(await readBody(req, limit));
      return b && typeof b === 'object' ? b : {};
    } catch (e) {
      throw accounts.httpErr(e.status || 400, e.status ? e.message : 'Permintaan tidak valid');
    }
  }

  async function userOf(req) {
    return accounts.verifyToken(getCookie(req, COOKIE));
  }

  async function meView(user) {
    const w = await ranks.mine(user.lower);
    return { name: user.name, av: accounts.avOf(user.lower), poin: w.poin, benar: w.benar, period: w.period, endsAt: w.endsAt };
  }

  // mengembalikan true kalau rute ditangani
  async function handle(req, res, p) {
    const isApi = p.startsWith('/api/') && p !== '/api/stickers';
    const isAv = p.startsWith('/av/');
    if (!isApi && !isAv) return false;
    const ip = clientIp(req);
    try {
      if (isAv) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false }), true;
        const a = await accounts.getAvatar(p.slice(4).toLowerCase());
        if (!a) {
          res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }));
          res.end('Tidak ada');
          return true;
        }
        res.writeHead(
          200,
          baseHeaders({ 'Content-Type': a.mime, 'Content-Length': a.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' })
        );
        res.end(req.method === 'HEAD' ? undefined : a.buf);
        return true;
      }

      if (req.method !== 'GET' && !sameSite(req)) return json(res, 403, { ok: false, error: 'Ditolak' }), true;

      if (p === '/api/me' && req.method === 'GET') {
        if (!getCookie(req, COOKIE)) return json(res, 200, { ok: true, user: null }), true;
        if (!readIp.hit('me:' + ip)) return json(res, 429, { ok: false, error: 'Terlalu sering' }), true;
        const u = await userOf(req);
        if (!u) return json(res, 200, { ok: true, user: null }, clearCookie(req)), true;
        return json(res, 200, { ok: true, user: await meView(u) }), true;
      }

      if (p === '/api/rank' && req.method === 'GET') {
        if (!readIp.hit('rank:' + ip)) return json(res, 429, { ok: false, error: 'Terlalu sering, tunggu sebentar' }), true;
        const week = new URL(req.url, 'http://x').searchParams.get('week') || '';
        return json(res, 200, { ok: true, ...(await ranks.view(week)) }, { 'Cache-Control': 'no-cache' }), true;
      }

      if (p === '/api/register' && req.method === 'POST') {
        if (!regIp.hit('reg:' + ip)) return json(res, 429, { ok: false, error: 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.' }), true;
        const b = await body(req, 2048);
        const { lower, rec } = await accounts.register(b.username, b.password);
        const user = { lower, name: rec.u };
        return json(res, 200, { ok: true, user: await meView(user) }, setCookie(req, accounts.issueToken(lower, rec))), true;
      }

      if (p === '/api/login' && req.method === 'POST') {
        if (!loginIp.hit('login:' + ip)) return json(res, 429, { ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' }), true;
        const b = await body(req, 2048);
        const fk = ip + '|' + String(b.username || '').toLowerCase().slice(0, 20);
        if (loginFail.over(fk)) return json(res, 429, { ok: false, error: 'Terlalu banyak salah password. Coba lagi 15 menit lagi.' }), true;
        const r = await accounts.login(b.username, b.password);
        if (!r) {
          loginFail.hit(fk);
          return json(res, 401, { ok: false, error: 'Username atau password salah' }), true;
        }
        loginFail.clear(fk);
        const user = { lower: r.lower, name: r.rec.u };
        return json(res, 200, { ok: true, user: await meView(user) }, setCookie(req, accounts.issueToken(r.lower, r.rec))), true;
      }

      if (p === '/api/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true }, clearCookie(req)), true;
      }

      // di bawah ini wajib login
      const u = await userOf(req);
      if (!u) return json(res, 401, { ok: false, error: 'Belum login' }), true;

      if (p === '/api/password' && req.method === 'POST') {
        if (!loginIp.hit('pw:' + ip)) return json(res, 429, { ok: false, error: 'Terlalu banyak percobaan' }), true;
        const b = await body(req, 2048);
        const rec = await accounts.changePassword(u.lower, b.old, b.next);
        return json(res, 200, { ok: true }, setCookie(req, accounts.issueToken(u.lower, rec))), true;
      }

      if (p === '/api/avatar' && req.method === 'POST') {
        if (!avIp.hit('av:' + u.lower)) return json(res, 429, { ok: false, error: 'Terlalu sering ganti foto, coba lagi nanti' }), true;
        const b = await body(req, 100 * 1024);
        const av = await accounts.setAvatar(u.lower, b.data);
        return json(res, 200, { ok: true, av: accounts.avOf(u.lower) || av }), true;
      }
      if (p === '/api/avatar' && req.method === 'DELETE') {
        await accounts.deleteAvatar(u.lower);
        return json(res, 200, { ok: true, av: 0 }), true;
      }

      return json(res, 404, { ok: false, error: 'Tidak ditemukan' }), true;
    } catch (e) {
      if (e.status) return json(res, e.status, { ok: false, error: e.message }), true;
      console.error('api error', e);
      return json(res, 500, { ok: false, error: 'Terjadi kesalahan di server' }), true;
    }
  }

  return { handle, userOf, COOKIE };
}

module.exports = { init };
