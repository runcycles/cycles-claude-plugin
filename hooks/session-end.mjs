// SessionEnd: settle whatever the per-call hooks could not — release open
// holds, apply pending usage events (actions that ran but whose expired-
// reservation charge has not been applied yet). Server-side TTL reclaims any
// hold this misses; pending events are retried here because nothing else
// will charge them.

import { loadConfig, isConfigured, routingKey } from "./lib/config.mjs";
import { release, createEvent, TERMINAL_RESERVATION_CODES } from "./lib/cycles-client.mjs";
import { pendingRecords, deleteReservation, clearStateIfEmpty } from "./lib/state.mjs";

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return;
  }
  if (!isConfigured(config)) return;
  const rk = routingKey(config);

  for (const [key, record] of pendingRecords(rk, input.session_id)) {
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
          reason: "claude-code session ended",
        });
      }
      deleteReservation(rk, input.session_id, key);
    } catch (err) {
      if (record.type !== "event" && TERMINAL_RESERVATION_CODES.has(err?.errorCode)) {
        // Hold definitively gone server-side — nothing left to free. Other
        // 4xx (auth, idempotency) are correctable: keep the record.
        deleteReservation(rk, input.session_id, key);
        continue;
      }
      process.stderr.write(`cycles-plugin: session-end settlement failed for ${key}: ${err.message}
`);
    }
  }
  clearStateIfEmpty(rk, input.session_id);
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
    process.stderr.write(`cycles-plugin: ${err?.message ?? err}
`);
  }
}
/* v8 ignore stop */
