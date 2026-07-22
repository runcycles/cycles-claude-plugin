// Minimal zero-dependency Cycles protocol client (wire format per
// cycles-protocol-v0.yaml — snake_case fields, X-Cycles-API-Key auth).
// Only the operations the hooks need.

function subjectToWire(subject) {
  return subject;
}

async function post(config, path, body) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cycles-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message ?? `Cycles ${path} failed: HTTP ${res.status}`);
    err.errorCode = json.error ?? "UNKNOWN";
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

export async function reserve(config, { idempotencyKey, toolName, amount }) {
  const body = {
    idempotency_key: idempotencyKey,
    subject: subjectToWire(config.subject),
    action: { kind: "tool.call", name: toolName },
    estimate: { unit: config.unit, amount },
    ttl_ms: config.ttlMs,
  };
  const json = await post(config, "/v1/reservations", body);
  return {
    decision: json.decision,
    reservationId: json.reservation_id,
    reasonCode: json.reason_code,
    caps: json.caps,
  };
}

export async function commit(config, { reservationId, idempotencyKey, amount }) {
  return post(config, `/v1/reservations/${encodeURIComponent(reservationId)}/commit`, {
    idempotency_key: idempotencyKey,
    actual: { unit: config.unit, amount },
  });
}

export async function release(config, { reservationId, idempotencyKey, reason }) {
  return post(config, `/v1/reservations/${encodeURIComponent(reservationId)}/release`, {
    idempotency_key: idempotencyKey,
    reason,
  });
}
