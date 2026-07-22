// PostToolUse (fires on tool SUCCESS): commit the reservation made in
// PreToolUse. State is only deleted once the hold is actually settled —
// a transient commit failure keeps the record so SessionEnd can release it.
// If the reservation expired mid-run (long tool / permission prompt), the
// action still executed, so usage is charged via a fallback event.

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { commit, createEvent } from "./lib/cycles-client.mjs";
import { toolCallKey } from "./lib/identity.mjs";
import { peekRecord, deleteReservation, writeRecord } from "./lib/state.mjs";
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
  const record = peekRecord(input.session_id, key);
  if (!record) return; // reserve was denied, failed open, or dry

  if (record.type === "event") {
    // A previous settlement attempt already downgraded this to a pending
    // usage event — retry applying it.
    try {
      await createEvent(config, { idempotencyKey: `${key}_e`, toolName: record.toolName, amount: record.amount });
      deleteReservation(input.session_id, key);
    } catch (err) {
      process.stderr.write(`cycles-plugin: pending usage event retry failed: ${err.message}\n`);
    }
    return;
  }

  try {
    const result = await commit(config, {
      reservationId: record.reservationId,
      idempotencyKey: `${key}_c`,
      amount: config.cost,
    });
    deleteReservation(input.session_id, key);
    const hint = lowBudgetHint(result.balances);
    if (hint) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }),
      );
    }
  } catch (err) {
    if (err?.errorCode === "RESERVATION_EXPIRED") {
      // The hold lapsed but the tool DID run — the usage MUST be charged.
      // Durably downgrade the record to a pending event FIRST, so a failed
      // event application is retried (post replay or session end) instead of
      // the charge being lost forever.
      writeRecord(input.session_id, key, { type: "event", toolName, amount: config.cost });
      try {
        await createEvent(config, { idempotencyKey: `${key}_e`, toolName, amount: config.cost });
        deleteReservation(input.session_id, key);
      } catch (eventErr) {
        process.stderr.write(`cycles-plugin: expired-reservation event fallback failed (kept pending): ${eventErr.message}\n`);
      }
      return;
    }
    if (err?.errorCode === "RESERVATION_FINALIZED") {
      // Already settled (e.g. a replayed hook) — nothing left to hold.
      deleteReservation(input.session_id, key);
      return;
    }
    // Transient or malformed: keep the record so SessionEnd settles it.
    process.stderr.write(`cycles-plugin: commit failed for ${record.reservationId} (will settle at session end): ${err.message}\n`);
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
