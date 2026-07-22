// Minimal zero-dependency Cycles protocol client (wire format per
// cycles-protocol-v0.yaml — snake_case fields, X-Cycles-API-Key auth).
// Only the operations the hooks need.

// Hooks run synchronously in the tool-dispatch path — without a deadline, a
// black-holed server would hang every tool call. 4s keeps worst-case latency
// bounded; fail-open/fail-closed semantics then apply as usual.
const REQUEST_TIMEOUT_MS = 4000;

async function post(config, path, body) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cycles-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message ?? `Cycles ${path} failed: HTTP ${res.status}`);
    err.errorCode = json.error ?? "UNKNOWN";
    err.httpStatus = res.status;
    // A 4xx with a protocol error envelope is an AUTHORITATIVE Cycles
    // rejection (budget exhausted/frozen/closed, debt, auth, invalid
    // request) — the server answered and said no. Only 5xx and transport
    // failures are outages eligible for fail-open.
    err.authoritative = res.status < 500;
    throw err;
  }
  return json;
}

// Caps are load-bearing enforcement data: a mistyped field silently dropped
// would BYPASS the cap (tool_denylist: "Bash" is not a missing cap, it is a
// malformed one). Every present field must have the correct shape, and
// ALLOW_WITH_CAPS without a caps object is malformed by definition.
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateCaps(caps) {
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
    throw malformed(`Cycles returned ALLOW_WITH_CAPS with a malformed caps object (${JSON.stringify(caps)})`);
  }
  const checks = [
    ["max_tokens", (v) => typeof v === "number" && Number.isFinite(v)],
    ["max_steps_remaining", (v) => typeof v === "number" && Number.isFinite(v)],
    ["cooldown_ms", (v) => typeof v === "number" && Number.isFinite(v)],
    ["tool_allowlist", isStringArray],
    ["tool_denylist", isStringArray],
  ];
  for (const [field, ok] of checks) {
    if (caps[field] !== undefined && !ok(caps[field])) {
      throw malformed(`Cycles caps field ${field} has the wrong type (${JSON.stringify(caps[field])})`);
    }
  }
  return {
    maxTokens: caps.max_tokens,
    maxStepsRemaining: caps.max_steps_remaining,
    toolAllowlist: caps.tool_allowlist,
    toolDenylist: caps.tool_denylist,
    cooldownMs: caps.cooldown_ms,
  };
}

const VALID_DECISIONS = new Set(["ALLOW", "ALLOW_WITH_CAPS", "DENY"]);

// Only these error codes prove a reservation is definitively gone
// server-side; every other failure (including auth/idempotency 4xx) is
// correctable and settlement records must survive it.
export const TERMINAL_RESERVATION_CODES = new Set([
  "RESERVATION_EXPIRED",
  "RESERVATION_FINALIZED",
  "NOT_FOUND",
]);

// A response we cannot interpret is an INTEGRITY failure, not an outage:
// enforcement must never be granted on a garbled answer. Callers treat
// malformed reserve responses as deny-class; malformed settlement responses
// as retain-state (retry at session end).
function malformed(message) {
  const err = new Error(message);
  err.errorCode = "MALFORMED_RESPONSE";
  err.malformed = true;
  return err;
}

function expectStatus(json, expected, what) {
  if (json?.status !== expected) {
    throw malformed(`Cycles ${what} did not confirm ${expected} (got ${JSON.stringify(json?.status)})`);
  }
  return json;
}

export async function reserve(config, { idempotencyKey, toolName, amount }) {
  const json = await post(config, "/v1/reservations", {
    idempotency_key: idempotencyKey,
    subject: config.subject,
    action: { kind: "tool.call", name: toolName },
    estimate: { unit: config.unit, amount },
    ttl_ms: config.ttlMs,
  });
  // Validate the success response: a malformed 200 must never be treated as
  // an ALLOW (and "undefined" must never become a reservation id).
  if (!VALID_DECISIONS.has(json.decision)) {
    throw malformed(`Cycles returned a malformed reserve response (decision: ${JSON.stringify(json.decision)})`);
  }
  if (json.decision !== "DENY" && (typeof json.reservation_id !== "string" || json.reservation_id === "")) {
    throw malformed("Cycles returned ALLOW without a reservation_id");
  }
  let caps;
  if (json.decision === "ALLOW_WITH_CAPS" || json.caps !== undefined) {
    caps = validateCaps(json.caps);
  }
  return {
    decision: json.decision,
    reservationId: json.reservation_id,
    reasonCode: json.reason_code,
    caps,
  };
}

export async function commit(config, { reservationId, idempotencyKey, amount }) {
  const json = await post(config, `/v1/reservations/${encodeURIComponent(reservationId)}/commit`, {
    idempotency_key: idempotencyKey,
    actual: { unit: config.unit, amount },
  });
  return expectStatus(json, "COMMITTED", "commit");
}

export async function release(config, { reservationId, idempotencyKey, reason }) {
  const json = await post(config, `/v1/reservations/${encodeURIComponent(reservationId)}/release`, {
    idempotency_key: idempotencyKey,
    reason,
  });
  return expectStatus(json, "RELEASED", "release");
}

// Fire-and-forget usage event — the fallback charge when a reservation
// expired before commit (long tool run / permission prompt): the action DID
// execute, so the usage must still be recorded.
export async function createEvent(config, { idempotencyKey, toolName, amount }) {
  const json = await post(config, "/v1/events", {
    idempotency_key: idempotencyKey,
    subject: config.subject,
    action: { kind: "tool.call", name: toolName },
    actual: { unit: config.unit, amount },
  });
  return expectStatus(json, "APPLIED", "event");
}
