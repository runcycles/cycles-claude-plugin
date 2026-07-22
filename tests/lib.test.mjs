import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, isConfigured } from "../hooks/lib/config.mjs";
import { reserve, commit, release } from "../hooks/lib/cycles-client.mjs";
import {
  rememberReservation,
  writeRecord,
  peekRecord,
  deleteReservation,
  pendingRecords,
  clearState,
} from "../hooks/lib/state.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadConfig", () => {
  it("reads base config with defaults", () => {
    const c = loadConfig({ CYCLES_BASE_URL: "https://x/", CYCLES_API_KEY: "k", CYCLES_DEFAULT_TENANT: "t" });
    expect(c.baseUrl).toBe("https://x");
    expect(c.subject).toEqual({ tenant: "t" });
    expect(c.unit).toBe("CREDITS");
    expect(c.cost).toBe(1);
    expect(c.failClosed).toBe(false);
    expect(isConfigured(c)).toBe(true);
  });

  it("is unconfigured without base url or subject", () => {
    expect(isConfigured(loadConfig({}))).toBe(false);
    expect(isConfigured(loadConfig({ CYCLES_BASE_URL: "https://x" }))).toBe(false);
  });

  it("rejects invalid subject defaults", () => {
    expect(() => loadConfig({ CYCLES_DEFAULT_TENANT: "   " })).toThrow("CYCLES_DEFAULT_TENANT");
    expect(() => loadConfig({ CYCLES_DEFAULT_APP: "x".repeat(129) })).toThrow("CYCLES_DEFAULT_APP");
    expect(() => loadConfig({ CYCLES_DEFAULT_TENANT: "acme/prod" })).toThrow("CYCLES_DEFAULT_TENANT");
  });

  it("rejects invalid or unsafe base URLs", () => {
    for (const value of [
      "cycles.local",
      "ftp://cycles.local",
      "http://cycles.local",
      "https://user:pass@cycles.local",
      "https://cycles.local/?x=1",
      "https://cycles.local/?",
      "https://cycles.local/#",
      " https://cycles.local",
    ]) {
      expect(() => loadConfig({ CYCLES_BASE_URL: value }), value).toThrow("CYCLES_BASE_URL");
    }
    for (const value of ["http://localhost:8080", "http://127.0.0.2:8080", "http://[::1]:8080"]) {
      expect(loadConfig({ CYCLES_BASE_URL: value }).baseUrl, value).toBe(value);
    }
    expect(loadConfig({ CYCLES_BASE_URL: "HTTPS://CYCLES.LOCAL:443/" }).baseUrl).toBe("https://cycles.local");
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

  it("rejects ambiguous or out-of-range enforcement settings", () => {
    for (const value of ["banana", "1oops", "1.5", "-3", "0"]) {
      expect(() => loadConfig({ CYCLES_CC_COST: value }), value).toThrow("CYCLES_CC_COST");
    }
    expect(() => loadConfig({ CYCLES_CC_TTL_MS: "999" })).toThrow("CYCLES_CC_TTL_MS");
    expect(() => loadConfig({ CYCLES_CC_TTL_MS: "1000oops" })).toThrow("CYCLES_CC_TTL_MS");
    expect(() => loadConfig({ CYCLES_CC_UNIT: "DOLLARS" })).toThrow("CYCLES_CC_UNIT");
    expect(() => loadConfig({ CYCLES_CC_SKIP_TOOLS: "[" })).toThrow("CYCLES_CC_SKIP_TOOLS");
    expect(() => loadConfig({ CYCLES_CC_FAIL_CLOSED: "yes" })).toThrow("CYCLES_CC_FAIL_CLOSED");
    expect(loadConfig({ CYCLES_CC_FAIL_CLOSED: "TRUE" }).failClosed).toBe(true);
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
    expect(init.redirect).toBe("manual");
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
    mockFetch(200, { status: "RELEASED" });
    await release(config, { reservationId: "rsv_2", idempotencyKey: "k3", reason: "skipped" });
  });

  it("rejects settlement responses that do not confirm the expected status", async () => {
    mockFetch(200, { status: "PENDING" });
    await expect(commit(config, { reservationId: "r", idempotencyKey: "k", amount: 1 })).rejects.toMatchObject({
      errorCode: "MALFORMED_RESPONSE",
      malformed: true,
    });
    mockFetch(200, {});
    await expect(release(config, { reservationId: "r", idempotencyKey: "k" })).rejects.toMatchObject({
      malformed: true,
    });
  });

  it("marks malformed reserve responses with the malformed flag", async () => {
    mockFetch(200, { decision: "ALLOW" });
    await expect(reserve(config, { idempotencyKey: "k", toolName: "B", amount: 1 })).rejects.toMatchObject({
      errorCode: "MALFORMED_RESPONSE",
      malformed: true,
    });
  });

  it("treats a null success body as malformed instead of an outage", async () => {
    mockFetch(200, null);
    await expect(reserve(config, { idempotencyKey: "k", toolName: "B", amount: 1 })).rejects.toMatchObject({
      errorCode: "MALFORMED_RESPONSE",
      malformed: true,
    });
  });

  it("tolerates non-JSON error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error("nope")) }));
    await expect(reserve(config, { idempotencyKey: "k", toolName: "B", amount: 1 })).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe("state", () => {
  const RK = "rk-test";
  const session = `test-${process.pid}-${Math.random().toString(36).slice(2)}`;

  it("round-trips typed records", () => {
    rememberReservation(RK, session, "tu_1", "rsv_1");
    writeRecord(RK, session, "tu_2", { type: "event", toolName: "Bash", amount: 3 });
    expect(pendingRecords(RK, session)).toHaveLength(2);
    expect(peekRecord(RK, session, "tu_1")).toEqual({ type: "hold", reservationId: "rsv_1" });
    expect(peekRecord(RK, session, "tu_1")).toBeDefined(); // peek does not consume
    writeRecord(RK, session, "tu_1", { type: "commit", reservationId: "rsv_1", toolName: "Bash", amount: 1 });
    expect(peekRecord(RK, session, "tu_1")).toMatchObject({ type: "commit", amount: 1 });
    deleteReservation(RK, session, "tu_1");
    expect(peekRecord(RK, session, "tu_1")).toBeUndefined();
    expect(pendingRecords(RK, session)).toEqual([["tu_2", { type: "event", toolName: "Bash", amount: 3 }]]);
    clearState(RK, session);
    expect(pendingRecords(RK, session)).toEqual([]);
  });

  it("skips corrupt record files", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const userScope = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "user";
    const dir = join(tmpdir(), `cycles-claude-plugin-${userScope}`, RK, session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "corrupt"), "not json{");
    rememberReservation(RK, session, "tu_ok", "rsv_ok");
    const records = pendingRecords(RK, session);
    expect(records).toHaveLength(1);
    expect(records[0][0]).toBe("tu_ok");
    clearState(RK, session);
  });

  it("ignores interrupted atomic-write temp files during recovery", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const userScope = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "user";
    const dir = join(tmpdir(), `cycles-claude-plugin-${userScope}`, RK, session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".tu_interrupted.123.uuid.tmp"), JSON.stringify({ type: "event", toolName: "Bash", amount: 99 }));
    rememberReservation(RK, session, "tu_real", "rsv_real");
    expect(pendingRecords(RK, session)).toEqual([["tu_real", { type: "hold", reservationId: "rsv_real" }]]);
    clearState(RK, session);
  });

  it("sanitizes hostile session ids", () => {
    const hostile = "../../etc/passwd";
    rememberReservation(RK, hostile, "tu", "rsv");
    expect(peekRecord(RK, hostile, "tu")).toEqual({ type: "hold", reservationId: "rsv" });
    clearState(RK, hostile);
  });
});
