'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const {
  COLS,
  ROWS,
  RED,
  YELLOW,
  createGame,
  applyMove,
} = require('./game');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Comma-separated extra origins, e.g. "https://c4.example.com".
// Same-host origins are always allowed; this is for when you put the app
// behind a proxy on a different hostname.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const LIMITS = {
  maxPayloadBytes: 4 * 1024, // ws-level cap; oversized frames close the socket
  maxRooms: 500,
  maxConnections: 1000,
  maxConnectionsPerIp: 20,
  maxSpectatorsPerRoom: 20,
  maxNameLength: 20,
  roomIdleMs: 30 * 60 * 1000, // reap rooms untouched for 30 min
  heartbeatMs: 30 * 1000,
  // Token bucket: sustained 5 msg/s, burst of 20.
  rateBurst: 20,
  rateRefillPerSec: 5,
};

// ---------------------------------------------------------------------------
// Static file serving (fixed allowlist — no path is ever built from user input)
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

// Read once at boot. Files are trusted repo content, never user data.
const STATIC_CACHE = new Map();
for (const [, route] of STATIC_ROUTES) {
  if (!STATIC_CACHE.has(route.file)) {
    STATIC_CACHE.set(route.file, fs.readFileSync(path.join(PUBLIC_DIR, route.file)));
  }
}

const SECURITY_HEADERS = {
  // No inline script, no external anything. 'self' covers app.js/styles.css.
  // connect-src includes ws:/wss: so the page can open its own socket.
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const server = http.createServer((req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Strip the query string; only the exact pathname is matched against the
  // allowlist, so "../" and friends can never reach the filesystem.
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: totalConnections }));
    return;
  }

  const route = STATIC_ROUTES.get(pathname);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const body = STATIC_CACHE.get(route.file);
  res.writeHead(200, { 'Content-Type': route.type, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
});

// ---------------------------------------------------------------------------
// Room + player state
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, number>} */
const connectionsPerIp = new Map();
let totalConnections = 0;

// Excludes I/O/0/1 so a code read aloud over the phone is unambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Rejection-sampled so every code is uniformly distributed (32 divides 256). */
function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function newRoomCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode(6);
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createRoom() {
  if (rooms.size >= LIMITS.maxRooms) return null;
  const code = newRoomCode();
  if (!code) return null;

  const room = {
    code,
    game: createGame(),
    /** @type {Map<number, Player>} seat (RED|YELLOW) -> player */
    seats: new Map(),
    /** @type {Set<object>} spectator sockets */
    spectators: new Set(),
    scores: { [RED]: 0, [YELLOW]: 0, draws: 0 },
    rematchVotes: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function deleteRoomIfEmpty(room) {
  const seated = [...room.seats.values()].filter((p) => p.ws && p.ws.readyState === 1);
  if (seated.length === 0 && room.spectators.size === 0) {
    rooms.delete(room.code);
  }
}

// ---------------------------------------------------------------------------
// Input sanitisation
// ---------------------------------------------------------------------------

/**
 * Names are echoed to other players, so they are aggressively normalised here.
 * The client also renders via textContent, giving two independent layers.
 */
function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .normalize('NFKC')
    // Strip C0/C1 controls, zero-width joiners, bidi overrides, and combining marks.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.maxNameLength);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Room codes from clients are uppercased and checked against the alphabet. */
function sanitizeRoomCode(raw) {
  if (typeof raw !== 'string' || raw.length !== 6) return null;
  const upper = raw.toUpperCase();
  for (const ch of upper) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return upper;
}

/** Constant-time compare that tolerates length mismatch without leaking it. */
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// WebSocket layer
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: LIMITS.maxPayloadBytes,
  // Disable permessage-deflate: it costs memory per connection and opens the
  // door to zip-bomb style amplification from hostile clients.
  perMessageDeflate: false,
});

function originAllowed(req) {
  const origin = req.headers.origin;
  // Non-browser clients (curl, tests) send no Origin. Browsers always do, so
  // CSWSH protection is unaffected by allowing the absent case.
  if (!origin) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (EXTRA_ORIGINS.includes(origin)) return true;

  const host = req.headers.host;
  if (host && parsed.host === host) return true;

  return false;
}

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  if (totalConnections >= LIMITS.maxConnections) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const ip = clientIp(req);
  if ((connectionsPerIp.get(ip) || 0) >= LIMITS.maxConnectionsPerIp) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

