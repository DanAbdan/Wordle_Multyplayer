'use strict';
// Lapisan penyimpanan: Upstash Redis (REST) kalau URL+token diisi, kalau tidak pakai Redis mini di memori
// (dipakai saat uji coba di komputer sendiri; datanya hilang saat server berhenti).
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);

let commands = 0; // jumlah perintah yang dikirim ke Upstash sejak server menyala (memantau kuota)

async function post(path, body) {
  const r = await fetch(REDIS_URL + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let j = {};
  try {
    j = await r.json();
  } catch {}
  if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
  return j;
}

// satu perintah, contoh: redis(['GET', 'kunci'])
async function redis(cmd) {
  commands += 1;
  const j = await post('', cmd);
  if (j.error) throw new Error(j.error);
  return j.result;
}

// beberapa perintah sekaligus dalam satu permintaan HTTP (tiap perintah tetap dihitung kuota)
async function pipeline(cmds) {
  if (!cmds.length) return [];
  commands += cmds.length;
  const arr = await post('/pipeline', cmds);
  if (!Array.isArray(arr)) throw new Error('Respons pipeline tidak valid');
  return arr.map((x) => {
    if (x && x.error) throw new Error(x.error);
    return x ? x.result : null;
  });
}

// ---------- Redis mini di memori (hanya perintah yang dipakai game ini) ----------
function makeMem() {
  const data = new Map(); // key -> {t, v}
  const get = (key, t, make) => {
    let e = data.get(key);
    if (!e) {
      if (!make) return null;
      e = { t, v: make() };
      data.set(key, e);
    }
    if (e.t !== t) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e.v;
  };
  function exec(cmd) {
    const op = String(cmd[0]).toUpperCase();
    const key = cmd[1];
    const a = cmd.slice(2).map(String);
    switch (op) {
      case 'GET': {
        const v = get(key, 's');
        return v === null ? null : v;
      }
      case 'SET':
        if (a[1] && a[1].toUpperCase() === 'NX' && data.has(key)) return null;
        data.set(key, { t: 's', v: a[0] });
        return 'OK';
      case 'DEL': {
        let n = 0;
        for (const k of [key, ...a]) if (data.delete(k)) n++;
        return n;
      }
      case 'HSET': {
        const h = get(key, 'h', () => new Map());
        let n = 0;
        for (let i = 0; i < a.length; i += 2) {
          if (!h.has(a[i])) n++;
          h.set(a[i], a[i + 1]);
        }
        return n;
      }
      case 'HGET': {
        const h = get(key, 'h');
        return h && h.has(a[0]) ? h.get(a[0]) : null;
      }
      case 'HDEL': {
        const h = get(key, 'h');
        let n = 0;
        if (h) for (const f of a) if (h.delete(f)) n++;
        return n;
      }
      case 'HGETALL': {
        const h = get(key, 'h');
        const out = [];
        if (h) for (const [k, v] of h) out.push(k, v);
        return out;
      }
      case 'SADD': {
        const s = get(key, 'set', () => new Set());
        let n = 0;
        for (const m of a) if (!s.has(m)) { s.add(m); n++; }
        return n;
      }
      case 'SMEMBERS': {
        const s = get(key, 'set');
        return s ? [...s] : [];
      }
      case 'ZADD': {
        const z = get(key, 'z', () => new Map());
        let n = 0;
        for (let i = 0; i < a.length; i += 2) {
          if (!z.has(a[i + 1])) n++;
          z.set(a[i + 1], Number(a[i]));
        }
        return n;
      }
      case 'ZREM': {
        const z = get(key, 'z');
        let n = 0;
        if (z) for (const m of a) if (z.delete(m)) n++;
        return n;
      }
      case 'ZREVRANGE': {
        const z = get(key, 'z');
        if (!z) return [];
        const sorted = [...z.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1));
        let start = Number(a[0]);
        let stop = Number(a[1]);
        if (start < 0) start += sorted.length;
        if (stop < 0) stop += sorted.length;
        const part = sorted.slice(Math.max(0, start), stop + 1);
        const out = [];
        for (const [m, s] of part) {
          out.push(m);
          if (String(a[2] || '').toUpperCase() === 'WITHSCORES') out.push(String(s));
        }
        return out;
      }
      case 'ZSCORE': {
        const z = get(key, 'z');
        return z && z.has(a[0]) ? String(z.get(a[0])) : null;
      }
      default:
        throw new Error('ERR perintah tidak dikenal: ' + op);
    }
  }
  return { exec, data };
}

const mem = makeMem();

const run = (cmd) => (USE_REDIS ? redis(cmd) : Promise.resolve().then(() => mem.exec(cmd)));
const runMany = (cmds) => (USE_REDIS ? pipeline(cmds) : Promise.resolve().then(() => cmds.map((c) => mem.exec(c))));

module.exports = { USE_REDIS, REDIS_URL, REDIS_TOKEN, redis, pipeline, run, runMany, makeMem, getCommandCount: () => commands };
