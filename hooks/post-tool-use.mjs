#!/usr/bin/env node
// PostToolUse: commit the reservation made in PreToolUse. Recomputes the
// same identity key from the same stable fields, looks up the reservation,
// and commits the flat cost. Surfaces low-budget pressure to the model via
// additionalContext.

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { commit } from "./lib/cycles-client.mjs";
import { toolCallKey } from "./lib/identity.mjs";
import { takeReservation } from "./lib/state.mjs";

const LOW_BUDGET_THRESHOLD = 0.15;

export function lowBudgetHint(balances) {
  if (!Array.isArray(balances)) return undefined;
  for (const b of balances) {
    const remaining = b?.remaining?.amount;
    const allocated = b?.allocated?.amount;
    if (typeof remaining === "number" && typeof allocated === "number" && allocated > 0 && remaining / allocated < LOW_BUDGET_THRESHOLD) {
      const pct = Math.max(0, Math.round((remaining / allocated) * 100));
      return `Cycles budget is low: ~${pct}% remaining on ${String(b.scope_path ?? b.scopePath ?? "scope")}. Prefer cheaper approaches, skip optional work, and avoid retries.`;
    }
  }
  return undefined;
}

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return; // pre-hook already surfaced the config error
  }
  if (!isConfigured(config)) return;
  const toolName = String(input.tool_name ?? "");
  if (/cycles/i.test(toolName) || config.skipTools.test(toolName)) return;

  const key = toolCallKey(input);
  const reservationId = takeReservation(input.session_id, key);
  if (!reservationId) return; // reserve was denied, failed open, or dry

  try {
    const result = await commit(config, {
      reservationId,
      idempotencyKey: `${key}_c`,
      amount: config.cost,
    });
    const hint = lowBudgetHint(result.balances);
    if (hint) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }),
      );
    }
  } catch (err) {
    process.stderr.write(`cycles-plugin: commit failed for ${reservationId}: ${err.message}\n`);
  }
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
