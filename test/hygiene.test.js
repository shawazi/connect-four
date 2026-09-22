"use strict";

/**
 * Source hygiene guards.
 *
 * These exist because of things that actually went wrong, not as style police.
 *
 * 1. Raw control bytes. The sanitising regexes in server.js name control
 *    characters by codepoint. Written as literal bytes instead of \uXXXX
 *    escapes they are invisible in an editor, turn the file into something
 *    tools report as "binary", and silently change what the regex matches.
 *    This happened three separate times while building this, including two NUL
 *    bytes that survived from the first commit.
 *
 * 2. innerHTML in the client. The XSS defence is "chat is rendered with
 *    textContent, never innerHTML". That invariant lives in app.js and nothing
 *    but review enforces it. This does.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
}

function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  })(ROOT);
  return out;
}

console.log("\nsource hygiene");

check("no raw control bytes in any tracked file", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const buf = fs.readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      // Allow tab (9), LF (10), CR (13). Everything else below 0x20, plus
      // DEL, is a literal control character that has no business in source.
      if (b < 9 || (b > 13 && b < 32) || b === 127) {
        offenders.push(
          `${path.relative(ROOT, file)}: byte 0x${b.toString(16).padStart(2, "0")} at offset ${i}`,
        );
        break;
      }
    }
  }
  if (offenders.length) {
    throw new Error(
      `control bytes must be written as \\uXXXX escapes:\n       ` +
        offenders.join("\n       "),
    );
  }
});

check("the client never assigns to innerHTML", () => {
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const assignments = src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    // A comment saying "not innerHTML" is the point, not a violation.
    .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
    .filter(({ line }) => /\.innerHTML\s*(=|\+=)/.test(line));

  if (assignments.length) {
    throw new Error(
      `user text must be rendered with textContent:\n       ` +
        assignments.map((a) => `app.js:${a.n}  ${a.line}`).join("\n       "),
    );
  }
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
