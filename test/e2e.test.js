'use strict';

/**
 * End-to-end test against a running server.
 * Usage: node test/e2e.test.js [http://127.0.0.1:3000]
 */

const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${extra ? '\n      ' + extra : ''}`);
  }
}

/** A tiny promise-based client wrapper. */
function client(opts = {}) {
  const ws = new WebSocket(WS_URL, opts);
  const queue = [];
  const waiters = [];

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const w = waiters.findIndex((x) => x.match(msg));
    if (w !== -1) {
      const [{ resolve, timer }] = waiters.splice(w, 1);
      clearTimeout(timer);
      resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    ws,
    open: () => new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** Drops buffered messages so a later wait() cannot match a stale broadcast. */
    drain: () => { queue.length = 0; },
    /** Waits for the next message matching `match`, checking buffered ones first. */
    wait: (match, ms = 4000) => new Promise((resolve, reject) => {
      const i = queue.findIndex(match);
      if (i !== -1) return resolve(queue.splice(i, 1)[0]);
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for message')),
        ms,
      );
      waiters.push({ match, resolve, timer });
    }),
    close: () => ws.close(),
  };
}

const isType = (t) => (m) => m.type === t;

async function main() {
  console.log('\nend-to-end (two clients, one full game)');

  const a = client();
  const b = client();
  await Promise.all([a.open(), b.open()]);

  await a.wait(isType('hello'));
  await b.wait(isType('hello'));
  check('both clients receive hello', true);

  a.send({ type: 'create', name: 'Alice' });
  const joinedA = await a.wait(isType('joined'));
  check('creator is seated as red', joinedA.seat === 'red');
  check('creator gets a 6-char invite code', /^[A-Z2-9]{6}$/.test(joinedA.code), joinedA.code);
  check('creator gets a private token', typeof joinedA.token === 'string' && joinedA.token.length >= 40);

  const code = joinedA.code;

  b.send({ type: 'join', code, name: 'Bob' });
  const joinedB = await b.wait(isType('joined'));
  check('second player is seated as yellow', joinedB.seat === 'yellow');
  check('the two tokens differ', joinedB.token !== joinedA.token);

  const stateMsg = await a.wait((m) => m.type === 'state' && m.state.players.yellow);
  const stateA = stateMsg.state;
  check('state never leaks a token', !JSON.stringify(stateMsg).includes(joinedA.token));
  check('both player names are present', stateA.players.red.name === 'Alice' && stateA.players.yellow.name === 'Bob');

  // --- rule enforcement over the wire ---
  b.send({ type: 'move', column: 0 });
  const errTurn = await b.wait(isType('error'));
  check('moving out of turn is refused', errTurn.code === 'not_your_turn', errTurn.code);

  a.send({ type: 'move', column: 99 });
  const errCol = await a.wait(isType('error'));
  check('an out-of-range column is refused', errCol.code === 'invalid_column', errCol.code);

  a.send({ type: 'move', column: '3' });
  const errStr = await a.wait(isType('error'));
  check('a string column is refused', errStr.code === 'invalid_column', errStr.code);

  // --- play a real game: Alice wins vertically in column 3 ---
  const script = [[a, 3], [b, 4], [a, 3], [b, 4], [a, 3], [b, 4], [a, 3]];
  let finalState = null;
  for (const [who, col] of script) {
    who.send({ type: 'move', column: col });
    finalState = (await a.wait((m) => m.type === 'state' && m.state.lastMove
      && m.state.lastMove.col === col)).state;
  }

  check('a vertical connect-four ends the game', finalState.status === 'won', finalState.status);
  check('red is recorded as the winner', finalState.winner === 1, String(finalState.winner));
  check('four winning cells are reported', finalState.winningCells.length === 4);
  check('the score updates', finalState.scores.red === 1);

  // --- rematch requires both players ---
  a.send({ type: 'rematch' });
  const afterOne = (await a.wait((m) => m.type === 'state' && m.state.rematchVotes.length === 1)).state;
  check('one rematch vote does not restart the game', afterOne.status === 'won');

  // Mid-game broadcasts are still buffered and would match "status: playing".
  a.drain();
  b.send({ type: 'rematch' });
  const afterBoth = (await a.wait((m) => m.type === 'state' && m.state.status === 'playing')).state;
  check('both votes restart the game', afterBoth.status === 'playing');
  check('the board is cleared on rematch', afterBoth.board.every((r) => r.every((c) => c === 0)));
  check('the loser opens the rematch', afterBoth.turn === 2, String(afterBoth.turn));
  check('scores carry across the rematch', afterBoth.scores.red === 1);

  console.log('\nsecurity probes');

  // --- a third client cannot take a seat, only spectate ---
  const c = client();
  await c.open();
  await c.wait(isType('hello'));
  c.send({ type: 'join', code, name: 'Eve' });
  const joinedC = await c.wait(isType('joined'));
  check('a third client is downgraded to spectator', joinedC.seat === 'spectator', joinedC.seat);
  check('a spectator is issued no token', joinedC.token === null);

  c.send({ type: 'move', column: 0 });
  const errSpec = await c.wait(isType('error'));
  check('a spectator cannot move', errSpec.code === 'spectator', errSpec.code);

  // --- a guessed / wrong token does not grant a seat ---
  const d = client();
  await d.open();
  await d.wait(isType('hello'));
  d.send({ type: 'join', code, token: 'x'.repeat(43), name: 'Mallory' });
  const joinedD = await d.wait(isType('joined'));
  check('a forged token does not hijack a seat', joinedD.seat === 'spectator', joinedD.seat);

  // --- malformed input is rejected without killing the connection ---
  const e = client();
  await e.open();
  await e.wait(isType('hello'));

  e.ws.send('not json at all');
  check('malformed JSON is rejected', (await e.wait(isType('error'))).code === 'bad_json');

  e.ws.send('[1,2,3]');
  check('a non-object payload is rejected', (await e.wait(isType('error'))).code === 'bad_message');

  e.ws.send('null');
  check('a null payload is rejected', (await e.wait(isType('error'))).code === 'bad_message');

  e.send({ type: '__proto__' });
  check('an unknown type is rejected', (await e.wait(isType('error'))).code === 'unknown_type');

  e.send({ type: 'join', code: '../../etc/passwd' });
  check('a path-traversal room code is rejected', (await e.wait(isType('error'))).code === 'bad_code');

  e.send({ type: 'join', code: 'ZZZZZZ' });
  check('an unknown room code is rejected', (await e.wait(isType('error'))).code === 'no_such_room');

  e.send({ type: 'move', column: 0 });
  check('moving without a room is rejected', (await e.wait(isType('error'))).code === 'not_in_room');

  check('the connection survived every malformed payload', e.ws.readyState === WebSocket.OPEN);

  // --- prototype pollution attempt ---
  e.ws.send(JSON.stringify({ type: 'join', code, __proto__: { polluted: true } }));
  await e.wait((m) => m.type === 'joined' || m.type === 'error');
  check('Object.prototype was not polluted', ({}).polluted === undefined);

  // --- rate limiting ---
  const f = client();
  await f.open();
  await f.wait(isType('hello'));
  for (let i = 0; i < 80; i++) f.send({ type: 'ping' });
  let limited = false;
  try {
    await f.wait((m) => m.type === 'error' && m.code === 'rate_limited', 3000);
    limited = true;
  } catch { /* no rate-limit message arrived */ }
  check('a message flood is rate limited', limited);
  check('the flooding connection stays open (throttled, not killed)', f.ws.readyState === WebSocket.OPEN);

  // --- oversized frame is dropped by the ws maxPayload guard ---
  const g = client();
  await g.open();
  await g.wait(isType('hello'));
  const closedBig = new Promise((res) => g.ws.once('close', (codeNum) => res(codeNum)));
  g.ws.send(JSON.stringify({ type: 'create', name: 'x'.repeat(100000) }));
  const closeCode = await Promise.race([
    closedBig,
    new Promise((res) => setTimeout(() => res(null), 3000)),
  ]);
  check('an oversized frame closes the socket', closeCode === 1009, `close code ${closeCode}`);

  // --- cross-site WebSocket hijacking ---
  const evil = new WebSocket(WS_URL, { origin: 'http://evil.example.com' });
  const evilResult = await new Promise((res) => {
    evil.once('open', () => res('open'));
    evil.once('error', (err) => res(err.message));
    setTimeout(() => res('timeout'), 3000);
  });
  check('a foreign Origin is refused (CSWSH)', evilResult !== 'open', String(evilResult));

  // --- reconnect with the real token reclaims the seat ---
  a.close();
  await new Promise((r) => setTimeout(r, 200));
  const a2 = client();
  await a2.open();
  await a2.wait(isType('hello'));
  a2.send({ type: 'join', code, token: joinedA.token, name: 'Alice' });
  const rejoined = await a2.wait(isType('joined'));
  check('the real token reclaims the original seat', rejoined.seat === 'red', rejoined.seat);

  for (const cl of [a2, b, c, d, e, f]) { try { cl.close(); } catch { /* ignore */ } }
  try { evil.close(); } catch { /* ignore */ }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nE2E RUN FAILED:', err.message);
  process.exit(1);
});
