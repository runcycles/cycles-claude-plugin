// Plugin configuration, entirely from environment variables so it works
// identically under Claude Code's hook runner and in tests.

import { createHash } from "node:crypto";
import { URL } from "node:url";

const SUBJECT_FIELDS = ["tenant", "workspace", "app", "workflow", "agent", "toolset"];
const UNITS = new Set(["USD_MICROCENTS", "TOKENS", "CREDITS", "RISK_POINTS"]);

function boundedInt(raw, fallback, min, max, variable) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${variable}: must be an integer from ${min} to ${max}.`);
  }
  return n;
}

function normalizeBaseUrl(raw) {
  const rawValue = raw ?? "";
  if (rawValue !== rawValue.trim()) {
    throw new Error("Invalid CYCLES_BASE_URL: must not contain surrounding whitespace.");
  }
  const value = rawValue.replace(/\/+$/, "");
  if (value === "") return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid CYCLES_BASE_URL: must be an absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid CYCLES_BASE_URL: must be an absolute HTTP(S) URL without credentials, query, or fragment.");
  }
  // Return the URL parser's canonical representation. URL accepts a few
  // equivalent spellings (for example uppercase schemes); retaining the raw
  // spelling could make fetch target a different path than the one validated.
  return parsed.href.replace(/\/+$/, "");
}

export function loadConfig(env = process.env) {
  const baseUrl = normalizeBaseUrl(env.CYCLES_BASE_URL);
  const subject = {};
  for (const field of SUBJECT_FIELDS) {
    const value = env[`CYCLES_DEFAULT_${field.toUpperCase()}`];
    if (value !== undefined && value !== "") {
      if (value.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
        throw new Error(`Invalid CYCLES_DEFAULT_${field.toUpperCase()}: must be 1-128 characters matching [a-zA-Z0-9_.-]+.`);
      }
      subject[field] = value;
    }
  }
  const unit = env.CYCLES_CC_UNIT ?? "CREDITS";
  if (!UNITS.has(unit)) {
    throw new Error(`Invalid CYCLES_CC_UNIT: must be one of ${[...UNITS].join(", ")}.`);
  }
  const cost = boundedInt(env.CYCLES_CC_COST, 1, 1, Number.MAX_SAFE_INTEGER, "CYCLES_CC_COST");
  let skipTools;
  try {
    skipTools = new RegExp(
      env.CYCLES_CC_SKIP_TOOLS ??
        "^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|AskUserQuestion)$",
    );
  } catch {
    throw new Error("Invalid CYCLES_CC_SKIP_TOOLS: must be a valid regular expression.");
  }
  const failMode = (env.CYCLES_CC_FAIL_CLOSED ?? "false").toLowerCase();
  if (!new Set(["true", "false"]).has(failMode)) {
    throw new Error("Invalid CYCLES_CC_FAIL_CLOSED: must be true or false.");
  }
  return {
    baseUrl,
    apiKey: env.CYCLES_API_KEY ?? "",
    subject,
    // Enforcement is skipped for tools matching this pattern. Default skips
    // local zero-cost read-only tools — gating them adds an HTTP round trip
    // per file read and pollutes the budget signal with non-actions. The
    // cycles MCP tools are ALWAYS skipped regardless (recursion guard in the
    // hook). Operators can tighten or loosen via CYCLES_CC_SKIP_TOOLS.
    skipTools,
    unit,
    cost,
    // Fail-open by default: if the Cycles server is unreachable, allow the
    // tool call and surface a warning. Set CYCLES_CC_FAIL_CLOSED=true to
    // block instead (strict enforcement).
    failClosed: failMode === "true",
    // Reservation TTL must survive permission prompts and long-running
    // tools; expiry before commit means the action ran but usage charging
    // falls back to a usage event. Spec cap is 86400000.
    ttlMs: boundedInt(env.CYCLES_CC_TTL_MS, 1_800_000, 1000, 86_400_000, "CYCLES_CC_TTL_MS"),
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
