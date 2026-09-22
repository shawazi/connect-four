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
npm test          # rules engine, input sanitising, source hygiene
npm run test:e2e  # full game over WebSockets + security probes
npm run audit     # adversarial harness (see below)
npm run test:all  # all three
```

`test:e2e` and `audit` each spawn their own throwaway server on an ephemeral
port bound to `127.0.0.1`. Never point them at a running instance — an earlier
version did, and its fixtures ended up in the live lobby chat.

The e2e suite plays a complete game between two real clients and then attacks
the server: out-of-turn moves, out-of-range and non-integer columns, forged
seat tokens, spectator moves, malformed JSON, prototype pollution, path
traversal in room codes, message floods, oversized frames, and cross-site
WebSocket hijacking.

### The audit harness

`test/audit.js` is not a unit test. It runs attacks against a disposable server
and reports **measurements**, so a regression shows up as a number getting
worse rather than as an opinion. It currently covers response headers,
forwarding-header spoofing from an untrusted peer (and the inverse — that a
trusted proxy can still set a client identity), lobby broadcast amplification,
room-table exhaustion, invite-code brute force, chat fan-out egress per
address, and Slowloris.

It has found real bugs. The findings and their fixes are in the git history;
the ones worth knowing about:

- **`connect-src` listed the bare `ws:`/`wss:` schemes**, which match any host.
  The one CSP directive meant to contain an XSS was the one that would have let
  it exfiltrate anywhere.
- **`TRUST_PROXY=1` made `X-Forwarded-For` authoritative unconditionally**, so
  any LAN client could mint a fresh identity per connection and walk through the
  per-IP cap — 30 connections against a cap of 20. Forwarding headers are now
  honoured only from a trusted TCP peer.
- **Lobby list updates fanned out on every triggering event**, which a client
  controls: 20 small messages became 23,500 bytes at 25 idle victims, x37
  amplification. Now coalesced — x1.8.
- **The chat limiter was per connection**, so the per-IP connection cap
  _multiplied_ one client's allowance instead of bounding it: 20 sockets pushed
  930 KB at 25 members in 1.5s, which projects to 23.8 MB/s of egress on
  command. Now two-tier, and the lobby has a member cap.
- **`headersTimeout` alone does nothing.** Node only sweeps for expired
  half-open requests every `connectionsCheckingInterval`, which defaults to 30s
  — longer than any timeout worth setting. It must be passed as a
  `createServer` option; set as a property afterwards it is dead config.

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
| Chat flooding / fan-out abuse  | Two tiers: per connection (1/s, burst 5) _and_ per address (10/s, burst 30), plus a 150-member lobby cap that bounds the broadcast multiplier                    |
| Memory exhaustion              | 4 KB frame cap, caps on rooms/connections/connections-per-IP/rooms-per-IP/spectators, idle rooms reaped after 30 min                                             |
| Compression amplification      | `permessage-deflate` disabled                                                                                                                                    |
| Lobby broadcast storms         | Game-list updates coalesced to one flush per 250 ms, and suppressed entirely when the payload is unchanged                                                       |
| Invite-code guessing           | Socket is cut after 12 wrong codes; a successful join clears the count                                                                                           |
| Slowloris / half-open requests | 8s headers timeout, 15s request timeout, swept every 2s, plus a socket ceiling on the listener                                                                   |
| Dead connections               | 30s ping/pong heartbeat, unresponsive sockets terminated                                                                                                         |
| Crash from bad input           | Every handler is wrapped; parse failures answer with an error frame instead of throwing                                                                          |
| Header spoofing                | `X-Forwarded-For` / `CF-Connecting-IP` / `X-Forwarded-Proto` are honoured only when `TRUST_PROXY=1` **and** the TCP peer is loopback or in `TRUSTED_PROXIES`     |

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

### Running the tunnel as a service

`deploy/quick-tunnel.sh` plus `deploy/connect-four-tunnel.service` supervise the
quick tunnel and solve the hostname churn. The script starts cloudflared, waits
for the hostname it is assigned, writes it to
`~/.config/connect-four/origins.env`, and restarts the game server so its
`ALLOWED_ORIGINS` matches. The server unit reads that file with
`EnvironmentFile=-`, so it still starts for LAN play with no tunnel running.

```bash
systemctl --user enable --now connect-four-tunnel.service
grep -o 'https://[^ ]*' ~/.config/connect-four/origins.env   # the public URL
```

Two more lessons, on top of the four above:

- **Don't run the tunnel as a bare background process.** When the shell that
  owned it died, the public URL went to `HTTP 530` with nothing to restart it.
  Under systemd it is supervised and comes back.
- **The hostname is announced slightly before it resolves.** Anything that
  looks it up in that window caches an `NXDOMAIN` and then reports the URL as
  dead long after it works — `getaddrinfo ENOTFOUND` against a tunnel that is
  healthy. The script flushes the resolver cache after publishing; if you hit it
  by hand, `resolvectl flush-caches`.

Never `pkill cloudflared` to clean up. Other tunnels run on this kind of box,
and killing them is someone else's outage — the script kills only its own child.

`deploy/connect-four.service` runs the server itself. Nothing here is wired to a
particular domain.

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
game.js                rules engine — pure, no I/O
server.js              HTTP + WebSocket, rooms, seats, limits
public/index.html      markup
public/styles.css      styling
public/app.js          renderer + input forwarding
test/game.test.js      unit tests
test/hygiene.test.js   source guards (control bytes, innerHTML)
test/e2e.test.js       two-client game + security probes
test/run-e2e.js        spawns a throwaway server for the e2e suite
test/audit.js          adversarial harness, reports measurements
```

## Licence

MIT
