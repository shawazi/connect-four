"use strict";

/**
 * Runs the end-to-end suite against a DISPOSABLE server instance.
 *
 * This exists because the suite writes real data: it creates rooms and posts
 * chat, and lobby chat is global and persists for the life of the process.
 * Pointing it at a running instance puts fixture messages like "Lobbyist" and
 * "s0" in front of real users. So the suite gets its own process on its own
 * ephemeral port, and that process is killed afterwards.
 *
 * Usage: node test/run-e2e.js
 */

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Asks the OS for a free port so parallel runs cannot collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForListening(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error("server did not start"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function main() {
  const port = await freePort();

  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1", // loopback only: a test server is never reachable off-box
      ALLOWED_ORIGINS: "",
      TRUST_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (d) => {
    serverOutput += d.toString();
  });
  server.stderr.on("data", (d) => {
    serverOutput += d.toString();
  });

  const shutdown = () => {
    if (!server.killed) server.kill("SIGTERM");
    // SIGTERM triggers a graceful close; make sure it actually goes away.
    setTimeout(() => {
      if (!server.killed) server.kill("SIGKILL");
    }, 2000).unref();
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  try {
    await waitForListening(port);
  } catch (err) {
    console.error("Disposable server failed to start:\n" + serverOutput);
    shutdown();
    process.exit(1);
  }

  console.log(
    `\nDisposable test server on 127.0.0.1:${port} (pid ${server.pid})`,
  );

  const suite = spawn(
    process.execPath,
    ["test/e2e.test.js", `http://127.0.0.1:${port}`],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, E2E_DISPOSABLE: "1" },
    },
  );

  suite.on("exit", (code) => {
    shutdown();
    if (serverOutput.includes("[handler]")) {
      console.error("\nServer logged a handler error during the run:");
      console.error(serverOutput);
      process.exit(1);
    }
    process.exit(code === null ? 1 : code);
  });
}

main().catch((err) => {
  console.error("run-e2e failed:", err.message);
  process.exit(1);
});
