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

function sessionDir(sessionId) {
  return join(tmpdir(), "cycles-claude-plugin", sanitize(sessionId));
}

// Records are typed: { type: "hold", reservationId } for an open
// reservation, { type: "event", toolName, amount } for an executed action
// whose expired-reservation usage event has not been applied yet. Both must
// survive failed settlements so SessionEnd can finish the job.
export function writeRecord(sessionId, key, record) {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sanitize(key)), JSON.stringify(record));
}

export function rememberReservation(sessionId, key, reservationId) {
  writeRecord(sessionId, key, { type: "hold", reservationId });
}

// Read WITHOUT deleting: the record must survive a failed settlement so that
// SessionEnd can still settle it.
export function peekRecord(sessionId, key) {
  try {
    return JSON.parse(readFileSync(join(sessionDir(sessionId), sanitize(key)), "utf8"));
  } catch {
    return undefined;
  }
}

export function deleteReservation(sessionId, key) {
  try {
    unlinkSync(join(sessionDir(sessionId), sanitize(key)));
  } catch {
    // already gone
  }
}

export function pendingRecords(sessionId) {
  const dir = sessionDir(sessionId);
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

export function clearState(sessionId) {
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// Session-end cleanup must NOT wipe records that failed to settle — only
// remove the directory once everything in it has been handled.
export function clearStateIfEmpty(sessionId) {
  try {
    rmdirSync(sessionDir(sessionId));
  } catch {
    // non-empty or already gone — either is fine
  }
}
