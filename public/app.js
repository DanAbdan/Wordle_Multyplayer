'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const SKILLS = {
    intip: { ico: '🔍', name: 'Intip', desc: 'Tampilkan 1 huruf jawaban di posisinya.' },
    coret: { ico: '🚫', name: 'Coret', desc: 'Coret 3 huruf yang pasti tidak ada di jawaban.' },
    bekukan: { ico: '❄️', name: 'Bekukan', desc: 'Bekukan pemain peringkat teratas selama 6 detik.' },
    perisai: { ico: '🛡️', name: 'Perisai', desc: 'Otomatis menangkal 1 serangan Bekukan.' },
    ganda: { ico: '⚡', name: 'Skor Ganda', desc: 'Poin ronde ini ×2 jika benar, −100 jika gagal.' },
  };

  // ---------- Tema ----------
  const root = document.documentElement;
  function applyTheme(t) {
    root.dataset.theme = t;
    $('btn-theme').textContent = t === 'dark' ? '☀' : '☾';
    document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#12141b' : '#ffffff';
  }
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('theme'); } catch {}
  applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('btn-theme').onclick = () => {
    const t = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('theme', t); } catch {}
  };

  // ---------- Util ----------
  let toastTimer;
  function toast(msg, ms = 1800) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function colorFor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h}, 55%, 40%)`;
  }
  function avatar(name) {
    const a = el('div', 'avatar', (name[0] || '?').toUpperCase());
    a.style.background = colorFor(name);
    return a;
  }
  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function store(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }
  function load(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  // ---------- Koneksi ----------
  let ws = null;
  let st = null; // state terakhir dari server
  let myId = null;
  let offset = 0;
  let session = null; // {code, token, name}
  let leaving = false;
  let retry = 0;
  let pingTimer = null;

  try { session = JSON.parse(load('session') || 'null'); } catch { session = null; }

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function connect(onOpen) {
    if (ws && ws.readyState <= 1) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      retry = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: 'ping' }), 20000);
      onOpen && onOpen();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (leaving) return;
      if (session && session.code) {
        retry++;
        toast('Koneksi terputus, menyambung ulang…', 2500);
        setTimeout(() => connect(() => send({ t: 'join', code: session.code, token: session.token })), Math.min(5000, 800 * retry));
      } else {
        setHomeError('Tidak bisa tersambung ke server. Coba lagi.');
      }
    };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        myId = m.id;
        session = { code: m.code, token: m.token, name: session && session.name ? session.name : $('in-name').value.trim() };
        store('session', JSON.stringify(session));
        history.replaceState(null, '', '/?room=' + m.code);
        loadStickers();
        break;
      case 'state':
        offset = m.serverNow - Date.now();
        onState(m);
        break;
      case 'pd':
        onDelta(m);
        break;
      case 'my':
        if (st) {
          st.my = m.my;
          renderSkill();
          renderBoard();
          updateKeys();
        }
        break;
      case 'fx':
        onFx(m);
        break;
      case 'emote':
        showEmote(m);
        break;
      case 'note':
        toast(m.msg, 2200);
        break;
      case 'invalid':
        pending = false;
        shakeRow();
        toast(m.msg);
        break;
      case 'error':
        if (m.code === 'noroom' && session) {
          session = null;
          store('session', null);
          history.replaceState(null, '', '/');
          showScreen('home');
        }
        setHomeError(m.msg);
        toast(m.msg, 2500);
        break;
      case 'kicked':
        goHome('Kamu dikeluarkan dari room oleh host.');
        break;
      case 'left':
        break;
    }
  }

  function goHome(msg) {
    session = null;
    store('session', null);
    st = null;
    myId = null;
    history.replaceState(null, '', '/');
    $('modal-result').classList.add('hidden');
    document.body.classList.remove('skill');
    showScreen('home');
    updateJoinBanner();
    updateFab();
    if (msg) setHomeError(msg);
  }

  // ---------- Beranda ----------
  const nameInput = $('in-name');
  const codeInput = $('in-code');
  try { nameInput.value = localStorage.getItem('nick') || ''; } catch {}
  const urlCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (urlCode) codeInput.value = urlCode;

  let chosenMode = 'normal';
  try { if (localStorage.getItem('mode') === 'skill') chosenMode = 'skill'; } catch {}
  function paintMode() {
    for (const b of document.querySelectorAll('.mode-card')) {
      const on = b.dataset.mode === chosenMode;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  for (const b of document.querySelectorAll('.mode-card')) {
    b.onclick = () => {
      chosenMode = b.dataset.mode;
      try { localStorage.setItem('mode', chosenMode); } catch {}
      paintMode();
    };
  }
  paintMode();

  function setHomeError(msg) { $('home-err').textContent = msg || ''; }
  function updateJoinBanner() {
    const code = codeInput.value.trim().toUpperCase();
    const b = $('join-banner');
    if (urlCode && code === urlCode) {
      b.textContent = `Kamu diundang ke room ${urlCode}. Isi nickname lalu tekan Gabung.`;
      b.classList.remove('hidden');
    } else b.classList.add('hidden');
  }
  updateJoinBanner();

  function getName() {
    const n = nameInput.value.replace(/\s+/g, ' ').trim();
    if (n.length < 2) {
      setHomeError('Isi nickname dulu (minimal 2 huruf)');
      nameInput.focus();
      return null;
    }
    try { localStorage.setItem('nick', n); } catch {}
    return n;
  }
  $('btn-create').onclick = () => {
    const name = getName();
    if (!name) return;
    setHomeError('');
    leaving = false;
    session = { name };
    connect(() => send({ t: 'create', name, mode: chosenMode }));
  };
  function joinNow() {
    const name = getName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 5) return setHomeError('Kode room harus 5 huruf');
    setHomeError('');
    leaving = false;
    session = { name };
    connect(() => send({ t: 'join', code, name }));
  }
  $('btn-join').onclick = joinNow;
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    updateJoinBanner();
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeInput.value.length === 5 ? joinNow : $('btn-create').onclick)(); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNow(); });

  // Bantuan
  $('btn-help').onclick = () => $('modal-help').classList.remove('hidden');
  $('help-close').onclick = () => $('modal-help').classList.add('hidden');
  $('modal-help').addEventListener('click', (e) => { if (e.target === $('modal-help')) $('modal-help').classList.add('hidden'); });

  // ---------- Layar ----------
  function showScreen(name) {
    for (const s of ['home', 'lobby', 'game']) $('screen-' + s).classList.toggle('hidden', s !== name);
  }

  // ---------- Lobby ----------
  function isHost() { return st && st.hostId === myId; }

  const skillList = $('skill-list');
  for (const s of Object.values(SKILLS)) {
    const li = el('li');
    li.appendChild(el('span', 'ic', s.ico));
    const d = el('div');
    d.appendChild(el('b', '', s.name));
    d.appendChild(el('span', '', s.desc));
    li.appendChild(d);
    skillList.appendChild(li);
  }

  function renderLobby() {
    $('lobby-code').textContent = st.code;
    $('max-note').textContent = st.maxPlayers;
    const host = isHost();
    $('rounds-val').textContent = st.settings.rounds;
    $('rounds-dec').disabled = !host || st.settings.rounds <= 1;
    $('rounds-inc').disabled = !host || st.settings.rounds >= 20;
    const sel = $('time-sel');
    sel.value = String(st.settings.time);
    sel.disabled = !host;
    const msel = $('mode-sel');
    msel.value = st.settings.mode;
    msel.disabled = !host;
    $('skill-info').classList.toggle('hidden', st.settings.mode !== 'skill');
    $('settings-note').textContent = host ? '' : 'Hanya host yang bisa mengubah pengaturan.';
    $('btn-start').classList.toggle('hidden', !host);
    $('wait-note').textContent = host ? '' : 'Menunggu host memulai game…';
    $('lobby-count').textContent = `${st.players.length}/${st.maxPlayers}`;

    const ul = $('lobby-players');
    ul.textContent = '';
    for (const p of st.players) {
      const li = el('li');
      li.appendChild(avatar(p.name));
      li.appendChild(el('span', 'pname', p.name + (p.id === myId ? ' (kamu)' : '')));
      if (p.host) li.appendChild(el('span', 'badge host', 'Host'));
      if (!p.connected) li.appendChild(el('span', 'badge off', 'terputus'));
      if (host && p.id !== myId) {
        const k = el('button', 'kick', '✕');
        k.title = 'Keluarkan';
        k.onclick = () => send({ t: 'kick', id: p.id });
        li.appendChild(k);
      }
      ul.appendChild(li);
    }
  }

  // nilai sementara agar klik cepat tidak memakai angka lama dari server
  let want = null;
  function changeSettings(patch) {
    want = Object.assign({}, want || st.settings, patch);
    want.rounds = Math.min(20, Math.max(1, want.rounds));
    $('rounds-val').textContent = want.rounds;
    send({ t: 'settings', rounds: want.rounds, time: want.time, mode: want.mode });
  }
  $('rounds-dec').onclick = () => changeSettings({ rounds: (want || st.settings).rounds - 1 });
  $('rounds-inc').onclick = () => changeSettings({ rounds: (want || st.settings).rounds + 1 });
  $('time-sel').onchange = (e) => changeSettings({ time: Number(e.target.value) });
  $('mode-sel').onchange = (e) => changeSettings({ mode: e.target.value });
  $('btn-start').onclick = () => send({ t: 'start' });
  $('btn-copy-code').onclick = async () => toast((await copyText(st.code)) ? 'Kode room disalin' : 'Gagal menyalin');
  const inviteLink = () => location.origin + '/?room=' + st.code;
  $('btn-copy-link').onclick = async () => toast((await copyText(inviteLink())) ? 'Link undangan disalin' : 'Gagal menyalin');
  if (navigator.share) {
    const b = el('button', 'btn', 'Bagikan…');
    b.onclick = () => navigator.share({ title: 'Tebak Kata KBBI', text: `Yuk main Tebak Kata! Kode room: ${st.code}`, url: inviteLink() }).catch(() => {});
    $('btn-copy-link').after(b);
  }
  function leaveRoom() {
    send({ t: 'leave' });
    goHome();
  }
  $('btn-leave-lobby').onclick = leaveRoom;

  // ---------- Papan & keyboard ----------
  const board = $('board');
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const row = el('div', 'row');
    const tiles = [];
    for (let c = 0; c < 5; c++) {
      const t = el('div', 'tile');
      row.appendChild(t);
      tiles.push(t);
    }
    board.appendChild(row);
    rows.push({ row, tiles });
  }

  const kbLayout = ['QWERTYUIOP', 'ASDFGHJKL', '+ZXCVBNM-'];
  const keyEls = {};
  const kb = $('keyboard');
  for (const line of kbLayout) {
    const kr = el('div', 'krow');
    for (const ch of line) {
      let b;
      if (ch === '+') { b = el('button', 'key wide', 'Enter'); b.dataset.k = 'Enter'; }
      else if (ch === '-') { b = el('button', 'key wide', '⌫'); b.dataset.k = 'Backspace'; }
      else { b = el('button', 'key', ch); b.dataset.k = ch; keyEls[ch.toLowerCase()] = b; }
      b.onclick = () => handleKey(b.dataset.k);
      kr.appendChild(b);
    }
    kb.appendChild(kr);
  }

  let cur = '';
  let pending = false;
  let pendingTimer;
  let shownRows = 0;
  let keyRows = 0; // jumlah baris yang animasinya sudah selesai (untuk warna keyboard)
  let lastRound = -1;
  let skipAnim = false;

  function me() { return st && st.players.find((p) => p.id === myId); }
  function frozenNow() {
    const m = me();
    return !!(m && m.frozenUntil > Date.now() + offset);
  }
  function canType() {
    const m = me();
    return st && st.phase === 'playing' && m && !m.done && !m.late && !pending && !frozenNow();
  }

  function setTile(t, letter, cls) {
    t.textContent = letter || '';
    t.className = 'tile' + (letter && !cls ? ' filled' : '') + (cls ? ' ' + cls : '');
  }
  const clsFor = (ch) => (ch === '2' ? 'ok' : ch === '1' ? 'pres' : 'abs');

  function renderBoard() {
    const guesses = st.myGuesses;
    const hint = st.my && st.my.hint;
    if (st.round !== lastRound) {
      lastRound = st.round;
      shownRows = 0;
      keyRows = 0;
      cur = '';
      pending = false;
      skipAnim = guesses.length > 0; // sambung ulang di tengah ronde
      for (const k of Object.values(keyEls)) k.className = 'key';
      for (const r of rows) { r.row.classList.remove('win', 'shake'); r.tiles.forEach((t) => setTile(t, '')); }
    }
    for (let r = 0; r < 6; r++) {
      const g = guesses[r];
      if (g) {
        if (r < shownRows) continue;
        if (skipAnim) {
          g.w.split('').forEach((ch, i) => setTile(rows[r].tiles[i], ch, clsFor(g.p[i])));
          shownRows = r + 1;
          keyRows = r + 1;
          if (g.p === '22222') rows[r].row.classList.add('win');
        } else {
          animateRow(r, g);
          shownRows = r + 1;
        }
      } else if (r === guesses.length && st.phase === 'playing') {
        for (let c = 0; c < 5; c++) {
          if (cur[c]) setTile(rows[r].tiles[c], cur[c]);
          else if (hint && hint.pos === c) setTile(rows[r].tiles[c], hint.letter.toUpperCase(), 'hint');
          else setTile(rows[r].tiles[c], '');
        }
      } else if (r >= guesses.length) {
        for (let c = 0; c < 5; c++) setTile(rows[r].tiles[c], '');
      }
    }
    if (skipAnim && shownRows === guesses.length) { skipAnim = false; updateKeys(); }
  }

  function animateRow(r, g) {
    const tiles = rows[r].tiles;
    g.w.split('').forEach((ch, i) => {
      const t = tiles[i];
      setTile(t, ch);
      t.style.animationDelay = i * 0.25 + 's';
      t.classList.add('flip');
      setTimeout(() => {
        setTile(t, ch, clsFor(g.p[i]));
        t.classList.add('flip');
      }, i * 250 + 275);
    });
    setTimeout(() => {
      tiles.forEach((t) => { t.classList.remove('flip'); t.style.animationDelay = ''; });
      if (g.p === '22222') rows[r].row.classList.add('win');
      keyRows = Math.max(keyRows, r + 1);
      updateKeys();
    }, 5 * 250 + 700);
  }

  function updateKeys() {
    if (!st) return;
    const best = {};
    for (const g of st.myGuesses.slice(0, keyRows)) {
      g.w.split('').forEach((ch, i) => {
        const v = Number(g.p[i]);
        if (best[ch] === undefined || v > best[ch]) best[ch] = v;
      });
    }
    for (const k of Object.values(keyEls)) k.className = 'key';
    for (const [ch, v] of Object.entries(best)) if (keyEls[ch]) keyEls[ch].className = 'key ' + (v === 2 ? 'ok' : v === 1 ? 'pres' : 'abs');
    const cut = (st.my && st.my.coret) || [];
    for (const ch of cut) if (keyEls[ch] && best[ch] === undefined) keyEls[ch].className = 'key abs cut';
  }

  function shakeRow() {
    const idx = st ? Math.min(st.myGuesses.length, 5) : 0;
    const r = rows[idx].row;
    r.classList.remove('shake');
    void r.offsetWidth;
    r.classList.add('shake');
  }

  function handleKey(k) {
    if (!canType()) return;
    if (k === 'Enter') {
      if (cur.length < 5) { shakeRow(); return toast('Kurang huruf'); }
      pending = true;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => (pending = false), 3000);
      send({ t: 'guess', word: cur.toLowerCase() });
    } else if (k === 'Backspace') {
      cur = cur.slice(0, -1);
      renderBoard();
    } else if (/^[A-Za-z]$/.test(k) && cur.length < 5) {
      cur += k.toUpperCase();
      renderBoard();
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!st || $('screen-game').classList.contains('hidden')) return;
    if (e.key === 'Enter') e.preventDefault();
    handleKey(e.key);
  });

  // ---------- Skill ----------
  function nextSkillRound() {
    const b = st.skillBlock || 3;
    const next = st.round - ((st.round - 1) % b) + b;
    return next <= st.settings.rounds ? next : null;
  }

  function renderSkill() {
    const bar = $('skillbar');
    const on = !!(st && st.settings.mode === 'skill' && st.phase !== 'lobby');
    document.body.classList.toggle('skill', on);
    if (!on) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const my = st.my;
    const sk = my && my.skill;
    const btn = $('sk-use');
    const m = me();
    if (!sk) {
      $('sk-ico').textContent = '…';
      $('sk-name').textContent = 'Skill';
      $('sk-desc').textContent = 'Menunggu skill…';
      btn.textContent = 'Pakai';
      btn.disabled = true;
      return;
    }
    const def = SKILLS[sk.id];
    $('sk-ico').textContent = def.ico;
    $('sk-name').textContent = 'Skill: ' + def.name;
    const nx = nextSkillRound();
    const tail = nx ? ` Skill baru di ronde ${nx}.` : '';
    let desc = def.desc;
    if (sk.id === 'intip' && my.hint) desc = `Huruf ke-${my.hint.pos + 1} adalah ${my.hint.letter.toUpperCase()}.`;
    else if (sk.id === 'coret' && my.coret && my.coret.length) desc = `Tidak ada di jawaban: ${my.coret.join(', ').toUpperCase()}.`;
    else if (sk.id === 'ganda' && my.ganda) desc = 'Aktif! Poin ×2 jika benar, −100 jika gagal.';
    else if (sk.used) desc = 'Sudah dipakai.';
    $('sk-desc').textContent = desc + tail;
    if (sk.id === 'perisai') {
      btn.textContent = sk.used ? 'Terpakai' : 'Otomatis';
      btn.disabled = true;
    } else {
      btn.textContent = sk.used ? 'Terpakai' : 'Pakai';
      btn.disabled = sk.used || st.phase !== 'playing' || !m || m.done || m.late;
    }
  }
  $('sk-use').onclick = () => send({ t: 'skill' });

  // ---------- Panel pemain ----------
  let frozenKey = '';
  function renderSide() {
    const wrap = $('side-players');
    wrap.textContent = '';
    $('side-code').textContent = 'Room ' + st.code;
    const now = Date.now() + offset;
    const sorted = st.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score || a.i - b.i).map((x) => x.p);
    for (const p of sorted) {
      const c = el('div', 'pcard' + (p.id === myId ? ' me' : '') + (p.connected ? '' : ' off'));
      c.title = p.name;
      c.appendChild(el('div', 'pn', (p.host ? '👑 ' : '') + p.name));
      const g = el('div', 'mini-grid');
      for (let r = 0; r < 6; r++) {
        const mr = el('div', 'mini-row');
        for (let k = 0; k < 5; k++) mr.appendChild(el('i', p.rows[r] ? 'c' + p.rows[r][k] : ''));
        g.appendChild(mr);
      }
      c.appendChild(g);
      let status = '', good = false;
      if (st.phase === 'playing' || st.phase === 'roundEnd') {
        if (p.solved) { status = '✓ Benar!'; good = true; }
        else if (p.late) status = 'Menunggu';
        else if (p.done) status = 'Habis';
        else if (p.frozenUntil > now) status = '❄ Beku';
        else status = `${p.rows.length}/6`;
      }
      if (!p.connected) status = 'terputus';
      c.appendChild(el('div', 'st' + (good ? ' good' : ''), status));
      c.appendChild(el('div', 'ps', p.score + ' poin'));
      wrap.appendChild(c);
    }
  }

  // ---------- Hasil ronde & akhir ----------
  function rankTable(players, mode) {
    const t = el('table', 'lb');
    const sorted = players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score || b.p.solvedCount - a.p.solvedCount || a.i - b.i).map((x) => x.p);
    sorted.forEach((p, i) => {
      const tr = el('tr', p.id === myId ? 'me' : '');
      tr.appendChild(el('td', 'rank', String(i + 1)));
      const nm = el('td');
      nm.textContent = p.name + (p.id === myId ? ' (kamu)' : '');
      tr.appendChild(nm);
      if (mode === 'round') {
        const cell = p.solved
          ? '+' + p.roundPoints + (p.solvedMs != null ? ` · ${(p.solvedMs / 1000).toFixed(1)}s` : '')
          : p.roundPoints < 0 ? '−' + Math.abs(p.roundPoints) + ' ⚡' : '—';
        tr.appendChild(el('td', 'plus', cell));
      } else {
        tr.appendChild(el('td', 'plus', `benar ${p.solvedCount}/${st.settings.rounds}`));
      }
      tr.appendChild(el('td', 'pts', String(p.score)));
      t.appendChild(tr);
    });
    return { table: t, sorted };
  }

  let resultKey = '';
  function renderResult() {
    const modal = $('modal-result');
    const body = $('result-body');
    if (st.phase !== 'roundEnd' && st.phase !== 'final') {
      modal.classList.add('hidden');
      resultKey = '';
      return;
    }
    const key = st.phase + ':' + st.round + ':' + st.players.map((p) => p.score + p.name + p.connected).join(',') + ':' + st.hostId;
    modal.classList.remove('hidden');
    if (key === resultKey) return;
    resultKey = key;
    body.textContent = '';

    if (st.phase === 'roundEnd') {
      const last = st.round >= st.settings.rounds;
      body.appendChild(el('h2', '', `Ronde ${st.round}/${st.settings.rounds} selesai`));
      const rv = el('div', 'reveal');
      rv.appendChild(el('div', 'muted small', 'Kata yang dicari:'));
      const w = el('div', 'word');
      for (const ch of st.word) w.appendChild(el('div', 'tile', ch));
      rv.appendChild(w);
      const a = el('a', '', 'Lihat arti di KBBI ↗');
      a.href = 'https://kbbi.kemdikbud.go.id/entri/' + encodeURIComponent(st.word);
      a.target = '_blank';
      a.rel = 'noopener';
      const wrapA = el('div');
      wrapA.style.marginTop = '8px';
      wrapA.appendChild(a);
      rv.appendChild(wrapA);
      body.appendChild(rv);
      body.appendChild(rankTable(st.players, 'round').table);
      body.appendChild(el('div', 'next-note')).id = 'next-note';
      if (isHost()) {
        const b = el('button', 'btn primary', last ? 'Lihat hasil akhir' : 'Lanjut ke ronde berikutnya');
        b.onclick = () => send({ t: 'next' });
        const act = el('div', 'modal-actions');
        act.appendChild(b);
        body.appendChild(act);
      }
    } else {
      const { table, sorted } = rankTable(st.players, 'final');
      body.appendChild(el('h2', '', '🏆 Hasil akhir'));
      const pod = el('div', 'podium');
      const order = [1, 0, 2];
      for (const idx of order) {
        const p = sorted[idx];
        if (!p) continue;
        const d = el('div', 'pod p' + (idx + 1));
        d.appendChild(avatar(p.name));
        d.appendChild(el('div', 'nm', p.name));
        d.appendChild(el('div', 'sc', p.score + ' poin'));
        d.appendChild(el('div', 'blk', String(idx + 1)));
        pod.appendChild(d);
      }
      body.appendChild(pod);
      body.appendChild(table);
      const act = el('div', 'modal-actions');
      if (isHost()) {
        const b = el('button', 'btn primary', 'Main lagi (kembali ke lobi)');
        b.onclick = () => send({ t: 'again' });
        act.appendChild(b);
      } else {
        act.appendChild(el('div', 'next-note', 'Menunggu host memulai game baru…'));
      }
      const l = el('button', 'btn', 'Keluar dari room');
      l.onclick = leaveRoom;
      act.appendChild(l);
      body.appendChild(act);
    }
  }

  // ---------- Stiker & efek ----------
  let stickers = [];
  let lastEmote = 0;
  const tray = $('tray');
  const fab = $('btn-stickers');

  function updateFab() {
    fab.classList.toggle('hidden', !(st && stickers.length));
    if (!(st && stickers.length)) tray.classList.add('hidden');
  }
  let traySig = '';
  function renderTray() {
    traySig = stickers.map((s) => s.id).join(',');
    tray.textContent = '';
    for (const s of stickers) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Kirim stiker');
      const img = el('img');
      img.src = '/s/' + s.id;
      img.alt = '';
      img.draggable = false;
      b.appendChild(img);
      b.onclick = () => {
        const now = Date.now();
        if (now - lastEmote < 1200) return toast('Pelan-pelan ya…', 900);
        lastEmote = now;
        send({ t: 'emote', sid: s.id });
        tray.classList.add('hidden');
      };
      tray.appendChild(b);
    }
  }
  async function loadStickers() {
    try {
      const r = await fetch('/api/stickers', { cache: 'no-store' });
      const j = await r.json();
      stickers = Array.isArray(j.stickers) ? j.stickers.slice(0, 5) : [];
      for (const s of stickers) new Image().src = '/s/' + s.id; // isi cache browser
    } catch {}
    if (stickers.map((s) => s.id).join(',') !== traySig) renderTray(); // hanya bangun ulang kalau daftar berubah
    updateFab();
  }
  fab.onclick = () => {
    if (!tray.classList.contains('hidden')) return tray.classList.add('hidden');
    renderTray();
    tray.classList.remove('hidden');
    loadStickers(); // segarkan daftar diam-diam (tidak membuka/menutup tray)
  };
  document.addEventListener('click', (e) => {
    if (!tray.classList.contains('hidden') && !tray.contains(e.target) && e.target !== fab) tray.classList.add('hidden');
  });

  const feed = $('feed');
  function pushFeed(node) {
    feed.appendChild(node);
    while (feed.children.length > 4) feed.firstChild.remove();
    setTimeout(() => node.remove(), 3200);
  }
  function showEmote(m) {
    if (!st || !/^[a-f0-9]{8}$/.test(String(m.sid))) return;
    const p = st.players.find((x) => x.id === m.from);
    const d = el('div', 'fx');
    const img = el('img');
    img.src = '/s/' + m.sid;
    img.alt = 'stiker';
    d.appendChild(img);
    d.appendChild(el('span', '', p ? p.name : '?'));
    pushFeed(d);
  }
  function onFx(m) {
    if (!st) return;
    const to = st.players.find((p) => p.id === m.to);
    const from = st.players.find((p) => p.id === m.from);
    if (!to || !from) return;
    if (m.k === 'freeze') {
      if (!m.blocked) {
        to.frozenUntil = m.until;
        if (to.id === myId) toast('❄ Kamu dibekukan oleh ' + from.name + '!', 2200);
      }
      const d = el('div', 'fx text', m.blocked ? `🛡️ Perisai ${to.name} menangkal Bekukan dari ${from.name}!` : `❄️ ${from.name} membekukan ${to.name}!`);
      pushFeed(d);
      renderSide();
    }
  }

  // ---------- Update kecil dari server (hemat bandwidth) ----------
  function onDelta(d) {
    if (!st) return;
    const p = st.players.find((x) => x.id === d.id);
    if (!p) return;
    if (p.rows.length < d.n) p.rows.push(d.row);
    p.done = d.done;
    p.solved = d.solved;
    p.score = d.score;
    p.roundPoints = d.rp;
    p.solvedMs = d.sm;
    p.solvedCount = d.sc;
    if (d.id === myId && d.w && st.myGuesses.length < d.n) {
      st.myGuesses.push({ w: d.w, p: d.row });
      cur = '';
      pending = false;
    }
    renderBoard();
    renderSide();
    renderSkill();
  }

  // ---------- Render utama ----------
  function onState(m) {
    const prev = st;
    st = m;
    want = null;
    if (prev && prev.round === m.round && m.myGuesses.length > prev.myGuesses.length) {
      cur = '';
      pending = false;
    }
    if (prev && prev.phase !== 'lobby' && m.phase === 'lobby') $('modal-result').classList.add('hidden');
    render();
  }

  function render() {
    if (!st) return;
    updateFab();
    if (st.phase === 'lobby') {
      document.body.classList.remove('skill');
      showScreen('lobby');
      $('modal-result').classList.add('hidden');
      resultKey = '';
      lastRound = -1;
      return renderLobby();
    }
    showScreen('game');
    $('round-tag').textContent = `Ronde ${st.round}/${st.settings.rounds}`;
    renderSkill();
    renderBoard();
    updateKeys();
    renderSide();
    renderResult();
    const m = me();
    $('countdown').classList.toggle('hidden', st.phase !== 'countdown');
    $('spectate').classList.toggle('hidden', !(st.phase === 'playing' && m && m.late));
    tick();
  }

  function tick() {
    if (!st) return;
    const now = Date.now() + offset;
    const timer = $('timer');
    const fill = $('timebar-fill');
    const total = st.settings.time * 1000;
    if (st.phase === 'countdown') {
      $('cd-num').textContent = Math.max(1, Math.ceil((st.countdownEndsAt - now) / 1000));
      timer.textContent = fmtTime(total);
      timer.classList.remove('low');
      fill.style.width = '100%';
    } else if (st.phase === 'playing') {
      const rem = st.roundEndsAt - now;
      timer.textContent = fmtTime(rem);
      timer.classList.toggle('low', rem <= 10000);
      fill.style.width = Math.max(0, Math.min(100, (rem / total) * 100)) + '%';
    } else if (st.phase === 'roundEnd' || st.phase === 'final') {
      timer.textContent = '0:00';
      timer.classList.remove('low');
      fill.style.width = '0%';
      const n = $('next-note');
      if (n && st.phase === 'roundEnd') {
        const s = Math.max(0, Math.ceil((st.nextAt - now) / 1000));
        n.textContent = st.round >= st.settings.rounds ? `Hasil akhir dalam ${s} dtk…` : `Ronde berikutnya otomatis dalam ${s} dtk…`;
      }
    }
    // efek beku
    const m = me();
    const fz = !!(m && st.phase === 'playing' && m.frozenUntil > now);
    $('frozen').classList.toggle('hidden', !fz);
    if (fz) $('fz-num').textContent = Math.max(1, Math.ceil((m.frozenUntil - now) / 1000));
    const key = st.players.filter((p) => p.frozenUntil > now).map((p) => p.id).join(',');
    if (key !== frozenKey) {
      frozenKey = key;
      if (st.phase !== 'lobby') renderSide();
    }
  }
  setInterval(tick, 250);

  // ---------- Mulai ----------
  showScreen('home');
  if (session && session.code && session.token) {
    connect(() => send({ t: 'join', code: session.code, token: session.token }));
  } else {
    session = null;
  }
  try {
    if (!localStorage.getItem('seenHelp')) {
      localStorage.setItem('seenHelp', '1');
      if (!session) $('modal-help').classList.remove('hidden');
    }
  } catch {}
})();
