// PreToolUse: reserve budget before the tool call executes. DENY from the
// Cycles server blocks the call at the dispatch layer — the model cannot
// skip it. This is the non-bypassable enforcement the MCP server alone
// cannot provide (see the server README's Security Model section).

import { loadConfig, isConfigured } from "./lib/config.mjs";
import { reserve, release } from "./lib/cycles-client.mjs";
import { toolCallKey } from "./lib/identity.mjs";
import { rememberReservation } from "./lib/state.mjs";

// Exact namespaces of the Cycles budget tools (recursion guard). Deliberately
// NOT a substring match: `mcp__bicycles__deploy` must be gated like any other
// tool. Covers the plugin-bundled server and a user-configured `cycles` server.
export const CYCLES_TOOL_NS = /^mcp__(plugin_cycles-budget-guard_)?cycles__/;

function output(decision, reason) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
  };
  if (reason !== undefined) hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

function capViolation(caps, toolName) {
  if (!caps) return undefined;
  if (Array.isArray(caps.toolDenylist) && caps.toolDenylist.includes(toolName)) {
    return `tool ${toolName} is on the Cycles tool_denylist`;
  }
  if (Array.isArray(caps.toolAllowlist) && caps.toolAllowlist.length > 0 && !caps.toolAllowlist.includes(toolName)) {
    return `tool ${toolName} is not on the Cycles tool_allowlist`;
  }
  return undefined;
}

function capsSummary(caps) {
  const parts = [];
  if (typeof caps.maxTokens === "number") parts.push(`maxTokens=${caps.maxTokens}`);
  if (typeof caps.maxStepsRemaining === "number") parts.push(`maxStepsRemaining=${caps.maxStepsRemaining}`);
  if (typeof caps.cooldownMs === "number") parts.push(`cooldownMs=${caps.cooldownMs}`);
  return parts.join(", ");
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
  if (CYCLES_TOOL_NS.test(toolName) || config.skipTools.test(toolName)) return;

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
    // ALLOW_WITH_CAPS: enforce tool allow/deny lists here (the one cap this
    // layer can enforce mechanically); surface the rest to the transcript.
    const violation = capViolation(result.caps, toolName);
    if (violation) {
      // Return the hold we just took before blocking the call; if the
      // release fails, RECORD the hold so SessionEnd can retry — a failed
      // best-effort release must not leak budget until TTL.
      try {
        await release(config, {
          reservationId: result.reservationId,
          idempotencyKey: `${key}_r`,
          reason: "denied by caps",
        });
      } catch {
        rememberReservation(input.session_id, key, result.reservationId);
      }
      output("deny", `Cycles caps forbid this call: ${violation}. Respect the caps or choose an allowed tool.`);
      return;
    }
    rememberReservation(input.session_id, key, result.reservationId);
    if (result.decision === "ALLOW_WITH_CAPS" && result.caps) {
      const summary = capsSummary(result.caps);
      if (summary) {
        // additionalContext is the documented channel for informing the
        // model; stderr is not transcript context.
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: `Cycles ALLOW_WITH_CAPS — respect ${summary} while executing.`,
            },
          }),
        );
      }
    }
  } catch (err) {
    // An authoritative protocol rejection (4xx envelope: budget exhausted /
    // frozen / closed, debt, auth failure, invalid request) is the server
    // saying NO — never fail open on it.
    if (err?.authoritative || err?.malformed) {
      // A malformed response can arrive AFTER the server created a hold
      // (e.g. valid reservation_id, garbage caps). Never strand it: try to
      // release, and record it for session-end retry if the release fails.
      if (typeof err.reservationId === "string" && err.reservationId !== "") {
        try {
          await release(config, {
            reservationId: err.reservationId,
            idempotencyKey: `${key}_r`,
            reason: "malformed reserve response",
          });
        } catch {
          rememberReservation(input.session_id, key, err.reservationId);
        }
      }
      output(
        "deny",
        `Cycles rejected ${toolName}: ${err.errorCode} — ${err.message}. Do not retry; resolve the budget/authorization state or stop.`,
      );
      return;
    }
    if (config.failClosed) {
      output("deny", `Cycles server unavailable and CYCLES_CC_FAIL_CLOSED=true: ${err.message}`);
      return;
    }
    process.stderr.write(`cycles-plugin: reserve failed (allowing, fail-open): ${err.message}\n`);
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