function clientIp(req) {
  // Only trust X-Forwarded-For when explicitly told we are behind a proxy,
  // otherwise any client could spoof the header to evade per-IP limits.
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function send(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function fail(ws, code, message) {
  send(ws, 'error', { code, message });
}

/** Public view of a room — never includes any player's private token. */
function roomState(room) {
  const seat = (n) => {
    const p = room.seats.get(n);
    if (!p) return null;
    return { name: p.name, connected: !!(p.ws && p.ws.readyState === 1) };
  };
  return {
    code: room.code,
    board: room.game.board,
    turn: room.game.turn,
    status: room.game.status,
    winner: room.game.winner,
    winningCells: room.game.winningCells,
    lastMove: room.game.lastMove,
    players: { red: seat(RED), yellow: seat(YELLOW) },
    scores: { red: room.scores[RED], yellow: room.scores[YELLOW], draws: room.scores.draws },
    spectators: room.spectators.size,
    rematchVotes: [...room.rematchVotes],
  };
}

function broadcast(room) {
  const message = JSON.stringify({ type: 'state', state: roomState(room) });
  for (const player of room.seats.values()) {
    if (player.ws && player.ws.readyState === 1) player.ws.send(message);
  }
  for (const ws of room.spectators) {
    if (ws.readyState === 1) ws.send(message);
  }
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  totalConnections += 1;
  connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);

  // Per-connection state lives here, never on the client.
  const ctx = {
    ip,
    room: null,
    seat: null, // RED | YELLOW | null (null = spectator)
    token: null,
    tokens: LIMITS.rateBurst,
    lastRefill: Date.now(),
  };
  ws.ctx = ctx;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      fail(ws, 'bad_frame', 'Binary frames are not accepted.');
      return;
    }

    if (!consumeRateToken(ctx)) {
      fail(ws, 'rate_limited', 'Slow down.');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      fail(ws, 'bad_json', 'Malformed message.');
      return;
    }

    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      fail(ws, 'bad_message', 'Malformed message.');
      return;
    }

    try {
      handleMessage(ws, ctx, msg);
    } catch (err) {
      // A bug in one handler must never take the process down.
      console.error('[handler]', err && err.message);
      fail(ws, 'server_error', 'Something went wrong.');
    }
  });

  ws.on('close', () => {
    totalConnections -= 1;
    const n = (connectionsPerIp.get(ip) || 1) - 1;
    if (n <= 0) connectionsPerIp.delete(ip);
    else connectionsPerIp.set(ip, n);

    const room = ctx.room;
    if (!room) return;

    if (ctx.seat) {
      const player = room.seats.get(ctx.seat);
      // Keep the seat reserved so the player can reclaim it with their token.
      if (player && player.ws === ws) player.ws = null;
      room.rematchVotes.delete(ctx.seat);
    } else {
      room.spectators.delete(ws);
    }

    room.lastActivity = Date.now();
    broadcast(room);
    deleteRoomIfEmpty(room);
  });

  ws.on('error', () => {
    try { ws.terminate(); } catch { /* already gone */ }
  });

  send(ws, 'hello', { limits: { cols: COLS, rows: ROWS, maxNameLength: LIMITS.maxNameLength } });
});

function consumeRateToken(ctx) {
  const now = Date.now();
  const elapsedSec = (now - ctx.lastRefill) / 1000;
  ctx.lastRefill = now;
  ctx.tokens = Math.min(
    LIMITS.rateBurst,
    ctx.tokens + elapsedSec * LIMITS.rateRefillPerSec,
  );
  if (ctx.tokens < 1) return false;
  ctx.tokens -= 1;
  return true;
}

function handleMessage(ws, ctx, msg) {
  switch (msg.type) {
    case 'create':
      return handleCreate(ws, ctx, msg);
    case 'join':
      return handleJoin(ws, ctx, msg);
    case 'move':
      return handleMove(ws, ctx, msg);
    case 'rematch':
      return handleRematch(ws, ctx);
    case 'leave':
      return ws.close(1000, 'left');
    case 'ping':
      return send(ws, 'pong', {});
    default:
      return fail(ws, 'unknown_type', 'Unsupported message type.');
  }
}

function handleCreate(ws, ctx, msg) {
  if (ctx.room) return fail(ws, 'already_in_room', 'You are already in a room.');

  const room = createRoom();
  if (!room) return fail(ws, 'server_busy', 'Too many active rooms. Try again shortly.');

  const name = sanitizeName(msg.name, 'Red');
  const token = crypto.randomBytes(32).toString('base64url');

  room.seats.set(RED, { name, ws, token });
  ctx.room = room;
  ctx.seat = RED;
  ctx.token = token;
  room.lastActivity = Date.now();

  // The token is sent only to its owner and only over this socket.
  send(ws, 'joined', { code: room.code, seat: 'red', token });
  broadcast(room);
}

