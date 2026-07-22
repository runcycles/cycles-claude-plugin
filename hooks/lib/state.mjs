// Per-session reservation state shared between PreToolUse and PostToolUse
// (separate processes). ONE FILE PER RESERVATION, named by the identity key:
// Claude Code runs tool calls in parallel, so a single JSON file with
// read-modify-write would lose reservations under concurrency; per-key files
// make remember (write) and take (read+unlink) independently atomic.
// Server-side TTL reclaims anything a crashed session leaves behind.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sessionDir(sessionId) {
  return join(tmpdir(), "cycles-claude-plugin", sanitize(sessionId));
}

export function rememberReservation(sessionId, key, reservationId) {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sanitize(key)), String(reservationId));
}

// Read WITHOUT deleting: the record must survive a failed commit so that
// SessionEnd can still release (or a retried Post hook can settle) the hold.
export function peekReservation(sessionId, key) {
  try {
    return readFileSync(join(sessionDir(sessionId), sanitize(key)), "utf8");
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

export function pendingReservations(sessionId) {
  const dir = sessionDir(sessionId);
  try {
    return readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]);
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
