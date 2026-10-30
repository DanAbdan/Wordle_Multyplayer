'use strict';
// Peringkat mingguan (Senin 00:00 - Minggu 23:59 WIB). Dua papan: jumlah jawaban benar dan streak benar terbanyak.
// Dicatat HANYA saat game selesai sampai akhir (game yang dibatalkan tidak dihitung), dan hanya untuk pemain yang login.
// Data tiap minggu disimpan terpisah di Upstash, jadi minggu lalu tidak berubah. Server menyimpan salinan papan di
// memori (satu instance), sehingga membuka peringkat tidak memakai perintah Upstash setelah papan termuat.
const store = require('./store');

const SHIFT_MS = Number(process.env.WEEK_SHIFT_DAYS || 0) * 86400000; // hanya untuk uji coba pergantian minggu
const WIB_MS = 7 * 3600 * 1000;
const TOP_N = 50;
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

// id minggu = tanggal hari Senin (WIB), contoh '2026-10-26'
function weekId(ms = Date.now()) {
  const t = new Date(ms + SHIFT_MS + WIB_MS);
  const dow = (t.getUTCDay() + 6) % 7; // Senin = 0
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - dow)).toISOString().slice(0, 10);
}
function weekEndsAt(id) {
  const [y, m, d] = id.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 7) - WIB_MS - SHIFT_MS; // Senin berikutnya 00:00 WIB
}

const boards = new Map(); // week -> {benar: Map(nama->skor), streak: Map, loading}
const weekly = new Map(); // lower -> {w, cur, best, benar}
const dirty = new Map(); // lower -> nama (rekam yang belum tersimpan di Upstash)
let knownWeeks = null; // Set id minggu yang punya data
let flushing = null;
let retryTimer = null;

function parseScores(flat) {
  const m = new Map();
  for (let i = 0; i < (flat || []).length; i += 2) m.set(flat[i], Number(flat[i + 1]));
  return m;
}

async function ensureBoard(week) {
  let b = boards.get(week);
  if (b && b.ready) return b;
  if (b && b.loading) return b.loading;
  b = b || { benar: new Map(), streak: new Map(), ready: false, loading: null };
  boards.set(week, b);
  b.loading = (async () => {
    try {
      const [a, s] = await store.runMany([
        ['ZREVRANGE', 'lb:' + week + ':benar', 0, -1, 'WITHSCORES'],
        ['ZREVRANGE', 'lb:' + week + ':streak', 0, -1, 'WITHSCORES'],
      ]);
      // gabungkan dengan perubahan yang sudah terjadi di memori selama memuat
      const pa = parseScores(a);
      const ps = parseScores(s);
      for (const [k, v] of b.benar) pa.set(k, Math.max(v, pa.get(k) || 0));
      for (const [k, v] of b.streak) ps.set(k, Math.max(v, ps.get(k) || 0));
      b.benar = pa;
      b.streak = ps;
      b.ready = true;
      return b;
    } finally {
      b.loading = null;
    }
  })();
  return b.loading;
}

async function ensureWeeks() {
  if (knownWeeks) return knownWeeks;
  const list = await store.run(['SMEMBERS', 'lb:weeks']);
  knownWeeks = new Set((list || []).filter((w) => WEEK_RE.test(w)));
  return knownWeeks;
}

async function loadWeekly(lower) {
  if (weekly.has(lower)) return weekly.get(lower);
  const raw = await store.run(['GET', 'ws:' + lower]);
  let rec = null;
  try {
    rec = raw ? JSON.parse(raw) : null;
  } catch {}
  if (rec) weekly.set(lower, rec);
  return rec;
}

// players: [{lower, name, rounds: [true/false, ...]}]  (urut dari ronde pertama; true = jawaban benar)
async function applyGame(week, players) {
  const b = await ensureBoard(week);
  await ensureWeeks();
  const recs = [];
  for (const p of players) recs.push(await loadWeekly(p.lower)); // semua dimuat dulu; kalau gagal, belum ada yang berubah
  players.forEach((p, i) => {
    let rec = recs[i];
    if (!rec || rec.w !== week) rec = { w: week, cur: 0, best: 0, benar: 0 };
    for (const ok of p.rounds) {
      if (ok) {
        rec.cur += 1;
        rec.benar += 1;
        if (rec.cur > rec.best) rec.best = rec.cur;
      } else rec.cur = 0;
    }
    weekly.set(p.lower, rec);
    if (rec.benar > 0) b.benar.set(p.name, rec.benar);
    if (rec.best > 0) b.streak.set(p.name, rec.best);
    dirty.set(p.lower, p.name);
  });
  knownWeeks.add(week);
  await flush();
}

