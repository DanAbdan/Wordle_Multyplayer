'use strict';
// Pengaturan yang bisa diubah admin dari panel (disimpan di Upstash, disalin di memori).
const store = require('./store');

const DEFAULTS = { period: 'weekly', stickerSize: 44 };
const LIMITS = { stickerSize: [28, 120] };
let cur = { ...DEFAULTS };
let loaded = false;
let loading = null;

function sanitize(o) {
  const out = { ...DEFAULTS };
  if (o && (o.period === 'weekly' || o.period === 'monthly')) out.period = o.period;
  const raw = o ? o.stickerSize : undefined;
  const n = raw === undefined || raw === null || raw === '' ? NaN : Math.round(Number(raw));
  if (Number.isFinite(n)) out.stickerSize = Math.min(LIMITS.stickerSize[1], Math.max(LIMITS.stickerSize[0], n));
  return out;
}

function load() {
  if (loaded) return Promise.resolve(cur);
  if (loading) return loading;
  loading = store
    .run(['GET', 'cfg:settings'])
    .then((raw) => {
      try {
        cur = sanitize(raw ? JSON.parse(raw) : null);
      } catch {
        cur = { ...DEFAULTS };
      }
      loaded = true;
      return cur;
    })
    .catch((e) => {
      console.error('Gagal memuat pengaturan, pakai bawaan:', e.message);
      return cur;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function update(patch) {
  await load();
  const next = sanitize({ ...cur, ...patch });
  await store.run(['SET', 'cfg:settings', JSON.stringify(next)]);
  cur = next;
  loaded = true;
  return cur;
}

module.exports = { load, update, get: () => cur, LIMITS, isLoaded: () => loaded };
