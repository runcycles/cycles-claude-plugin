// Settlement for records whose tool action already executed successfully.
// These records must NEVER be released: retry commit while the reservation
// exists, then fall back to an idempotent usage event once it is gone.

import { commit, createEvent } from "./cycles-client.mjs";
import { writeRecord, deleteReservation } from "./state.mjs";

// A retry with the same commit idempotency key replays a successful commit.
// Receiving one of these instead therefore means this client can no longer
// commit the hold; charge the already-executed action through an event.
const EVENT_FALLBACK_CODES = new Set([
  "RESERVATION_EXPIRED",
  "RESERVATION_FINALIZED",
  "NOT_FOUND",
]);

async function applyEvent(config, routingKey, sessionId, key, record) {
  const result = await createEvent(config, {
    idempotencyKey: `${key}_e`,
    toolName: record.toolName,
    amount: record.amount,
  });
  deleteReservation(routingKey, sessionId, key);
  return { kind: "event", result };
}

export async function settleExecutedRecord(config, routingKey, sessionId, key, record) {
  if (record.type === "event") {
    return applyEvent(config, routingKey, sessionId, key, record);
  }
  if (record.type !== "commit") {
    throw new Error(`Cannot settle executed record of type ${JSON.stringify(record.type)}`);
  }

  try {
    const result = await commit(config, {
      reservationId: record.reservationId,
      idempotencyKey: `${key}_c`,
      amount: record.amount,
    });
    deleteReservation(routingKey, sessionId, key);
    return { kind: "commit", result };
  } catch (err) {
    if (!EVENT_FALLBACK_CODES.has(err?.errorCode)) throw err;

    const eventRecord = { type: "event", toolName: record.toolName, amount: record.amount };
    let stateError;
    try {
      // Persist the downgrade before the network call. If event application
      // fails, SessionEnd/SessionStart can retry without releasing a charge
      // for work that already ran.
      writeRecord(routingKey, sessionId, key, eventRecord);
    } catch (writeErr) {
      // Still attempt the event now. Atomic record writes leave the previous
      // commit record intact, so a later recovery point can retry if needed.
      stateError = writeErr;
    }
    try {
      return await applyEvent(config, routingKey, sessionId, key, eventRecord);
    } catch (eventErr) {
      if (stateError) eventErr.stateError = stateError;
      throw eventErr;
    }
  }
}
