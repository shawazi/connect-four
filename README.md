# Connect Four

Real-time multiplayer Connect Four. Create a game, send the invite link, play.

- Server-authoritative rules — the client only ever sends a column number.
- 6-character invite codes, shareable as a link.
- Reconnect keeps your seat (refresh the page mid-game and you are still you).
- Extra visitors become spectators.
- Rematch with running score; the loser opens the next game.
- Keyboard play: press `1`–`7` to drop a disc.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Set `PORT` / `HOST` to change where it binds:

```bash
PORT=8080 npm start
```

## Play with someone else

On the same network, open `http://<your-lan-ip>:3000`, click **Create a game**,
and send them the invite link shown at the top of the board.

To play with someone outside your network you need to expose the port — a
tunnel (`cloudflared tunnel --url http://localhost:3000`) or a real deployment.
Put it behind TLS if you do; see below.

## Tests

```bash
npm test                  # rules engine + input sanitising (no server needed)
npm start &               # then, against the running server:
node test/e2e.test.js     # full game over WebSockets + security probes
```

The e2e suite plays a complete game between two real clients and then attacks
the server: out-of-turn moves, out-of-range and non-integer columns, forged
seat tokens, spectator moves, malformed JSON, prototype pollution, path
traversal in room codes, message floods, oversized frames, and cross-site
WebSocket hijacking.

## Security model

The threat model is "anyone who can reach the port is hostile."

**The client is never trusted with game state.** The board, whose turn it is,
and who won live only on the server (`game.js`). A move message carries exactly
one field — `column` — which is validated as an integer in `[0, 7)` before it
is used. A client cannot send a board, claim a win, move twice, move as its
opponent, or move after the game ends.

| Concern | Mitigation |
|---|---|
| Cheating / forged state | All rules server-side; `column` is the only client input |
| Seat hijacking | 256-bit `crypto.randomBytes` token per seat, compared with `timingSafeEqual`; tokens are sent only to their owner and never appear in broadcast state |
| Cross-site WebSocket hijacking | `Origin` checked against `Host` on upgrade; extra origins via `ALLOWED_ORIGINS` |
| XSS | Strict CSP (`default-src 'none'`, no inline script or style); names stripped of control/zero-width/bidi characters server-side *and* rendered with `textContent` |
| Path traversal | Static files served from a fixed route allowlist read into memory at boot — no filesystem path is ever built from a request |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'` |
| Message flooding | Per-connection token bucket (5/s sustained, burst 20) |
| Memory exhaustion | 4 KB frame cap, caps on rooms/connections/connections-per-IP/spectators, idle rooms reaped after 30 min |
| Compression amplification | `permessage-deflate` disabled |
| Dead connections | 30s ping/pong heartbeat, unresponsive sockets terminated |
| Crash from bad input | Every handler is wrapped; parse failures answer with an error frame instead of throwing |
| Header spoofing | `X-Forwarded-For` is only honoured when `TRUST_PROXY=1` |

Dependencies: one (`ws`). No database, no user accounts, no cookies, no
telemetry, nothing persisted to disk.

### Behind a proxy

```bash
TRUST_PROXY=1 ALLOWED_ORIGINS=https://c4.example.com PORT=3000 npm start
```

Terminate TLS at the proxy and forward the WebSocket upgrade on `/ws`. Over
HTTPS the page automatically uses `wss:`.

## Layout

```
game.js              rules engine — pure, no I/O
server.js            HTTP + WebSocket, rooms, seats, limits
public/index.html    markup
public/styles.css    styling
public/app.js        renderer + input forwarding
test/game.test.js    unit tests
test/e2e.test.js     two-client game + security probes
```

## Licence

MIT