// tulis semua rekam yang berubah ke Upstash (satu permintaan; nilai absolut, jadi aman diulang)
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!dirty.size) return;
      const snap = [...dirty.entries()];
      const sent = new Map();
      const cmds = [];
      const weeks = new Set();
      for (const [lower, name] of snap) {
        const rec = weekly.get(lower);
        if (!rec) continue;
        sent.set(lower, JSON.stringify(rec));
        weeks.add(rec.w);
        cmds.push(['SET', 'ws:' + lower, JSON.stringify(rec)]);
        if (rec.benar > 0) cmds.push(['ZADD', 'lb:' + rec.w + ':benar', rec.benar, name]);
        if (rec.best > 0) cmds.push(['ZADD', 'lb:' + rec.w + ':streak', rec.best, name]);
      }
      for (const w of weeks) if (!flushedWeeks.has(w)) cmds.push(['SADD', 'lb:weeks', w]);
      await store.runMany(cmds);
      for (const w of weeks) flushedWeeks.add(w);
      for (const [lower] of snap) {
        // hanya hapus tanda kalau rekam tidak berubah lagi selama menulis
        if (!weekly.has(lower) || JSON.stringify(weekly.get(lower)) === sent.get(lower)) dirty.delete(lower);
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
const flushedWeeks = new Set();
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (dirty.size) flush();
  }, 30000);
  retryTimer.unref();
}

// catat satu game yang selesai (tidak melempar error). Kalau Upstash sedang bermasalah, game disimpan di antrean
// dan dicoba lagi tiap 30 detik (maks. 50 game dalam antrean), jadi hasil tidak hilang.
const backlog = [];
let backlogTimer = null;
function scheduleBacklog() {
  if (backlogTimer || !backlog.length) return;
  backlogTimer = setTimeout(async () => {
    backlogTimer = null;
    const items = backlog.splice(0);
    for (const it of items) {
      try {
        await applyGame(it.week, it.players);
      } catch (e) {
        backlog.push(it);
      }
    }
    scheduleBacklog();
  }, 30000);
  backlogTimer.unref();
}
async function recordGame(players) {
  if (!players.length) return;
  const week = weekId();
  try {
    return await applyGame(week, players);
  } catch (e) {
    console.error('Gagal mencatat game ke peringkat, masuk antrean:', e.message);
    if (backlog.length < 50) backlog.push({ week, players });
    scheduleBacklog();
  }
}

function top(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1))
    .slice(0, TOP_N)
    .map(([n, s]) => ({ n, s }));
}

async function view(week) {
  const cur = weekId();
  if (!week || !WEEK_RE.test(week)) week = cur;
  if (week > cur) week = cur;
  const b = await ensureBoard(week);
  const weeks = new Set(await ensureWeeks());
  weeks.add(cur);
  return {
    week,
    current: week === cur,
    endsAt: weekEndsAt(week),
    weeks: [...weeks].sort().reverse().slice(0, 13),
    benar: top(b.benar),
    streak: top(b.streak),
  };
}

// statistik minggu ini milik satu akun
async function mine(lower) {
  const rec = await loadWeekly(lower);
  const cur = weekId();
  return rec && rec.w === cur ? { benar: rec.benar, best: rec.best } : { benar: 0, best: 0 };
}

async function removeUser(lower, name) {
  const weeks = [...(await ensureWeeks())];
  const cmds = [['DEL', 'ws:' + lower]];
  for (const w of weeks) cmds.push(['ZREM', 'lb:' + w + ':benar', name], ['ZREM', 'lb:' + w + ':streak', name]);
  await store.runMany(cmds);
  weekly.delete(lower);
  dirty.delete(lower);
  for (const b of boards.values()) {
    b.benar.delete(name);
    b.streak.delete(name);
  }
}

module.exports = { weekId, weekEndsAt, recordGame, applyGame, view, mine, removeUser, flush, pendingCount: () => dirty.size + backlog.length };
