// PreToolUse: reserve budget before the tool call executes. DENY from the
// Cycles server blocks the call at the dispatch layer — the model cannot
// skip it. This is the non-bypassable enforcement the MCP server alone
// cannot provide (see the server README's Security Model section).

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { reserve } from "./lib/cycles-client.mjs";
import { toolCallKey } from "./lib/identity.mjs";
import { rememberReservation } from "./lib/state.mjs";

function output(decision, reason) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
  };
  if (reason !== undefined) hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

export async function run(input, env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    // Bad operator config on an otherwise-configured plugin: fail loudly
    // rather than silently unenforced. With no base URL at all the plugin
    // would be dormant anyway — a stray bad default must not block a setup
    // that never opted into enforcement.
    if (!env.CYCLES_BASE_URL) return;
    output("deny", `Cycles plugin misconfigured: ${err.message}`);
    return;
  }

  if (!isConfigured(config)) return; // not set up — normal permission flow
  const toolName = String(input.tool_name ?? "");
  // Never gate the Cycles budget tools themselves (recursion guard), nor
  // operator-excluded tools.
  if (/cycles/i.test(toolName) || config.skipTools.test(toolName)) return;

  const key = toolCallKey(input);
  try {
    const result = await reserve(config, {
      idempotencyKey: key,
      toolName,
      amount: config.cost,
    });
    if (result.decision === "DENY") {
      output(
        "deny",
        `Cycles budget DENIED for ${toolName} (${result.reasonCode ?? "policy"}). Do not retry this operation; check budget with the cycles balance tool, degrade to a cheaper approach, or stop.`,
      );
      return;
    }
    rememberReservation(input.session_id, key, result.reservationId);
    // ALLOW / ALLOW_WITH_CAPS: let the normal permission flow continue.
  } catch (err) {
    if (err?.errorCode === "BUDGET_EXCEEDED") {
      output(
        "deny",
        `Cycles budget EXHAUSTED for ${toolName}. Do not retry; reduce scope or stop and report the budget limit.`,
      );
      return;
    }
    if (config.failClosed) {
      output("deny", `Cycles server unreachable and CYCLES_CC_FAIL_CLOSED=true: ${err.message}`);
      return;
    }
    process.stderr.write(`cycles-plugin: reserve failed (allowing, fail-open): ${err.message}\n`);
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
