import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryPath, resolveLinkTarget, isLink } from "./paths.js";

// OPTIONAL advisory soft-lock. Wired through Claude Code's hooks
// (SessionStart -> acquire, SessionEnd/Stop -> release), it writes a LOCK file
// into the cloud-synced memory directory so a second machine starting a session
// can be WARNED that another machine looks active.
//
// It is advisory only. It NEVER blocks a session and NEVER fails in a way that
// stops Claude from running:
//   - A true cross-machine lock is impossible: cloud sync is eventually
//     consistent and this code is not in Claude's read/write path. A lock may
//     simply not have propagated yet.
//   - The real safety net is `claude-memory-sync doctor`, which detects provider
//     conflict copies after the fact regardless of timing.

const LOCK_NAME = "LOCK";
const DEFAULT_TTL_HOURS = 8;

function ttlHours() {
  const raw = process.env.CLAUDE_MEMORY_LOCK_TTL_HOURS;
  if (raw && /^[0-9]+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n > 0) return n;
  }
  return DEFAULT_TTL_HOURS;
}

function currentHost() {
  return process.env.HOSTNAME || os.hostname() || "unknown-host";
}

function isoUtcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readField(lockPath, key) {
  try {
    for (const line of fs.readFileSync(lockPath, "utf8").split(/\r?\n/)) {
      if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
    }
  } catch {
    /* ignore */
  }
  return "";
}

function writeLock(lockPath, host) {
  try {
    fs.writeFileSync(lockPath, `host=${host}\nacquired=${isoUtcNow()}\n`);
    return true;
  } catch {
    return false;
  }
}

function humanAge(seconds) {
  let s = seconds < 0 ? 0 : seconds;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m`;
}

function acquire(cloudDir) {
  const lock = path.join(cloudDir, LOCK_NAME);
  const self = currentHost();

  if (fs.existsSync(lock) && fs.statSync(lock).isFile()) {
    const other = readField(lock, "host");
    const ttl = ttlHours() * 3600;
    let age = null;
    let isFresh = true;
    try {
      const mtime = fs.statSync(lock).mtimeMs;
      age = Math.max(0, Math.floor((Date.now() - mtime) / 1000));
      isFresh = age <= ttl;
    } catch {
      isFresh = true; // be conservative: warn rather than stomp
    }

    if (isFresh && other && other !== self) {
      const acquired = readField(lock, "acquired");
      const ageStr = age !== null ? humanAge(age) : "";
      process.stderr.write("claude-memory-sync: WARNING — another machine looks active.\n");
      let line = `  A fresh memory LOCK is held by host "${other}"`;
      if (acquired) line += ` (acquired ${acquired})`;
      process.stderr.write(`${line}.\n`);
      if (ageStr) process.stderr.write(`  Lock age: ${ageStr} (TTL ${ttlHours()}h).\n`);
      process.stderr.write("  Running two live sessions against the same memory can create\n");
      process.stderr.write("  conflict copies. Prefer switching machines sequentially.\n");
      process.stderr.write("  This is advisory only — your session is NOT blocked. After any\n");
      process.stderr.write("  overlap, run: claude-memory-sync doctor\n");
      return; // do not overwrite the other host's fresh lock
    }
    // Otherwise: same host or stale lock -> safe to take over.
  }

  writeLock(lock, self);
}

function release(cloudDir) {
  const lock = path.join(cloudDir, LOCK_NAME);
  const self = currentHost();
  if (!fs.existsSync(lock) || !fs.statSync(lock).isFile()) return;
  const owner = readField(lock, "host");
  if (owner && owner !== self) return; // never delete another machine's lock
  try {
    fs.rmSync(lock, { force: true });
  } catch {
    /* ignore */
  }
}

// Entry point for the `lock` subcommand. action is "acquire" or "release".
// Always returns without throwing — a hook must never break the session.
export function runLock(action) {
  if (action !== "acquire" && action !== "release") {
    process.stderr.write("claude-memory-sync lock: usage: lock acquire|release\n");
    return;
  }
  try {
    const mem = memoryPath();
    if (!isLink(mem)) return; // only operate on a set-up symlink
    const cloudDir = resolveLinkTarget(mem);
    if (!cloudDir) return;
    if (!fs.existsSync(cloudDir) || !fs.statSync(cloudDir).isDirectory()) return;
    // Must be writable for the lock to mean anything.
    try {
      fs.accessSync(cloudDir, fs.constants.W_OK);
    } catch {
      return;
    }
    if (action === "acquire") acquire(cloudDir);
    else release(cloudDir);
  } catch {
    // Whatever happens, never break the user's session.
  }
}
