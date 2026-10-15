'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
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
    return `hsl(${h}, 55%, 46%)`;
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
        break;
      case 'state':
        offset = m.serverNow - Date.now();
        onState(m);
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
    showScreen('home');
    updateJoinBanner();
    if (msg) setHomeError(msg);
  }

  // ---------- Beranda ----------
  const nameInput = $('in-name');
  const codeInput = $('in-code');
  try { nameInput.value = localStorage.getItem('nick') || ''; } catch {}
  const urlCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (urlCode) codeInput.value = urlCode;

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
    connect(() => send({ t: 'create', name }));
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
  const timeOptions = [30, 60, 90, 120, 180, 300, 600];
  function isHost() { return st && st.hostId === myId; }

  function renderLobby() {
    $('lobby-code').textContent = st.code;
    const host = isHost();
    $('rounds-val').textContent = st.settings.rounds;
    $('rounds-dec').disabled = !host || st.settings.rounds <= 1;
    $('rounds-inc').disabled = !host || st.settings.rounds >= 20;
    const sel = $('time-sel');
    sel.value = String(st.settings.time);
    sel.disabled = !host;
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
    send({ t: 'settings', rounds: want.rounds, time: want.time });
  }
  $('rounds-dec').onclick = () => changeSettings({ rounds: (want || st.settings).rounds - 1 });
  $('rounds-inc').onclick = () => changeSettings({ rounds: (want || st.settings).rounds + 1 });
  $('time-sel').onchange = (e) => changeSettings({ time: Number(e.target.value) });
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
  let lastRound = -1;
  let skipAnim = false;
  let keyTimer;

  function me() { return st && st.players.find((p) => p.id === myId); }
  function canType() {
    const m = me();
    return st && st.phase === 'playing' && m && !m.done && !m.late && !pending;
  }

  function setTile(t, letter, cls) {
    t.textContent = letter || '';
    t.className = 'tile' + (letter && !cls ? ' filled' : '') + (cls ? ' ' + cls : '');
  }
  const clsFor = (ch) => (ch === '2' ? 'ok' : ch === '1' ? 'pres' : 'abs');

  function renderBoard() {
    const guesses = st.myGuesses;
    if (st.round !== lastRound) {
      lastRound = st.round;
      shownRows = 0;
      cur = '';
      pending = false;
      skipAnim = guesses.length > 0; // sambung ulang di tengah ronde
      clearTimeout(keyTimer);
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
          if (g.p === '22222') rows[r].row.classList.add('win');
        } else {
          animateRow(r, g);
          shownRows = r + 1;
        }
      } else if (r === guesses.length && st.phase === 'playing') {
        for (let c = 0; c < 5; c++) setTile(rows[r].tiles[c], cur[c] || '');
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
    // setelah semua ubin selesai: kunci warna, update keyboard, animasi menang
    setTimeout(() => {
      tiles.forEach((t) => { t.classList.remove('flip'); t.style.animationDelay = ''; });
      if (g.p === '22222') rows[r].row.classList.add('win');
      updateKeys();
    }, 5 * 250 + 700);
  }

  function updateKeys() {
    if (!st) return;
    const best = {};
    for (const g of st.myGuesses) {
      g.w.split('').forEach((ch, i) => {
        const v = Number(g.p[i]);
        if (best[ch] === undefined || v > best[ch]) best[ch] = v;
      });
    }
    for (const [ch, v] of Object.entries(best)) if (keyEls[ch]) keyEls[ch].className = 'key ' + (v === 2 ? 'ok' : v === 1 ? 'pres' : 'abs');
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
    if (!st || !$('screen-game') || $('screen-game').classList.contains('hidden')) return;
    if (e.key === 'Enter') e.preventDefault();
    handleKey(e.key);
  });

  // ---------- Panel pemain ----------
  function renderSide() {
    const wrap = $('side-players');
    wrap.textContent = '';
    $('side-code').textContent = 'Room ' + st.code;
    const sorted = st.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score || a.i - b.i).map((x) => x.p);
    for (const p of sorted) {
      const c = el('div', 'pcard' + (p.id === myId ? ' me' : '') + (p.connected ? '' : ' off'));
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
        tr.appendChild(el('td', 'plus', p.solved ? '+' + p.roundPoints + (p.solvedMs != null ? ` · ${(p.solvedMs / 1000).toFixed(1)}s` : '') : '—'));
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
    if (st.phase === 'lobby') {
      showScreen('lobby');
      $('modal-result').classList.add('hidden');
      resultKey = '';
      lastRound = -1;
      return renderLobby();
    }
    showScreen('game');
    $('round-tag').textContent = `Ronde ${st.round}/${st.settings.rounds}`;
    renderBoard();
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
