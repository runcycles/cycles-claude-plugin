import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, isConfigured } from "../hooks/lib/config.mjs";
import { reserve, commit, release } from "../hooks/lib/cycles-client.mjs";
import {
  rememberReservation,
  peekReservation,
  deleteReservation,
  pendingReservations,
  clearState,
} from "../hooks/lib/state.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadConfig", () => {
  it("reads base config with defaults", () => {
    const c = loadConfig({ CYCLES_BASE_URL: "http://x/", CYCLES_API_KEY: "k", CYCLES_DEFAULT_TENANT: "t" });
    expect(c.baseUrl).toBe("http://x");
    expect(c.subject).toEqual({ tenant: "t" });
    expect(c.unit).toBe("CREDITS");
    expect(c.cost).toBe(1);
    expect(c.failClosed).toBe(false);
    expect(isConfigured(c)).toBe(true);
  });

  it("is unconfigured without base url or subject", () => {
    expect(isConfigured(loadConfig({}))).toBe(false);
    expect(isConfigured(loadConfig({ CYCLES_BASE_URL: "http://x" }))).toBe(false);
  });

  it("rejects invalid subject defaults", () => {
    expect(() => loadConfig({ CYCLES_DEFAULT_TENANT: "   " })).toThrow("CYCLES_DEFAULT_TENANT");
    expect(() => loadConfig({ CYCLES_DEFAULT_APP: "x".repeat(129) })).toThrow("CYCLES_DEFAULT_APP");
  });

  it("parses cost, fail mode and skip pattern", () => {
    const c = loadConfig({
      CYCLES_CC_COST: "5",
      CYCLES_CC_FAIL_CLOSED: "true",
      CYCLES_CC_SKIP_TOOLS: "^Read$",
      CYCLES_CC_UNIT: "RISK_POINTS",
    });
    expect(c.cost).toBe(5);
    expect(c.failClosed).toBe(true);
    expect(c.unit).toBe("RISK_POINTS");
    expect(c.skipTools.test("Read")).toBe(true);
    expect(c.skipTools.test("Bash")).toBe(false);
  });

  it("default skip list covers local read-only tools but not actions", () => {
    const c = loadConfig({});
    for (const skipped of ["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "AskUserQuestion"]) {
      expect(c.skipTools.test(skipped), skipped).toBe(true);
    }
    for (const gated of ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task"]) {
      expect(c.skipTools.test(gated), gated).toBe(false);
    }
  });

  it("falls back to cost 1 on garbage", () => {
    expect(loadConfig({ CYCLES_CC_COST: "banana" }).cost).toBe(1);
    expect(loadConfig({ CYCLES_CC_COST: "-3" }).cost).toBe(1);
  });
});

describe("cycles-client", () => {
  const config = {
    baseUrl: "http://cycles",
    apiKey: "key1",
    subject: { tenant: "t1" },
    unit: "CREDITS",
    ttlMs: 300000,
  };

  function mockFetch(status, body) {
    const fn = vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("reserve sends spec wire format and maps the response", async () => {
    const fn = mockFetch(200, { decision: "ALLOW", reservation_id: "rsv_1" });
    const r = await reserve(config, { idempotencyKey: "k1", toolName: "Bash", amount: 1 });
    expect(r).toMatchObject({ decision: "ALLOW", reservationId: "rsv_1" });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("http://cycles/v1/reservations");
    expect(init.headers["x-cycles-api-key"]).toBe("key1");
    // dispatch-path deadline: a black-holed server must not hang tool calls
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      idempotency_key: "k1",
      subject: { tenant: "t1" },
      action: { kind: "tool.call", name: "Bash" },
      estimate: { unit: "CREDITS", amount: 1 },
      ttl_ms: 300000,
    });
  });

  it("throws typed errors on protocol failures", async () => {
    mockFetch(409, { error: "BUDGET_EXCEEDED", message: "No budget" });
    await expect(reserve(config, { idempotencyKey: "k", toolName: "Bash", amount: 1 })).rejects.toMatchObject({
      errorCode: "BUDGET_EXCEEDED",
      httpStatus: 409,
    });
  });

  it("commit and release hit the reservation endpoints", async () => {
    const fn = mockFetch(200, { status: "COMMITTED" });
    await commit(config, { reservationId: "rsv 1", idempotencyKey: "k2", amount: 1 });
    expect(fn.mock.calls[0][0]).toBe("http://cycles/v1/reservations/rsv%201/commit");
    await release(config, { reservationId: "rsv_2", idempotencyKey: "k3", reason: "skipped" });
    expect(fn.mock.calls[1][0]).toBe("http://cycles/v1/reservations/rsv_2/release");
    expect(JSON.parse(fn.mock.calls[1][1].body)).toMatchObject({ idempotency_key: "k3", reason: "skipped" });
  });

  it("tolerates non-JSON error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error("nope")) }));
    await expect(reserve(config, { idempotencyKey: "k", toolName: "B", amount: 1 })).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe("state", () => {
  const session = `test-${process.pid}-${Math.random().toString(36).slice(2)}`;

  it("round-trips reservations by tool_use_id", () => {
    rememberReservation(session, "tu_1", "rsv_1");
    rememberReservation(session, "tu_2", "rsv_2");
    expect(pendingReservations(session)).toHaveLength(2);
    expect(peekReservation(session, "tu_1")).toBe("rsv_1");
    expect(peekReservation(session, "tu_1")).toBe("rsv_1"); // peek does not consume
    deleteReservation(session, "tu_1");
    expect(peekReservation(session, "tu_1")).toBeUndefined();
    expect(pendingReservations(session)).toEqual([["tu_2", "rsv_2"]]);
    clearState(session);
    expect(pendingReservations(session)).toEqual([]);
  });

  it("sanitizes hostile session ids", () => {
    const hostile = "../../etc/passwd";
    rememberReservation(hostile, "tu", "rsv");
    expect(peekReservation(hostile, "tu")).toBe("rsv");
    clearState(hostile);
  });
});
