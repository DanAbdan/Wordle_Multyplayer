'use strict';
// Tebak Kata KBBI - server multiplayer (HTTP statis + WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 12;
const MAX_GUESSES = 6;
const COUNTDOWN_MS = 4000;
const RESULT_MS = 12000;
const LOBBY_GRACE_MS = 30000;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const MAX_ROOMS = 500;
const LIMITS = { rounds: [1, 20], time: [30, 600] };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

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

// ---------- HTTP statis ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Tidak ditemukan');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- State ----------
const rooms = new Map();
const rid = (n) => crypto.randomBytes(n).toString('hex');

function genCode() {
  for (let tries = 0; tries < 100; tries++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function newPlayer(name, token) {
  return {
    id: rid(3),
    token: token || rid(16),
    name,
    ws: null,
    connected: false,
    score: 0,
    solvedCount: 0,
    guesses: [],
    solved: false,
    solvedMs: null,
    done: false,
    late: false,
    roundPoints: 0,
    removeTimer: null,
  };
}

function resetRoundState(p) {
  p.guesses = [];
  p.solved = false;
  p.solvedMs = null;
  p.done = false;
  p.late = false;
  p.roundPoints = 0;
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
    })),
    myGuesses: me ? me.guesses.map((g) => ({ w: g.word, p: g.pattern })) : [],
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
  if (room.hostId === id || !room.players.has(room.hostId)) room.hostId = [...room.players.keys()][0];
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

function startCountdown(room) {
  room.round += 1;
  room.phase = 'countdown';
  room.word = pickWord(room);
  room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  room.roundEndsAt = null;
  room.nextAt = null;
  for (const p of room.players.values()) resetRoundState(p);
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
    resetRoundState(p);
  }
  if (!room.players.has(room.hostId)) reassignHost(room);
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
    settings: { rounds: 5, time: 120 },
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

  // sambung kembali dengan token
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
    // ambil alih slot pemain yang sedang terputus
    same.token = rid(16);
    detach(ws);
    return attach(ws, room, same);
  }
  if (room.players.size >= MAX_PLAYERS) return sendErr(ws, `Room penuh (${MAX_PLAYERS}/${MAX_PLAYERS})`, 'full');
  detach(ws);
  const player = newPlayer(name);
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
      return broadcast(room);
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      room.round = 0;
      for (const p of room.players.values()) {
        p.score = 0;
        p.solvedCount = 0;
      }
      return startCountdown(room);
    }
    case 'guess': {
      if (room.phase !== 'playing' || player.done || player.late) return;
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
        player.roundPoints = 100 + Math.round(400 * ratio);
        player.score += player.roundPoints;
        player.solvedCount += 1;
      } else if (player.guesses.length >= MAX_GUESSES) {
        player.done = true;
      }
      broadcast(room);
      return checkRoundDone(room);
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

server.listen(PORT, '0.0.0.0', () => console.log(`Server jalan di http://localhost:${PORT}`));
