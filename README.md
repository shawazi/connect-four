# Connect Four

Real-time multiplayer Connect Four. Create a game, send the invite link, play.

## Current State

- **Status:** Working
- **Last real activity:** 2026-10-03 -- systemd service cleanup
- **Deployed:** not deployed (run locally or self-host)

## Features

- Server-authoritative rules -- the client only ever sends a column number.
- 6-character invite codes, shareable as a link.
- Reconnect keeps your seat (refresh the page mid-game and you are still you).
- Extra visitors become spectators.
- Rematch with running score; the loser opens the next game.
- Keyboard play: press `1`-`7` to drop a disc.
- Lobby with global chat and a public game list.
- In-room chat for players and spectators.

## Setup

### Prerequisites

- Node.js >= 18

### Environment Variables

- `PORT` -- server port (default 3000)
- `HOST` -- bind address
- `ALLOWED_ORIGINS` -- permitted WebSocket origins (for reverse proxy / tunnel)
- `TRUST_PROXY` -- set to `1` behind a reverse proxy

### Run

```bash
npm install
npm start          # http://localhost:3000
```

### Test

```bash
npm test                  # rules engine + input sanitising (no server needed)
npm run test:e2e          # full game over WebSockets + security probes
```

The e2e suite plays a complete game between two real clients and then attacks
the server: out-of-turn moves, out-of-range and non-integer columns, forged
seat tokens, spectator moves, malformed JSON, prototype pollution, path
traversal in room codes, message floods, oversized frames, and cross-site
WebSocket hijacking.

## Security Model

The threat model is "anyone who can reach the port is hostile."

**The client is never trusted with game state.** The board, whose turn it is,
and who won live only on the server (`game.js`). A move message carries exactly
one field -- `column` -- which is validated as an integer in `[0, 7)` before it
is used.

| Concern                        | Mitigation                                                                |
| ------------------------------ | ------------------------------------------------------------------------- |
| Cheating / forged state        | All rules server-side; `column` is the only client input                  |
| Seat hijacking                 | 256-bit `crypto.randomBytes` token per seat, `timingSafeEqual` comparison |
| Cross-site WebSocket hijacking | `Origin` checked against `Host` on upgrade                                |
| XSS                            | Strict CSP (`default-src 'none'`); names rendered with `textContent`      |
| Path traversal                 | Static files served from a fixed route allowlist read into memory at boot |
| Clickjacking                   | `X-Frame-Options: DENY` + `frame-ancestors 'none'`                        |
| Message flooding               | Per-connection token bucket (5/s sustained, burst 20)                     |
| Memory exhaustion              | 4 KB frame cap, room/connection/spectator caps, idle rooms reaped         |
| Dead connections               | 30s ping/pong heartbeat                                                   |

Dependencies: one (`ws`). No database, no user accounts, no cookies, no
telemetry, nothing persisted to disk.

## Layout

```
game.js              rules engine -- pure, no I/O
server.js            HTTP + WebSocket, rooms, seats, limits
public/index.html    markup
public/styles.css    styling
public/app.js        renderer + input forwarding
test/game.test.js    unit tests
test/e2e.test.js     two-client game + security probes
deploy/              systemd service template
```

## Where It Needs to Go

- Playable public demo (self-hosted or static deploy)
- Mobile layout polish

## How to Proceed

1. Deploy to a hosting provider or VPS with the included systemd service.
2. Set `ALLOWED_ORIGINS` to match the public hostname.

## Licence

MIT
