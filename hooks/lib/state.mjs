// Per-session reservation state shared between PreToolUse and PostToolUse
// (separate processes). ONE FILE PER RESERVATION, named by the identity key:
// Claude Code runs tool calls in parallel, so a single JSON file with
// read-modify-write would lose reservations under concurrency; per-key files
// make remember (write) and take (read+unlink) independently atomic.
// Server-side TTL reclaims anything a crashed session leaves behind.

import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function routingDir(routingKey) {
  return join(tmpdir(), "cycles-claude-plugin", sanitize(routingKey));
}

function sessionDir(routingKey, sessionId) {
  return join(routingDir(routingKey), sanitize(sessionId));
}

// Every session directory with unsettled records UNDER THE SAME ROUTING
// CONFIGURATION — used by SessionStart event recovery. Records made under a
// different server/subject/unit are invisible by construction, so replay can
// never charge the wrong place. Includes the current session (a resumed
// session's pending events should replay too).
export function allSessions(routingKey) {
  try {
    return readdirSync(routingDir(routingKey));
  } catch {
    return [];
  }
}

// Records are typed: { type: "hold", reservationId } for an open
// reservation, { type: "event", toolName, amount } for an executed action
// whose expired-reservation usage event has not been applied yet. Both must
// survive failed settlements so SessionEnd can finish the job.
export function writeRecord(routingKey, sessionId, key, record) {
  const dir = sessionDir(routingKey, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sanitize(key)), JSON.stringify(record));
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
    return readdirSync(dir).map((name) => {
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
