// Per-session reservation state shared between PreToolUse and PostToolUse
// (separate processes). ONE FILE PER RESERVATION, named by the identity key:
// Claude Code runs tool calls in parallel, so a single JSON file with
// read-modify-write would lose reservations under concurrency; per-key files
// isolate concurrent calls. Writes use atomic temp-file replacement.
// Server-side TTL reclaims anything a crashed session leaves behind.

import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function routingDir(routingKey) {
  // os.tmpdir() is shared (/tmp) on many Unix hosts. Scope the root by uid
  // so one local user cannot own/block another user's enforcement state.
  // Windows and macOS already provide per-user temp roots; the fallback is
  // retained there for portability.
  const userScope = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "user";
  return join(tmpdir(), `cycles-claude-plugin-${userScope}`, sanitize(routingKey));
}

function sessionDir(routingKey, sessionId) {
  return join(routingDir(routingKey), sanitize(sessionId));
}

// Every session directory with unsettled records UNDER THE SAME ROUTING
// CONFIGURATION — used by SessionStart settlement recovery. Records made under a
// different server/subject/unit are invisible by construction, so replay can
// never charge the wrong place. Includes the current session (a resumed
// session's pending executed actions should replay too).
export function allSessions(routingKey) {
  try {
    return readdirSync(routingDir(routingKey));
  } catch {
    return [];
  }
}

// Records are typed: hold = outcome not yet known; commit = action succeeded
// and reservation commit is pending; event = action succeeded, reservation
// is gone, and fallback usage-event application is pending. All survive
// failed settlement so later hooks can finish the correct operation.
export function writeRecord(routingKey, sessionId, key, record) {
  const dir = sessionDir(routingKey, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, sanitize(key));
  const temporary = join(dir, `.${sanitize(key)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

export function rememberReservation(routingKey, sessionId, key, reservationId) {
  writeRecord(routingKey, sessionId, key, { type: "hold", reservationId });
}

// Read WITHOUT deleting: the record must survive a failed settlement so that
// SessionEnd can still settle it.
export function peekRecord(routingKey, sessionId, key) {
  try {
    return JSON.parse(readFileSync(join(sessionDir(routingKey, sessionId), sanitize(key)), "utf8"));
  } catch {
    return undefined;
  }
}

export function deleteReservation(routingKey, sessionId, key) {
  try {
    unlinkSync(join(sessionDir(routingKey, sessionId), sanitize(key)));
  } catch {
    // already gone
  }
}

export function pendingRecords(routingKey, sessionId) {
  const dir = sessionDir(routingKey, sessionId);
  try {
    return readdirSync(dir).filter((name) => !name.startsWith(".")).map((name) => {
      try {
        return [name, JSON.parse(readFileSync(join(dir, name), "utf8"))];
      } catch {
        return [name, undefined];
      }
    }).filter(([, record]) => record !== undefined);
  } catch {
    return [];
  }
}

export function clearState(routingKey, sessionId) {
  try {
    rmSync(sessionDir(routingKey, sessionId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// Session-end cleanup must NOT wipe records that failed to settle — only
// remove the directory once everything in it has been handled.
export function clearStateIfEmpty(routingKey, sessionId) {
  try {
    rmdirSync(sessionDir(routingKey, sessionId));
  } catch {
    // non-empty or already gone — either is fine
  }
}
