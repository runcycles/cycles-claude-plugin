// PostToolUse (fires on tool SUCCESS): commit the reservation made in
// PreToolUse. State is only deleted once the hold is actually settled —
// a transient commit failure becomes a typed pending-commit record that
// SessionEnd/SessionStart retry. If the reservation is gone, the action still
// executed, so usage is charged via an idempotent fallback event.

import { loadConfig, isConfigured, routingKey } from "./lib/config.mjs";
import { toolCallKey } from "./lib/identity.mjs";
import { peekRecord, writeRecord } from "./lib/state.mjs";
import { settleExecutedRecord } from "./lib/settlement.mjs";
import { CYCLES_TOOL_NS } from "./pre-tool-use.mjs";

const LOW_BUDGET_THRESHOLD = 0.15;

export function lowBudgetHint(balances) {
  if (!Array.isArray(balances)) return undefined;
  for (const b of balances) {
    const remaining = b?.remaining?.amount;
    const allocated = b?.allocated?.amount;
    if (typeof remaining === "number" && typeof allocated === "number" && allocated > 0 && remaining / allocated < LOW_BUDGET_THRESHOLD) {
      const pct = Math.max(0, Math.round((remaining / allocated) * 100));
      return `Cycles budget is low: ~${pct}% remaining on ${String(b.scope_path ?? "scope")}. Prefer cheaper approaches, skip optional work, and avoid retries.`;
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
  if (CYCLES_TOOL_NS.test(toolName) || config.skipTools.test(toolName)) return;

  const key = toolCallKey(input);
  const rk = routingKey(config);
  const record = peekRecord(rk, input.session_id, key);
  if (!record) return; // reserve was denied, failed open, or dry

  // The tool has succeeded. Persist that fact BEFORE settlement so SessionEnd
  // and SessionStart retry commit/event rather than releasing the hold.
  const executed = record.type === "hold"
    ? { type: "commit", reservationId: record.reservationId, toolName, amount: config.cost }
    : record;
  if (record.type === "hold") {
    try {
      writeRecord(rk, input.session_id, key, executed);
    } catch (err) {
      // The action already ran, so settlement must still be attempted now.
      // Atomic writes preserve the old hold record if replacement failed.
      process.stderr.write(`cycles-plugin: could not persist pending commit for ${record.reservationId}: ${err.message}\n`);
    }
  }

  try {
    const settled = await settleExecutedRecord(config, rk, input.session_id, key, executed);
    const hint = settled.kind === "commit" ? lowBudgetHint(settled.result.balances) : undefined;
    if (hint) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }),
      );
    }
  } catch (err) {
    const stateDetail = err?.stateError ? `; state persistence also failed: ${err.stateError.message}` : "";
    process.stderr.write(`cycles-plugin: executed-action settlement failed for ${executed.reservationId ?? key} (kept pending): ${err.message}${stateDetail}\n`);
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