function handleJoin(ws, ctx, msg) {
  if (ctx.room) return fail(ws, 'already_in_room', 'You are already in a room.');

  const code = sanitizeRoomCode(msg.code);
  if (!code) return fail(ws, 'bad_code', 'That invite code is not valid.');

  const room = rooms.get(code);
  if (!room) return fail(ws, 'no_such_room', 'No room with that code.');

  room.lastActivity = Date.now();

  // 1. Reconnect: a matching token reclaims the original seat.
  if (typeof msg.token === 'string') {
    for (const seatNum of [RED, YELLOW]) {
      const player = room.seats.get(seatNum);
      if (player && safeTokenEqual(player.token, msg.token)) {
        if (player.ws && player.ws.readyState === 1 && player.ws !== ws) {
          // Same token from a second live socket: the newest wins, the old
          // one is closed so a stolen token can't silently mirror the game.
          try { player.ws.close(4001, 'replaced'); } catch { /* ignore */ }
        }
        player.ws = ws;
        ctx.room = room;
        ctx.seat = seatNum;
        ctx.token = player.token;
        send(ws, 'joined', {
          code: room.code,
          seat: seatNum === RED ? 'red' : 'yellow',
          token: player.token,
        });
        broadcast(room);
        return;
      }
    }
  }

  // 2. Take a free seat.
  for (const seatNum of [RED, YELLOW]) {
    if (!room.seats.has(seatNum)) {
      const name = sanitizeName(msg.name, seatNum === RED ? 'Red' : 'Yellow');
      const token = crypto.randomBytes(32).toString('base64url');
      room.seats.set(seatNum, { name, ws, token });
      ctx.room = room;
      ctx.seat = seatNum;
      ctx.token = token;
      send(ws, 'joined', {
        code: room.code,
        seat: seatNum === RED ? 'red' : 'yellow',
        token,
      });
      broadcast(room);
      return;
    }
  }

  // 3. Both seats taken -> spectate.
  if (room.spectators.size >= LIMITS.maxSpectatorsPerRoom) {
    return fail(ws, 'room_full', 'This room is full.');
  }
  room.spectators.add(ws);
  ctx.room = room;
  ctx.seat = null;
  send(ws, 'joined', { code: room.code, seat: 'spectator', token: null });
  broadcast(room);
}

function handleMove(ws, ctx, msg) {
  const room = ctx.room;
  if (!room) return fail(ws, 'not_in_room', 'Join a room first.');
  if (!ctx.seat) return fail(ws, 'spectator', 'Spectators cannot move.');

  const player = room.seats.get(ctx.seat);
  // Re-verify ownership: the seat must still belong to THIS socket.
  if (!player || player.ws !== ws) {
    return fail(ws, 'stale_seat', 'Your seat is no longer active.');
  }

  if (room.seats.size < 2) {
    return fail(ws, 'waiting', 'Waiting for an opponent.');
  }

  // `msg.column` is the ONLY game input a client can supply. Everything else
  // about the board is derived server-side.
  const result = applyMove(room.game, ctx.seat, msg.column);
  if (!result.ok) {
    return fail(ws, result.error, 'That move is not allowed.');
  }

  if (room.game.status === 'won') {
    room.scores[room.game.winner] += 1;
  } else if (room.game.status === 'draw') {
    room.scores.draws += 1;
  }

  room.rematchVotes.clear();
  room.lastActivity = Date.now();
  broadcast(room);
}

function handleRematch(ws, ctx) {
  const room = ctx.room;
  if (!room) return fail(ws, 'not_in_room', 'Join a room first.');
  if (!ctx.seat) return fail(ws, 'spectator', 'Spectators cannot vote.');
  if (room.game.status === 'playing') {
    return fail(ws, 'game_in_progress', 'Finish the game first.');
  }

  const player = room.seats.get(ctx.seat);
  if (!player || player.ws !== ws) {
    return fail(ws, 'stale_seat', 'Your seat is no longer active.');
  }

  room.rematchVotes.add(ctx.seat);
  room.lastActivity = Date.now();

  const bothVoted = [RED, YELLOW].every(
    (s) => !room.seats.has(s) || room.rematchVotes.has(s),
  );

  if (bothVoted && room.seats.size === 2) {
    // Loser of the previous game opens; a draw keeps Red opening.
    const opener = room.game.winner === RED ? YELLOW : RED;
    room.game = createGame();
    room.game.turn = opener;
    room.rematchVotes.clear();
  }

  broadcast(room);
}

// ---------------------------------------------------------------------------
// Liveness + housekeeping
// ---------------------------------------------------------------------------

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, LIMITS.heartbeatMs);
heartbeat.unref();

const reaper = setInterval(() => {
  const cutoff = Date.now() - LIMITS.roomIdleMs;
  for (const [code, room] of rooms) {
    const live =
      [...room.seats.values()].some((p) => p.ws && p.ws.readyState === 1) ||
      room.spectators.size > 0;
    if (!live && room.lastActivity < cutoff) {
      rooms.delete(code);
    }
  }
}, 60 * 1000);
reaper.unref();

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  clearInterval(heartbeat);
  clearInterval(reaper);
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Connect Four listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { server, wss, rooms, sanitizeName, sanitizeRoomCode, randomCode };
