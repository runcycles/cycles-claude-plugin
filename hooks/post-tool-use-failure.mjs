// PostToolUseFailure (fires when a tool call FAILS): the operation did not
// complete, so the hold is RELEASED rather than committed — failed attempts
// return budget to the pool instead of charging it.

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { release, TERMINAL_RESERVATION_CODES } from "./lib/cycles-client.mjs";
import { toolCallKey } from "./lib/identity.mjs";
import { peekRecord, deleteReservation } from "./lib/state.mjs";
import { CYCLES_TOOL_NS } from "./pre-tool-use.mjs";

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return;
  }
  if (!isConfigured(config)) return;
  const toolName = String(input.tool_name ?? "");
  if (CYCLES_TOOL_NS.test(toolName) || config.skipTools.test(toolName)) return;

  const key = toolCallKey(input);
  const record = peekRecord(input.session_id, key);
  if (!record) return;
  if (record.type === "event") return; // pending charge for an executed action — session end applies it

  try {
    await release(config, {
      reservationId: record.reservationId,
      idempotencyKey: `${key}_r`,
      reason: "tool call failed",
    });
    deleteReservation(input.session_id, key);
  } catch (err) {
    if (TERMINAL_RESERVATION_CODES.has(err?.errorCode)) {
      deleteReservation(input.session_id, key);
      return;
    }
    process.stderr.write(`cycles-plugin: release failed for ${record.reservationId} (will retry at session end): ${err.message}\n`);
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
