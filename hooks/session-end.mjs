// SessionEnd: release any reservations whose PostToolUse never ran (crash,
// interrupt, denied-then-abandoned). Server-side TTL would reclaim them
// anyway; releasing promptly returns the held budget to the pool now.

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { release } from "./lib/cycles-client.mjs";
import { pendingReservations, clearState } from "./lib/state.mjs";

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return;
  }
  if (!isConfigured(config)) return;

  for (const [key, reservationId] of pendingReservations(input.session_id)) {
    try {
      await release(config, {
        reservationId,
        idempotencyKey: `${key}_sr`,
        reason: "claude-code session ended",
      });
    } catch (err) {
      process.stderr.write(`cycles-plugin: release failed for ${reservationId}: ${err.message}\n`);
    }
  }
  clearState(input.session_id);
}

/* v8 ignore start -- process-level entry, covered by integration run */
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
