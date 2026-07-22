// Plugin configuration, entirely from environment variables so it works
// identically under Claude Code's hook runner and in tests.

import { createHash } from "node:crypto";

const SUBJECT_FIELDS = ["tenant", "workspace", "app", "workflow", "agent", "toolset"];

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

export function loadConfig(env = process.env) {
  const baseUrl = (env.CYCLES_BASE_URL ?? "").replace(/\/+$/, "");
  const subject = {};
  for (const field of SUBJECT_FIELDS) {
    const value = env[`CYCLES_DEFAULT_${field.toUpperCase()}`];
    if (value !== undefined && value !== "") {
      if (value.trim() === "" || value.length > 128) {
        throw new Error(`Invalid CYCLES_DEFAULT_${field.toUpperCase()}: must be 1-128 characters and not whitespace-only.`);
      }
      subject[field] = value;
    }
  }
  const cost = Number.parseInt(env.CYCLES_CC_COST ?? "1", 10);
  return {
    baseUrl,
    apiKey: env.CYCLES_API_KEY ?? "",
    subject,
    // Enforcement is skipped for tools matching this pattern. Default skips
    // local zero-cost read-only tools — gating them adds an HTTP round trip
    // per file read and pollutes the budget signal with non-actions. The
    // cycles MCP tools are ALWAYS skipped regardless (recursion guard in the
    // hook). Operators can tighten or loosen via CYCLES_CC_SKIP_TOOLS.
    skipTools: new RegExp(
      env.CYCLES_CC_SKIP_TOOLS ??
        "^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|AskUserQuestion)$",
    ),
    unit: env.CYCLES_CC_UNIT ?? "CREDITS",
    cost: Number.isFinite(cost) && cost > 0 ? cost : 1,
    // Fail-open by default: if the Cycles server is unreachable, allow the
    // tool call and surface a warning. Set CYCLES_CC_FAIL_CLOSED=true to
    // block instead (strict enforcement).
    failClosed: env.CYCLES_CC_FAIL_CLOSED === "true",
    // Reservation TTL must survive permission prompts and long-running
    // tools; expiry before commit means the action ran but usage charging
    // falls back to a usage event. Spec cap is 86400000.
    ttlMs: clampInt(env.CYCLES_CC_TTL_MS, 1_800_000, 1000, 86_400_000),
  };
}

// Non-secret routing identity: state is namespaced by WHERE charges go
// (server + subject + unit), so recovery can only ever replay records that
// were created under an identical routing configuration — never charging a
// different tenant, server, or unit for another project's action.
export function routingKey(config) {
  const material = JSON.stringify([
    config.baseUrl,
    Object.keys(config.subject).sort().map((k) => [k, config.subject[k]]),
    config.unit,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function isConfigured(config) {
  return config.baseUrl !== "" && Object.keys(config.subject).length > 0;
}
