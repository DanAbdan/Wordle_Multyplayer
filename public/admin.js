'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  const HDR = { 'Content-Type': 'application/json', 'X-Panel': '1' };
  const MAX_BYTES = 110 * 1024;

  // tema
  const root = document.documentElement;
  function applyTheme(t) { root.dataset.theme = t; $('btn-theme').textContent = t === 'dark' ? '☀' : '☾'; }
  let th = null;
  try { th = localStorage.getItem('theme'); } catch {}
  applyTheme(th || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('btn-theme').onclick = () => {
    const t = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('theme', t); } catch {}
  };

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin', headers: HDR }, opts));
    let j = {};
    try { j = await r.json(); } catch {}
    return { status: r.status, j };
  }

  function view(name) {
    for (const v of ['loading', 'disabled', 'login', 'panel']) show(v, v === name);
  }

  async function boot() {
    const { status, j } = await api('/admin/api/me', { method: 'GET', headers: {} });
    if (status === 503 || j.enabled === false) return view('disabled');
    if (status === 401) return view('login');
    if (j.ok) return renderPanel(j);
    view('login');
  }

  // login
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    $('login-err').textContent = '';
    $('login-btn').disabled = true;
    const { status, j } = await api('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('u').value, password: $('p').value }),
    });
    $('login-btn').disabled = false;
    if (j.ok) {
      $('p').value = '';
      return boot();
    }
    $('login-err').textContent = j.error || (status === 429 ? 'Terlalu banyak percobaan' : 'Gagal masuk');
  };
  $('logout').onclick = async () => {
    await api('/admin/api/logout', { method: 'POST', body: '{}' });
    view('login');
  };

  // panel
  let max = 5;
  let list = [];
  function renderPanel(j) {
    view('panel');
    max = j.max || 5;
    list = j.stickers || [];
    const s = $('storage');
    s.textContent = '';
    const b = document.createElement('div');
    if (!j.storageOk) {
      b.className = 'bad-banner';
      b.textContent = 'Penyimpanan Upstash belum tersambung: ' + (j.storageErr || 'cek ulang URL dan token di Environment Render') + '. Menambah/menghapus dinonaktifkan sampai tersambung.';
    } else if (!j.persistent) {
      b.className = 'warn-banner';
      b.textContent = 'Penyimpanan permanen BELUM diatur. Emoticon akan hilang saat server restart/tidur. Ikuti langkah Upstash di panduan (README), lalu isi UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN di Render.';
    } else {
      b.className = 'ok-banner';
      b.textContent = 'Tersimpan permanen (Upstash). Emoticon aman walau server restart.';
    }
    s.appendChild(b);
    renderList(j.storageOk);
  }

  function renderList(storageOk = true) {
    const grid = $('grid');
    grid.textContent = '';
    $('count').textContent = `${list.length}/${max}`;
    show('empty', list.length === 0);
    for (const s of list) {
      const item = document.createElement('div');
      item.className = 'st-item';
      const box = document.createElement('div');
      box.className = 'img';
      const img = document.createElement('img');
      img.src = '/s/' + s.id;
      img.alt = 'emoticon';
      box.appendChild(img);
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = 'Hapus';
      del.disabled = !storageOk;
      del.onclick = async () => {
        if (!confirm('Hapus emoticon ini?')) return;
        del.disabled = true;
        const { j } = await api('/admin/api/stickers/' + s.id, { method: 'DELETE' });
        if (j.ok) { list = j.stickers; renderList(); toast('Emoticon dihapus'); }
        else { toast(j.error || 'Gagal menghapus'); del.disabled = false; }
      };
      item.appendChild(box);
      item.appendChild(del);
      grid.appendChild(item);
    }
    $('file').disabled = list.length >= max || !storageOk;
    if (list.length >= max) $('up-err').textContent = `Sudah ${max} emoticon. Hapus satu dulu untuk menambah.`;
    else if ($('up-err').textContent.startsWith('Sudah')) $('up-err').textContent = '';
  }

  // proses gambar -> stiker kecil di browser
  let pendingData = null;
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto tidak bisa dibaca')); };
      img.src = url;
    });
  }
  function toBlob(canvas, type, q) {
    return new Promise((res) => canvas.toBlob(res, type, q));
  }
  async function makeSticker(file) {
    const img = await loadImage(file);
    for (const size of [192, 160, 128, 96]) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const sc = Math.min(size / img.width, size / img.height);
      const w = img.width * sc, h = img.height * sc;
      g.clearRect(0, 0, size, size);
      g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      for (const q of [0.9, 0.8, 0.65]) {
        let blob = await toBlob(c, 'image/webp', q);
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(c, 'image/png');
        if (blob && blob.size <= MAX_BYTES) return blob;
        if (blob && blob.type === 'image/png') break; // PNG tidak punya kualitas, perkecil ukuran saja
      }
    }
    throw new Error('Foto terlalu rumit untuk diperkecil, coba foto lain');
  }
  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('Gagal membaca'));
      fr.readAsDataURL(blob);
    });
  }

  $('file').onchange = async (e) => {
    const f = e.target.files[0];
    pendingData = null;
    show('preview', false);
    $('up-err').textContent = '';
    if (!f) return;
    try {
      const blob = await makeSticker(f);
      pendingData = await blobToDataUrl(blob);
      $('prev-img').src = pendingData;
      $('prev-info').textContent = `Hasil: ${Math.round(blob.size / 1024)} KB (${blob.type.replace('image/', '').toUpperCase()})`;
      show('preview', true);
    } catch (err) {
      $('up-err').textContent = err.message;
    }
  };

  $('add-btn').onclick = async () => {
    if (!pendingData) return;
    $('add-btn').disabled = true;
    $('up-err').textContent = '';
    const { j } = await api('/admin/api/stickers', { method: 'POST', body: JSON.stringify({ data: pendingData }) });
    $('add-btn').disabled = false;
    if (j.ok) {
      list = j.stickers;
      pendingData = null;
      $('file').value = '';
      show('preview', false);
      renderList();
      toast('Emoticon ditambahkan');
    } else {
      $('up-err').textContent = j.error || 'Gagal menambahkan';
    }
  };

  boot().catch(() => { view('login'); });
})();
