// SessionStart: deterministic replay point for PENDING USAGE EVENTS —
// charges for actions that already executed but whose event application
// failed. Events are idempotent and safe to apply from any session,
// including the current one on resume.
//
// Deliberately NEVER touches hold records: another session may be alive and
// mid-tool-call, and releasing its hold would let its commit land on
// RESERVATION_FINALIZED and the executed tool go uncharged. Stranded holds
// are already time-bounded — the reservation TTL reclaims them server-side,
// and the owning session's own SessionEnd releases them sooner.

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { createEvent } from "./lib/cycles-client.mjs";
import { allSessions, pendingRecords, deleteReservation, clearStateIfEmpty } from "./lib/state.mjs";

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return;
  }
  if (!isConfigured(config)) return;

  for (const sessionId of allSessions()) {
    for (const [key, record] of pendingRecords(sessionId)) {
      if (record.type !== "event") continue; // holds belong to their session + TTL
      try {
        await createEvent(config, {
          idempotencyKey: `${key}_e`,
          toolName: record.toolName,
          amount: record.amount,
        });
        deleteReservation(sessionId, key);
      } catch (err) {
        process.stderr.write(`cycles-plugin: session-start event recovery failed for ${sessionId}/${key}: ${err.message}\n`);
      }
    }
    clearStateIfEmpty(sessionId);
  }
}

/* v8 ignore start -- process-level entry, covered by tests/e2e.test.mjs */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const raw = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
  try {
    await run(JSON.parse(raw));
  } catch (err) {
    process.stderr.write(`cycles-plugin: ${err?.message ?? err}\n`);
  }
}
/* v8 ignore stop */
