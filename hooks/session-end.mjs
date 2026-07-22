// SessionEnd: settle whatever the per-call hooks could not. Unresolved holds
// are released; records for successfully executed actions retry commit or an
// idempotent fallback usage event. Server-side TTL reclaims any hold this
// misses, while executed-action records survive until charging is confirmed.

import { loadConfig, isConfigured, routingKey } from "./lib/config.mjs";
import { release, TERMINAL_RESERVATION_CODES } from "./lib/cycles-client.mjs";
import { pendingRecords, deleteReservation, clearStateIfEmpty } from "./lib/state.mjs";
import { settleExecutedRecord } from "./lib/settlement.mjs";

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
      if (record.type === "hold") {
        await release(config, {
          reservationId: record.reservationId,
          idempotencyKey: `${key}_sr`,
          reason: "claude-code session ended",
        });
        deleteReservation(rk, input.session_id, key);
      } else {
        await settleExecutedRecord(config, rk, input.session_id, key, record);
      }
    } catch (err) {
      if (record.type === "hold" && TERMINAL_RESERVATION_CODES.has(err?.errorCode)) {
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
