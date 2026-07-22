// Per-session reservation state, keyed by tool_use_id. Lives in the OS temp
// dir so PreToolUse and PostToolUse (separate processes) share it, and so a
// crashed session leaves nothing behind but a small JSON file whose
// reservations TTL-expire server-side anyway.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stateDir() {
  return join(tmpdir(), "cycles-claude-plugin");
}

function stateFile(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(stateDir(), `${safe}.json`);
}

export function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return { reservations: {} };
  }
}

export function writeState(sessionId, state) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFile(sessionId), JSON.stringify(state));
}

export function rememberReservation(sessionId, toolUseId, reservationId) {
  const state = readState(sessionId);
  state.reservations[toolUseId] = reservationId;
  writeState(sessionId, state);
}

export function takeReservation(sessionId, toolUseId) {
  const state = readState(sessionId);
  const reservationId = state.reservations[toolUseId];
  if (reservationId !== undefined) {
    delete state.reservations[toolUseId];
    writeState(sessionId, state);
  }
  return reservationId;
}

export function pendingReservations(sessionId) {
  return Object.entries(readState(sessionId).reservations);
}

export function clearState(sessionId) {
  try {
    rmSync(stateFile(sessionId), { force: true });
  } catch {
    // best effort
  }
}
