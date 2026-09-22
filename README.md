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

| Concern                        | Mitigation                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cheating / forged state        | All rules server-side; `column` is the only client input                                                                                                         |
| Seat hijacking                 | 256-bit `crypto.randomBytes` token per seat, compared with `timingSafeEqual`; tokens are sent only to their owner and never appear in broadcast state            |
| Cross-site WebSocket hijacking | `Origin` checked against `Host` on upgrade; extra origins via `ALLOWED_ORIGINS`                                                                                  |
| XSS                            | Strict CSP (`default-src 'none'`, no inline script or style); names stripped of control/zero-width/bidi characters server-side _and_ rendered with `textContent` |
| Path traversal                 | Static files served from a fixed route allowlist read into memory at boot — no filesystem path is ever built from a request                                      |
| Clickjacking                   | `X-Frame-Options: DENY` + `frame-ancestors 'none'`                                                                                                               |
| Message flooding               | Per-connection token bucket (5/s sustained, burst 20)                                                                                                            |
| Memory exhaustion              | 4 KB frame cap, caps on rooms/connections/connections-per-IP/spectators, idle rooms reaped after 30 min                                                          |
| Compression amplification      | `permessage-deflate` disabled                                                                                                                                    |
| Dead connections               | 30s ping/pong heartbeat, unresponsive sockets terminated                                                                                                         |
| Crash from bad input           | Every handler is wrapped; parse failures answer with an error frame instead of throwing                                                                          |
| Header spoofing                | `X-Forwarded-For` is only honoured when `TRUST_PROXY=1`                                                                                                          |

Dependencies: one (`ws`). No database, no user accounts, no cookies, no
telemetry, nothing persisted to disk.

### Exposing it publicly

The quickest public URL, no account and no DNS setup:

```bash
cloudflared tunnel --config /dev/null --url http://127.0.0.1:3000
```

Then restart the server with the hostname it prints:

```bash
ALLOWED_ORIGINS=https://<name>.trycloudflare.com TRUST_PROXY=1 npm start
```

Four things that cost real time when they go wrong:

- **Pass `--config`.** Without it cloudflared picks up `~/.cloudflared/config.yml`
  if one exists, inheriting that tunnel's ingress rules — including any trailing
  `http_status:404` catch-all, which makes every request 404 for no visible reason.
- **`ALLOWED_ORIGINS` must match the public hostname**, or the server's own CSWSH
  check refuses the WebSocket upgrade and the board never loads. A quick tunnel
  gets a new hostname every restart, so this has to be updated each time.
- **`TRUST_PROXY=1` is required behind a tunnel.** Otherwise every request appears
  to come from `127.0.0.1` and the per-IP connection cap applies to all players at
  once. It does mean a client that can reach the port directly can spoof
  `X-Forwarded-For`; bind to `127.0.0.1` if that matters more than LAN access.
- **Don't set `MemoryDenyWriteExecute=true`** in a systemd unit. V8 JITs, so the
  process core-dumps with `SIGTRAP` on startup.

`deploy/connect-four.service` runs the server as a systemd user service. It
covers only the server — the tunnel is left to whatever you choose, so nothing
is wired to a particular domain.

Verifying a public URL: resolve it normally rather than pinning with
`curl --resolve`. Pinning bypasses DNS, which is the part most likely to be
broken, and makes a dead link look healthy.

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
