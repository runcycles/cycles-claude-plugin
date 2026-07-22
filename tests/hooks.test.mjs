import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { run as preToolUse } from "../hooks/pre-tool-use.mjs";
import { run as postToolUse, lowBudgetHint } from "../hooks/post-tool-use.mjs";
import { run as sessionEnd } from "../hooks/session-end.mjs";
import { toolCallKey } from "../hooks/lib/identity.mjs";
import { pendingReservations, clearState } from "../hooks/lib/state.mjs";

const ENV = {
  CYCLES_BASE_URL: "http://cycles",
  CYCLES_API_KEY: "k",
  CYCLES_DEFAULT_TENANT: "t1",
};

let session;
let stdout;
let stderr;

function input(overrides = {}) {
  return {
    session_id: session,
    prompt_id: "p1",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    ...overrides,
  };
}

function written() {
  return stdout.mock.calls.map((c) => c[0]).join("");
}

function mockCycles(responses) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  session = `hooktest-${Math.random().toString(36).slice(2)}`;
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  clearState(session);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("identity", () => {
  it("is stable across pre/post for the same call and distinct across calls", () => {
    const a = toolCallKey(input());
    expect(toolCallKey(input())).toBe(a);
    expect(toolCallKey(input({ tool_input: { command: "rm" } }))).not.toBe(a);
    expect(toolCallKey(input({ prompt_id: "p2" }))).not.toBe(a);
    expect(a).toMatch(/^cc_[0-9a-f]{32}$/);
  });
});

describe("pre-tool-use", () => {
  it("does nothing when unconfigured", async () => {
    await preToolUse(input(), {});
    expect(written()).toBe("");
  });

  it("reserves and remembers on ALLOW", async () => {
    const fn = mockCycles([{ status: 200, body: { decision: "ALLOW", reservation_id: "rsv_1" } }]);
    await preToolUse(input(), ENV);
    expect(written()).toBe("");
    expect(pendingReservations(session)).toEqual([[toolCallKey(input()), "rsv_1"]]);
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.idempotency_key).toBe(toolCallKey(input()));
    expect(body.action).toEqual({ kind: "tool.call", name: "Bash" });
  });

  it("denies with reason on DENY", async () => {
    mockCycles([{ status: 200, body: { decision: "DENY", reason_code: "BUDGET_EXHAUSTED" } }]);
    await preToolUse(input(), ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("BUDGET_EXHAUSTED");
    expect(pendingReservations(session)).toEqual([]);
  });

  it("denies on 409 BUDGET_EXCEEDED", async () => {
    mockCycles([{ status: 409, body: { error: "BUDGET_EXCEEDED", message: "no" } }]);
    await preToolUse(input(), ENV);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("fails open on server errors by default, with stderr warning", async () => {
    mockCycles([{ status: 502, body: {} }]);
    await preToolUse(input(), ENV);
    expect(written()).toBe("");
    expect(stderr).toHaveBeenCalled();
  });

  it("fails closed when configured", async () => {
    mockCycles([{ status: 502, body: {} }]);
    await preToolUse(input(), { ...ENV, CYCLES_CC_FAIL_CLOSED: "true" });
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("never gates cycles tools or skip-listed tools", async () => {
    const fn = mockCycles([]);
    await preToolUse(input({ tool_name: "mcp__plugin_cycles-budget-guard_cycles__cycles_reserve" }), ENV);
    await preToolUse(input({ tool_name: "TodoWrite" }), ENV);
    expect(fn).not.toHaveBeenCalled();
    expect(written()).toBe("");
  });

  it("denies loudly on invalid operator config when otherwise configured", async () => {
    await preToolUse(input(), { ...ENV, CYCLES_DEFAULT_TENANT: "   " });
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("CYCLES_DEFAULT_TENANT");
  });

  it("stays dormant on invalid defaults when no base URL is set", async () => {
    await preToolUse(input(), { CYCLES_DEFAULT_TENANT: "   " });
    expect(written()).toBe("");
  });
});

describe("post-tool-use", () => {
  it("commits the remembered reservation with the paired key", async () => {
    const fn = mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_9" } },
      { status: 200, body: { status: "COMMITTED", charged: { unit: "CREDITS", amount: 1 } } },
    ]);
    await preToolUse(input(), ENV);
    await postToolUse(input(), ENV);
    expect(fn.mock.calls[1][0]).toBe("http://cycles/v1/reservations/rsv_9/commit");
    expect(JSON.parse(fn.mock.calls[1][1].body).idempotency_key).toBe(`${toolCallKey(input())}_c`);
    expect(pendingReservations(session)).toEqual([]);
  });

  it("is a no-op when nothing was reserved", async () => {
    const fn = mockCycles([]);
    await postToolUse(input(), ENV);
    expect(fn).not.toHaveBeenCalled();
  });

  it("emits additionalContext when balance is low", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_l" } },
      {
        status: 200,
        body: {
          status: "COMMITTED",
          balances: [{ scope_path: "tenant:t1", remaining: { amount: 5 }, allocated: { amount: 100 } }],
        },
      },
    ]);
    await preToolUse(input(), ENV);
    stdout.mockClear();
    await postToolUse(input(), ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.additionalContext).toContain("5%");
    expect(out.hookSpecificOutput.additionalContext).toContain("tenant:t1");
  });

  it("logs but does not throw on commit failure", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_f" } },
      { status: 409, body: { error: "RESERVATION_FINALIZED", message: "done" } },
    ]);
    await preToolUse(input(), ENV);
    await postToolUse(input(), ENV);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("rsv_f"));
  });
});

describe("lowBudgetHint", () => {
  it("handles absent/healthy/invalid balances", () => {
    expect(lowBudgetHint(undefined)).toBeUndefined();
    expect(lowBudgetHint([{ remaining: { amount: 80 }, allocated: { amount: 100 } }])).toBeUndefined();
    expect(lowBudgetHint([{ remaining: { amount: "x" }, allocated: { amount: 100 } }])).toBeUndefined();
    expect(lowBudgetHint([{ scope_path: "s", remaining: { amount: -5 }, allocated: { amount: 100 } }])).toContain("0%");
  });
});

describe("session-end", () => {
  it("releases all pending reservations and clears state", async () => {
    const fn = mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_a" } },
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_b" } },
      { status: 200, body: { status: "RELEASED" } },
      { status: 200, body: { status: "RELEASED" } },
    ]);
    await preToolUse(input(), ENV);
    await preToolUse(input({ tool_input: { command: "pwd" } }), ENV);
    await sessionEnd({ session_id: session }, ENV);
    const releaseUrls = fn.mock.calls.slice(2).map((c) => c[0]);
    expect(releaseUrls).toEqual(
      expect.arrayContaining([
        "http://cycles/v1/reservations/rsv_a/release",
        "http://cycles/v1/reservations/rsv_b/release",
      ]),
    );
    expect(pendingReservations(session)).toEqual([]);
  });

  it("survives release failures", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_x" } },
      { status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } },
    ]);
    await preToolUse(input(), ENV);
    await sessionEnd({ session_id: session }, ENV);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("rsv_x"));
    expect(pendingReservations(session)).toEqual([]);
  });

  it("no-ops when unconfigured or misconfigured", async () => {
    const fn = mockCycles([]);
    await sessionEnd({ session_id: session }, {});
    await sessionEnd({ session_id: session }, { ...ENV, CYCLES_DEFAULT_TENANT: "  " });
    expect(fn).not.toHaveBeenCalled();
  });
});
