// SessionStart: deterministic replay point for executed actions whose commit
// or fallback usage event has not settled. Both operations are idempotent and
// safe to retry from any session under the same routing configuration,
// including the current one on resume.
//
// Deliberately NEVER touches hold records: another session may be alive and
// mid-tool-call, and releasing its hold would let its commit land on
// RESERVATION_FINALIZED and the executed tool go uncharged. Stranded holds
// are already time-bounded — the reservation TTL reclaims them server-side,
// and the owning session's own SessionEnd releases them sooner.

import { loadConfig, isConfigured, routingKey } from "./lib/config.mjs";
import { allSessions, pendingRecords, clearStateIfEmpty } from "./lib/state.mjs";
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

  for (const sessionId of allSessions(rk)) {
    for (const [key, record] of pendingRecords(rk, sessionId)) {
      if (record.type === "hold") continue; // unresolved tool outcome belongs to its session + TTL
      try {
        await settleExecutedRecord(config, rk, sessionId, key, record);
      } catch (err) {
        process.stderr.write(`cycles-plugin: session-start executed-action recovery failed for ${sessionId}/${key}: ${err.message}\n`);
      }
    }
    clearStateIfEmpty(rk, sessionId);
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
