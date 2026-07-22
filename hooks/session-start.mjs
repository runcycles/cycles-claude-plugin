// SessionStart: deterministic recovery point for records left behind by
// crashed or never-resumed sessions — without this, a pending usage event
// whose SessionEnd application also failed would remain uncharged forever.
// Sweeps every OTHER session's leftovers: applies pending events, releases
// stranded holds.

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { release, createEvent, TERMINAL_RESERVATION_CODES } from "./lib/cycles-client.mjs";
import { staleSessions, pendingRecords, deleteReservation, clearStateIfEmpty } from "./lib/state.mjs";

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return;
  }
  if (!isConfigured(config)) return;

  for (const staleId of staleSessions(input.session_id)) {
    for (const [key, record] of pendingRecords(staleId)) {
      try {
        if (record.type === "event") {
          await createEvent(config, {
            idempotencyKey: `${key}_e`,
            toolName: record.toolName,
            amount: record.amount,
          });
        } else {
          await release(config, {
            reservationId: record.reservationId,
            idempotencyKey: `${key}_sr`,
            reason: "recovered from a previous claude-code session",
          });
        }
        deleteReservation(staleId, key);
      } catch (err) {
        if (record.type !== "event" && TERMINAL_RESERVATION_CODES.has(err?.errorCode)) {
          deleteReservation(staleId, key);
          continue;
        }
        process.stderr.write(`cycles-plugin: session-start recovery failed for ${staleId}/${key}: ${err.message}\n`);
      }
    }
    clearStateIfEmpty(staleId);
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
