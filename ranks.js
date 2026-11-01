'use strict';
// Poin dan peringkat per periode (mingguan: Senin-Minggu, atau bulanan; zona WIB). Periode diatur admin (settings.js).
// Tiap akun punya saldo poin ("poin") dan jumlah jawaban benar ("benar") untuk periode berjalan. Saat periode ganti,
// angka akun mulai dari 0 lagi, sedangkan data periode lama tetap tersimpan dan bisa dilihat.
// Dicatat hanya saat game selesai (game yang dibatalkan tidak dihitung) dan hanya untuk pemain yang login.
// Papan peringkat disalin di memori (satu instance), jadi membuka peringkat tidak memakai perintah Upstash.
const store = require('./store');
const settings = require('./settings');

const SHIFT_MS = Number(process.env.WEEK_SHIFT_DAYS || 0) * 86400000; // hanya untuk uji coba pergantian periode
const WIB_MS = 7 * 3600 * 1000;
const TOP_N = 50;
const ID_RE = /^\d{4}-\d{2}(-\d{2})?$/;

// id periode: mingguan = tanggal Senin ('2026-10-26'), bulanan = '2026-10'
function periodId(ms = Date.now(), period = settings.get().period) {
  const t = new Date(ms + SHIFT_MS + WIB_MS);
  if (period === 'monthly') return t.toISOString().slice(0, 7);
  const dow = (t.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - dow)).toISOString().slice(0, 10);
}
function periodEnd(id) {
  const p = id.split('-').map(Number);
  const end = p.length === 3 ? Date.UTC(p[0], p[1] - 1, p[2] + 7) : Date.UTC(p[0], p[1], 1);
  return end - WIB_MS - SHIFT_MS;
}

const boards = new Map(); // id -> {poin: Map(nama->nilai), benar: Map, ready, loading}
const recs = new Map(); // lower -> {w, benar, poin}
const dirty = new Map(); // lower -> nama (belum tersimpan di Upstash)
const flushedPeriods = new Set();
let known = null; // Set id periode yang punya data
let flushing = null;
let retryTimer = null;
const backlog = [];
let backlogTimer = null;

function parseScores(flat) {
  const m = new Map();
  for (let i = 0; i < (flat || []).length; i += 2) m.set(flat[i], Number(flat[i + 1]));
  return m;
}

async function ensureBoard(id) {
  let b = boards.get(id);
  if (b && b.ready) return b;
  if (b && b.loading) return b.loading;
  b = b || { poin: new Map(), benar: new Map(), ready: false, loading: null };
  boards.set(id, b);
  b.loading = (async () => {
    try {
      const [a, s] = await store.runMany([
        ['ZREVRANGE', 'lb:' + id + ':poin', 0, -1, 'WITHSCORES'],
        ['ZREVRANGE', 'lb:' + id + ':benar', 0, -1, 'WITHSCORES'],
      ]);
      const pa = parseScores(a);
      const ps = parseScores(s);
      for (const [k, v] of b.poin) pa.set(k, v); // perubahan di memori selama memuat menang
      for (const [k, v] of b.benar) ps.set(k, v);
      b.poin = pa;
      b.benar = ps;
      b.ready = true;
      return b;
    } finally {
      b.loading = null;
    }
  })();
  return b.loading;
}

async function ensureKnown() {
  if (known) return known;
  const list = await store.run(['SMEMBERS', 'lb:weeks']);
  known = new Set((list || []).filter((w) => ID_RE.test(w)));
  return known;
}

async function loadRec(lower) {
  if (recs.has(lower)) return recs.get(lower);
  const raw = await store.run(['GET', 'ws:' + lower]);
  let rec = null;
  try {
    rec = raw ? JSON.parse(raw) : null;
  } catch {}
  if (rec) {
    rec = { w: rec.w, benar: Number(rec.benar) || 0, poin: Number(rec.poin) || 0 };
    recs.set(lower, rec);
  }
  return rec;
}
const fresh = (id) => ({ w: id, benar: 0, poin: 0 });

// entries: [{lower, name, pts, benar}]; duel: {winner: lower, loser: lower, amount} (opsional)
async function applyGame(id, entries, duel) {
  const b = await ensureBoard(id);
  await ensureKnown();
  const loaded = [];
  for (const e of entries) loaded.push(await loadRec(e.lower)); // semua dimuat dulu; kalau gagal belum ada yang berubah
  const work = new Map();
  entries.forEach((e, i) => {
    let rec = loaded[i];
    if (!rec || rec.w !== id) rec = fresh(id);
    else rec = { ...rec };
    rec.poin += Math.max(0, Math.round(e.pts || 0));
    rec.benar += Math.max(0, Math.round(e.benar || 0));
    work.set(e.lower, { rec, name: e.name });
  });
  if (duel && work.has(duel.winner) && work.has(duel.loser)) {
    const w = work.get(duel.winner).rec;
    const l = work.get(duel.loser).rec;
    const amt = Math.max(0, Math.min(Math.round(duel.amount || 0), l.poin)); // tidak boleh membuat saldo minus
    l.poin -= amt;
    w.poin += amt;
  }
  for (const [lower, { rec, name }] of work) {
    recs.set(lower, rec);
    if (rec.poin > 0 || b.poin.has(name)) b.poin.set(name, rec.poin);
    if (rec.benar > 0) b.benar.set(name, rec.benar);
    dirty.set(lower, name);
  }
  known.add(id);
  await flush();
}

