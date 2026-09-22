"use strict";

/**
 * Adversarial audit harness. Runs attacks against a disposable server and
 * reports measurements, not opinions.
 *
 * Usage: node test/audit.js            (spawns its own server)
 */

const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const findings = [];

// Read the configured caps rather than hard-coding them, so a limit that is
// loosened later shows up in the projection instead of going unnoticed.
// Requiring server.js does not bind a port (it only listens as main).
const { LIMITS: SERVER_LIMITS } = require("../server");
const maxLobbyMembers =
  SERVER_LIMITS.maxLobbyMembers || SERVER_LIMITS.maxConnections;

function report(id, severity, title, evidence) {
  findings.push({ id, severity, title, evidence });
  const tag = severity.toUpperCase().padEnd(8);
  console.log(`\n[${tag}] ${id}  ${title}`);
  for (const line of evidence.split("\n")) console.log(`           ${line}`);
}

function ok(id, title, evidence) {
  console.log(`\n[ OK     ] ${id}  ${title}`);
  if (evidence)
    for (const l of evidence.split("\n")) console.log(`           ${l}`);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function waitListening(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        res();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) rej(new Error("no start"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function open(port, opts = {}, host = "127.0.0.1") {
  return new WebSocket(`ws://${host}:${port}/ws`, opts);
}

/** This machines non-loopback address, standing in for a LAN attacker. */
function lanAddress() {
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return null;
}

function onceOpen(ws) {
  return new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
}

function getHeaders(port, pathname = "/", extraHeaders = {}) {
  return new Promise((res) => {
    http
      .get(
        { host: "127.0.0.1", port, path: pathname, headers: extraHeaders },
        (r) => {
          r.resume();
          res({ status: r.statusCode, headers: r.headers });
        },
      )
      .on("error", () => res({ status: 0, headers: {} }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A well-formed but (almost certainly) non-existent room code. */
function randomGuess() {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "0.0.0.0",
      // Audit under the SAME configuration the deployment uses.
      TRUST_PROXY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => {
    serverLog += d;
  });
  server.stderr.on("data", (d) => {
    serverLog += d;
  });

  const cleanup = () => {
    try {
      server.kill("SIGKILL");
    } catch {}
  };
  process.on("exit", cleanup);

  await waitListening(port);
  console.log(`\naudit target: 127.0.0.1:${port}\n${"=".repeat(64)}`);

  // -------------------------------------------------------------------
  // A1. Security response headers
  // -------------------------------------------------------------------
  const { headers } = await getHeaders(port, "/", {
    "X-Forwarded-Proto": "https",
  });
  const missing = [];
  if (!headers["strict-transport-security"])
    missing.push("Strict-Transport-Security");
  const csp = headers["content-security-policy"] || "";
  if (/connect-src[^;]*\bwss?:/.test(csp)) {
    missing.push("connect-src allows the bare ws:/wss: schemes (any host)");
  }
  if (missing.length) {
    report("A1", "low", "Response header gaps", missing.join("\n"));
  } else {
    ok("A1", "Response headers complete");
  }

  // -------------------------------------------------------------------
  // A2. Per-IP cap vs X-Forwarded-For spoofing, from a NON-loopback peer.
  // This is the path a real attacker has: the tunnel is the only loopback
  // client, so a spoofed forwarding header from anywhere else must be ignored.
  // -------------------------------------------------------------------
  {
    const lan = lanAddress();
    if (!lan) {
      ok("A2", "skipped - no non-loopback interface to attack from");
    } else {
      const socks = [];
      let rejected = 0;
      for (let i = 0; i < 30; i++) {
        const ws = open(
          port,
          { headers: { "X-Forwarded-For": `10.0.0.${i}` } },
          lan,
        );
        try {
          await onceOpen(ws);
          socks.push(ws);
        } catch {
          rejected++;
        }
      }
      const accepted = socks.length;
      socks.forEach((s) => s.close());
      if (accepted > 20) {
        report(
          "A2",
          "high",
          "Per-IP connection cap bypassed by spoofing X-Forwarded-For",
          `from ${lan} (untrusted peer): opened ${accepted}/30 against a cap of 20\n` +
            `by varying the header. The server listens on 0.0.0.0, so any LAN\n` +
            `client can send it.`,
        );
      } else {
        ok(
          "A2",
          "Spoofed forwarding headers from an untrusted peer are ignored",
          `from ${lan}: accepted ${accepted}, rejected ${rejected} (cap 20)`,
        );
      }
      await sleep(300);
    }
  }

  // -------------------------------------------------------------------
  // A2b. The inverse must also hold: the trusted proxy has to be able to
  // set the client identity, or every player behind the tunnel collapses
  // into one rate-limit bucket and throttles strangers for each other.
  // -------------------------------------------------------------------
  {
    const socks = [];
    let rejected = 0;
    for (let i = 0; i < 24; i++) {
      const ws = open(port, {
        headers: { "CF-Connecting-IP": `203.0.113.${i}` },
      });
      try {
        await onceOpen(ws);
        socks.push(ws);
      } catch {
        rejected++;
      }
    }
    const accepted = socks.length;
    socks.forEach((s) => s.close());
    if (accepted < 24) {
      report(
        "A2b",
        "high",
        "Distinct players behind the tunnel share one rate-limit bucket",
        `24 distinct client IPs forwarded by the loopback proxy: ${accepted}\n` +
          `accepted, ${rejected} rejected. The per-IP cap is throttling unrelated\n` +
          `players as though they were a single host.`,
      );
    } else {
      ok(
        "A2b",
        "Trusted proxy still sets per-client identity",
        `24 distinct CF-Connecting-IP values all accepted`,
      );
    }
    await sleep(300);
  }

  // -------------------------------------------------------------------
  // A3. Lobby broadcast amplification
  // -------------------------------------------------------------------
  {
    // 25 victims sitting in the lobby.
    const victims = [];
    let victimBytes = 0;
    for (let i = 0; i < 25; i++) {
      const ws = open(port, { headers: { "X-Forwarded-For": `10.2.0.${i}` } });
      await onceOpen(ws);
      ws.on("message", (d) => {
        victimBytes += d.length;
      });
      ws.send(JSON.stringify({ type: "lobby_join", name: `V${i}` }));
      victims.push(ws);
    }
    await sleep(300);

    const attacker = open(port, { headers: { "X-Forwarded-For": "10.3.0.1" } });
    await onceOpen(attacker);
    attacker.send(JSON.stringify({ type: "lobby_join", name: "A" }));
    await sleep(200);

    victimBytes = 0;
    let attackerBytes = 0;
    const N = 20;
    for (let i = 0; i < N; i++) {
      const payload = JSON.stringify({ type: "lobby_join", name: "A" });
      attackerBytes += payload.length;
      attacker.send(payload);
      await sleep(25); // stay under the generic limiter
    }
    await sleep(600);

    const ratio = victimBytes / Math.max(1, attackerBytes);
    if (ratio > 20) {
      report(
        "A3",
        "high",
        "Lobby re-join triggers an unthrottled fan-out to every lobby member",
        `${N} lobby_join messages (${attackerBytes} B) produced ${victimBytes} B\n` +
          `delivered to 25 idle victims: amplification x${ratio.toFixed(0)}.\n` +
          `Each one also rebuilds the whole game list (O(rooms)). With the lobby\n` +
          `cap of 1000 members this scales to a self-inflicted broadcast storm.`,
      );
    } else {
      ok(
        "A3",
        "Lobby fan-out is bounded",
        `amplification x${ratio.toFixed(1)}`,
      );
    }
    attacker.close();
    victims.forEach((v) => v.close());
    await sleep(200);
  }

  // -------------------------------------------------------------------
  // A4. Room exhaustion from a single origin
  // -------------------------------------------------------------------
  {
    const held = [];
    let created = 0;
    for (let i = 0; i < 40; i++) {
      // One client identity, forwarded by the trusted proxy, as a real
      // room-flooder behind the tunnel would appear.
      const ws = open(port, {
        headers: { "CF-Connecting-IP": "198.51.100.7" },
      });
      try {
        await onceOpen(ws);
      } catch {
        break;
      }
      const got = new Promise((res) => {
        ws.on("message", (d) => {
          const m = JSON.parse(d.toString());
          if (m.type === "joined") res(true);
          if (m.type === "error") res(false);
        });
      });
      ws.send(JSON.stringify({ type: "create", name: `H${i}` }));
      if (await got) created++;
      held.push(ws);
    }
    if (created > 5) {
      report(
        "A4",
        "medium",
        "No cap on rooms created per client",
        `one host created and held ${created} rooms open.\n` +
          `The global cap is ${500}; holding sockets open keeps each room alive\n` +
          `(the idle reaper only collects rooms with no live socket), so a single\n` +
          `attacker can occupy the room table and deny room creation to everyone.`,
      );
    } else {
      ok("A4", "Room creation is capped per client", `created ${created}`);
    }
    held.forEach((h) => h.close());
    await sleep(200);
  }

  // -------------------------------------------------------------------
  // A5. Private-room code brute force: is a wrong guess penalised?
  // -------------------------------------------------------------------
  {
    const ws = open(port, { headers: { "X-Forwarded-For": "10.4.0.1" } });
    await onceOpen(ws);
    let errors = 0;
    let limited = 0;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "error") {
        if (m.code === "no_such_room") errors++;
        if (m.code === "rate_limited" || m.code === "join_rate_limited")
          limited++;
      }
    });
    for (let i = 0; i < 40 && ws.readyState === 1; i++) {
      ws.send(JSON.stringify({ type: "join", code: "ABCDEF" }));
      await sleep(30);
    }
    await sleep(400);
    // The generic limiter is the first line; A9 covers whether guessing is
    // ever actually stopped. Either signal counts as the guess costing
    // something, which is all this check is asserting.
    const cut = ws.readyState !== 1;
    if (limited === 0 && !cut && errors > 30) {
      report(
        "A5",
        "medium",
        "Failed room-code guesses carry no specific penalty",
        `${errors} wrong codes accepted with no throttle and no disconnect.`,
      );
    } else {
      ok(
        "A5",
        "Failed joins cost the guesser something",
        `errors ${errors}, throttled ${limited}, socket cut: ${cut}`,
      );
    }
    try {
      ws.close();
    } catch {}
  }

  // -------------------------------------------------------------------
  // A8. Lobby chat fan-out amplification from ONE address.
  // Chat is rate limited per connection, but one address may hold 20 of
  // them, so the real question is what one IP can push at the lobby.
  // -------------------------------------------------------------------
  {
    const ATTACK_IP = "198.51.100.44";
    const victims = [];
    let victimBytes = 0;
    for (let i = 0; i < 25; i++) {
      const ws = open(port, { headers: { "CF-Connecting-IP": `10.5.0.${i}` } });
      await onceOpen(ws);
      ws.on("message", (d) => {
        victimBytes += d.length;
      });
      ws.send(JSON.stringify({ type: "lobby_join", name: `L${i}` }));
      victims.push(ws);
    }
    await sleep(400);

    // 20 sockets, the per-IP connection cap, all from one client.
    const attackers = [];
    for (let i = 0; i < 20; i++) {
      const ws = open(port, { headers: { "CF-Connecting-IP": ATTACK_IP } });
      try {
        await onceOpen(ws);
      } catch {
        break;
      }
      ws.send(JSON.stringify({ type: "lobby_join", name: "A" }));
      attackers.push(ws);
    }
    await sleep(400);

    victimBytes = 0;
    let attackerBytes = 0;
    const spam = "x".repeat(300);
    const started = Date.now();
    // One burst per socket: whatever the chat bucket lets through at once.
    for (let round = 0; round < 6; round++) {
      for (const ws of attackers) {
        const payload = JSON.stringify({ type: "lobby_chat", text: spam });
        attackerBytes += payload.length;
        ws.send(payload);
      }
      await sleep(120);
    }
    await sleep(800);
    const ELAPSED_SEC = (Date.now() - started) / 1000;

    // Ratio is the wrong yardstick for a chat room — any broadcast amplifies.
    // What matters is the absolute egress ONE address can command, projected
    // to a full lobby, since the observed 25 victims are not the ceiling.
    const observed = victimBytes / 25; // bytes per lobby member
    const LOBBY_CAP = maxLobbyMembers ?? 1000;
    const projectedMb = (observed * LOBBY_CAP) / (1024 * 1024);
    const perSec = projectedMb / ELAPSED_SEC;
    const kb = (victimBytes / 1024).toFixed(0);
    if (perSec > 2) {
      report(
        "A8",
        "high",
        "One address can flood the whole lobby through chat fan-out",
        `${attackers.length} sockets from ${ATTACK_IP} sent ${attackerBytes} B and\n` +
          `delivered ${kb} KB to 25 lobby members in ${ELAPSED_SEC}s.\n` +
          `Projected at the ${LOBBY_CAP}-member lobby cap that is ` +
          `${perSec.toFixed(1)} MB/s of egress\n` +
          `from a single client. The chat bucket is per CONNECTION, so the\n` +
          `per-IP connection cap multiplies the allowance instead of bounding it.`,
      );
    } else {
      ok(
        "A8",
        "Lobby chat fan-out is bounded per address",
        `${attackers.length} sockets from one IP delivered ${kb} KB to 25 members;\n` +
          `projected ${perSec.toFixed(2)} MB/s at the ${LOBBY_CAP}-member cap`,
      );
    }
    attackers.forEach((a) => a.close());
    victims.forEach((v) => v.close());
    await sleep(300);
  }

  // -------------------------------------------------------------------
  // A9. Private-room code brute force over a long run. A5 checks that the
  // generic limiter slows it; this checks whether guessing is ever
  // actually stopped, which is what decides the time-to-hit.
  // -------------------------------------------------------------------
  {
    const ws = open(port, { headers: { "CF-Connecting-IP": "198.51.100.55" } });
    await onceOpen(ws);
    let guesses = 0;
    let closed = false;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "error" && m.code === "no_such_room") guesses++;
    });
    ws.on("close", () => {
      closed = true;
    });
    for (let i = 0; i < 120 && !closed; i++) {
      if (ws.readyState !== 1) break;
      ws.send(JSON.stringify({ type: "join", code: randomGuess() }));
      await sleep(15);
    }
    await sleep(500);
    if (!closed) {
      report(
        "A9",
        "medium",
        "Guessing private room codes is throttled but never stopped",
        `${guesses} wrong codes answered on one socket with no disconnect.\n` +
          `A guesser can hold the socket open indefinitely; only the 5/s\n` +
          `limiter applies, and it may reconnect ${20} times per address.`,
      );
    } else {
      ok(
        "A9",
        "Sustained room-code guessing gets the socket cut",
        `socket closed after ${guesses} wrong codes`,
      );
    }
    try {
      ws.close();
    } catch {}
    await sleep(200);
  }

  // -------------------------------------------------------------------
  // A10. Slowloris: half-open HTTP requests that never send the final CRLF.
  // -------------------------------------------------------------------
  {
    const socks = [];
    const closed = new Set();
    for (let i = 0; i < 40; i++) {
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => {});
      // Both of these matter. Without resume() the readable side stays paused,
      // so the server's FIN never surfaces as "close" and every socket looks
      // alive no matter what the server did — the harness would report a
      // finding the server had already fixed.
      s.resume();
      s.on("close", () => closed.add(i));
      s.on("end", () => closed.add(i));
      await new Promise((res) => {
        s.once("connect", res);
        s.once("error", res);
      });
      // A request head that is never terminated.
      s.write(`GET / HTTP/1.1\r\nHost: localhost\r\nX-Pad-${i}: a\r\n`);
      socks.push(s);
    }
    await sleep(12000); // past any sane headers timeout
    const stillOpen = socks.length - closed.size;
    socks.forEach((s) => s.destroy());
    if (stillOpen > 5) {
      report(
        "A10",
        "medium",
        "Half-open HTTP requests are held indefinitely",
        `${stillOpen}/40 sockets still open 12s after sending an unterminated\n` +
          `request head. Node's default headers timeout is 60s and there is no\n` +
          `connection cap, so a trickle of sockets can occupy the listener.`,
      );
    } else {
      ok(
        "A10",
        "Half-open requests are timed out",
        `${stillOpen}/40 still open after 12s`,
      );
    }
    await sleep(200);
  }

  // -------------------------------------------------------------------
  // A6. Did anything crash the server?
  // -------------------------------------------------------------------
  const health = await getHeaders(port, "/healthz");
  if (health.status !== 200) {
    report(
      "A6",
      "critical",
      "Server stopped responding during the audit",
      serverLog.slice(-800),
    );
  } else {
    ok("A6", "Server survived the full audit", "healthz still 200");
  }
  if (serverLog.includes("[handler]")) {
    report(
      "A7",
      "medium",
      "Handler threw during the audit",
      serverLog.slice(-800),
    );
  }

  console.log(`\n${"=".repeat(64)}`);
  const bySev = (s) => findings.filter((f) => f.severity === s).length;
  console.log(
    `findings: ${findings.length}  ` +
      `(critical ${bySev("critical")}, high ${bySev("high")}, ` +
      `medium ${bySev("medium")}, low ${bySev("low")})`,
  );

  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error("audit failed:", e);
  process.exit(1);
});