// tulis semua rekam yang berubah ke Upstash dalam satu permintaan (nilai absolut, jadi aman diulang)
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!dirty.size) return;
      const snap = [...dirty.entries()];
      const sent = new Map();
      const cmds = [];
      const periods = new Set();
      for (const [lower, name] of snap) {
        const rec = recs.get(lower);
        if (!rec) continue;
        sent.set(lower, JSON.stringify(rec));
        periods.add(rec.w);
        cmds.push(['SET', 'ws:' + lower, sent.get(lower)]);
        const b = boards.get(rec.w);
        if (rec.poin > 0 || (b && b.poin.has(name))) cmds.push(['ZADD', 'lb:' + rec.w + ':poin', rec.poin, name]);
        if (rec.benar > 0) cmds.push(['ZADD', 'lb:' + rec.w + ':benar', rec.benar, name]);
      }
      for (const w of periods) if (!flushedPeriods.has(w)) cmds.push(['SADD', 'lb:weeks', w]);
      await store.runMany(cmds);
      for (const w of periods) flushedPeriods.add(w);
      for (const [lower] of snap) {
        if (!recs.has(lower) || JSON.stringify(recs.get(lower)) === sent.get(lower)) dirty.delete(lower);
      }
      if (dirty.size) scheduleRetry();
    } catch (e) {
      console.error('Gagal menyimpan peringkat, akan dicoba lagi:', e.message);
      scheduleRetry();
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (dirty.size) flush();
  }, 30000);
  retryTimer.unref();
}

function scheduleBacklog() {
  if (backlogTimer || !backlog.length) return;
  backlogTimer = setTimeout(async () => {
    backlogTimer = null;
    const items = backlog.splice(0);
    for (const it of items) {
      try {
        await applyGame(it.id, it.entries, it.duel);
      } catch {
        backlog.push(it);
      }
    }
    scheduleBacklog();
  }, 30000);
  backlogTimer.unref();
}

// catat satu game yang selesai. Tidak melempar error: kalau Upstash bermasalah, game masuk antrean (maks. 50)
// dan dicoba lagi tiap 30 detik, jadi hasilnya tidak hilang.
async function recordGame(entries, duel) {
  if (!entries.length) return;
  await settings.load();
  const id = periodId();
  try {
    return await applyGame(id, entries, duel);
  } catch (e) {
    console.error('Gagal mencatat game ke peringkat, masuk antrean:', e.message);
    if (backlog.length < 50) backlog.push({ id, entries, duel });
    scheduleBacklog();
  }
}

function top(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1))
    .slice(0, TOP_N)
    .map(([n, s]) => ({ n, s }));
}

async function view(id) {
  await settings.load();
  const cur = periodId();
  const k = await ensureKnown();
  if (!id || !ID_RE.test(id) || !(id === cur || k.has(id))) id = cur;
  const b = await ensureBoard(id);
  const all = new Set(k);
  all.add(cur);
  return {
    period: id.length === 7 ? 'monthly' : 'weekly',
    week: id,
    current: id === cur,
    endsAt: periodEnd(id),
    weeks: [...all].sort().reverse().slice(0, 14),
    poin: top(b.poin),
    benar: top(b.benar),
  };
}

// statistik akun untuk periode berjalan
async function mine(lower) {
  await settings.load();
  const id = periodId();
  const rec = await loadRec(lower);
  const ok = rec && rec.w === id;
  return { poin: ok ? rec.poin : 0, benar: ok ? rec.benar : 0, period: settings.get().period, id, endsAt: periodEnd(id) };
}

async function removeUser(lower, name) {
  const ids = [...(await ensureKnown())];
  const cmds = [['DEL', 'ws:' + lower]];
  for (const w of ids) cmds.push(['ZREM', 'lb:' + w + ':poin', name], ['ZREM', 'lb:' + w + ':benar', name], ['ZREM', 'lb:' + w + ':streak', name]);
  await store.runMany(cmds);
  recs.delete(lower);
  dirty.delete(lower);
  for (const b of boards.values()) {
    b.poin.delete(name);
    b.benar.delete(name);
  }
}

module.exports = { periodId, periodEnd, recordGame, applyGame, view, mine, removeUser, flush, pendingCount: () => dirty.size + backlog.length };
