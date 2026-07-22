import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { run as preToolUse } from "../hooks/pre-tool-use.mjs";
import { run as postToolUse, lowBudgetHint } from "../hooks/post-tool-use.mjs";
import { run as sessionEnd } from "../hooks/session-end.mjs";
import { run as postToolUseFailure } from "../hooks/post-tool-use-failure.mjs";
import { toolCallKey } from "../hooks/lib/identity.mjs";
import { pendingRecords, peekRecord, clearState } from "../hooks/lib/state.mjs";

const ENV = {
  CYCLES_BASE_URL: "http://cycles",
  CYCLES_API_KEY: "k",
  CYCLES_DEFAULT_TENANT: "t1",
};

let session;
let stdout;
let stderr;

let toolUseSeq = 0;

function input(overrides = {}) {
  toolUseSeq += 1;
  return {
    session_id: session,
    prompt_id: "p1",
    tool_use_id: `tooluse_${toolUseSeq}`,
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
  it("keys on tool_use_id: same call stable, distinct identical calls distinct", () => {
    const a = toolCallKey(input({ tool_use_id: "tooluse_A" }));
    expect(toolCallKey(input({ tool_use_id: "tooluse_A" }))).toBe(a);
    // two IDENTICAL calls with different tool_use_ids must NOT collide
    expect(toolCallKey(input({ tool_use_id: "tooluse_B" }))).not.toBe(a);
    expect(a).toMatch(/^cc_[0-9a-f]{32}$/);
  });

  it("falls back to content hash without tool_use_id (older Claude Code)", () => {
    const base = { session_id: "s", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "ls" } };
    const a = toolCallKey(base);
    expect(toolCallKey({ ...base })).toBe(a);
    expect(toolCallKey({ ...base, prompt_id: "p2" })).not.toBe(a);
  });
});

describe("pre-tool-use", () => {
  it("does nothing when unconfigured", async () => {
    await preToolUse(input(), {});
    expect(written()).toBe("");
  });

  it("reserves and remembers on ALLOW", async () => {
    const fn = mockCycles([{ status: 200, body: { decision: "ALLOW", reservation_id: "rsv_1" } }]);
    const call = input({ tool_use_id: "tooluse_allow" });
    await preToolUse(call, ENV);
    expect(written()).toBe("");
    expect(pendingRecords(session)).toEqual([[toolCallKey(call), { type: "hold", reservationId: "rsv_1" }]]);
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.idempotency_key).toBe(toolCallKey(call));
    expect(body.action).toEqual({ kind: "tool.call", name: "Bash" });
  });

  it("denies with reason on DENY", async () => {
    mockCycles([{ status: 200, body: { decision: "DENY", reason_code: "BUDGET_EXHAUSTED" } }]);
    await preToolUse(input(), ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("BUDGET_EXHAUSTED");
    expect(pendingRecords(session)).toEqual([]);
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
    await preToolUse(input({ tool_name: "mcp__cycles__cycles_check_balance" }), ENV);
    await preToolUse(input({ tool_name: "TodoWrite" }), ENV);
    expect(fn).not.toHaveBeenCalled();
    expect(written()).toBe("");
  });

  it("gates lookalike tool names — the exemption is exact, not substring", async () => {
    const fn = mockCycles([{ status: 200, body: { decision: "ALLOW", reservation_id: "rsv_bike" } }]);
    await preToolUse(input({ tool_name: "mcp__bicycles__deploy" }), ENV);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("denies on ANY authoritative 4xx rejection even in fail-open mode", async () => {
    for (const [status, code] of [[409, "BUDGET_FROZEN"], [409, "BUDGET_CLOSED"], [401, "UNAUTHORIZED"], [400, "INVALID_REQUEST"], [409, "DEBT_OUTSTANDING"]]) {
      stdout.mockClear();
      mockCycles([{ status, body: { error: code, message: "no" } }]);
      await preToolUse(input(), ENV);
      const out = JSON.parse(written());
      expect(out.hookSpecificOutput.permissionDecision, code).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason, code).toContain(code);
    }
  });

  it("DENIES on malformed 200s in both fail modes — integrity is not availability", async () => {
    mockCycles([{ status: 200, body: { decision: "ALLOW" } }]);
    await preToolUse(input(), ENV);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(pendingRecords(session)).toEqual([]);

    stdout.mockClear();
    mockCycles([{ status: 200, body: { decision: "MAYBE", reservation_id: "x" } }]);
    await preToolUse(input(), { ...ENV, CYCLES_CC_FAIL_CLOSED: "true" });
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("records the hold when a cap-denial release fails, so session end can retry", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_leak", caps: { tool_denylist: ["Bash"] } } },
      { status: 502, body: {} },
    ]);
    const call = input({ tool_use_id: "tooluse_leak" });
    await preToolUse(call, ENV);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(peekRecord(session, toolCallKey(call))).toEqual({ type: "hold", reservationId: "rsv_leak" });
  });

  it("enforces caps tool_denylist: releases the hold and denies", async () => {
    const fn = mockCycles([
      { status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_cap", caps: { tool_denylist: ["Bash"] } } },
      { status: 200, body: { status: "RELEASED" } },
    ]);
    await preToolUse(input(), ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("tool_denylist");
    expect(fn.mock.calls[1][0]).toContain("/rsv_cap/release");
    expect(pendingRecords(session)).toEqual([]);
  });

  it("enforces caps tool_allowlist and surfaces other caps on stderr", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_al", caps: { tool_allowlist: ["Read"] } } },
      { status: 200, body: { status: "RELEASED" } },
    ]);
    await preToolUse(input(), ENV);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecisionReason).toContain("tool_allowlist");

    stdout.mockClear();
    mockCycles([
      { status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_mt", caps: { max_tokens: 500, cooldown_ms: 1000 } } },
    ]);
    await preToolUse(input({ tool_use_id: "tooluse_caps2" }), ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined(); // decision flow untouched
    expect(out.hookSpecificOutput.additionalContext).toContain("maxTokens=500");
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
    const call = input({ tool_use_id: "tooluse_pair" });
    await preToolUse(call, ENV);
    await postToolUse(call, ENV);
    expect(fn.mock.calls[1][0]).toBe("http://cycles/v1/reservations/rsv_9/commit");
    expect(JSON.parse(fn.mock.calls[1][1].body).idempotency_key).toBe(`${toolCallKey(call)}_c`);
    expect(pendingRecords(session)).toEqual([]);
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
    const lowCall = input({ tool_use_id: "tooluse_low" });
    await preToolUse(lowCall, ENV);
    stdout.mockClear();
    await postToolUse(lowCall, ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.additionalContext).toContain("5%");
    expect(out.hookSpecificOutput.additionalContext).toContain("tenant:t1");
  });

  it("logs but does not throw on commit failure", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_f" } },
      { status: 500, body: { error: "INTERNAL", message: "boom" } },
    ]);
    const failCall = input({ tool_use_id: "tooluse_cfail" });
    await preToolUse(failCall, ENV);
    await postToolUse(failCall, ENV);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("rsv_f"));
    // transient failure keeps the record for session-end release
    expect(pendingRecords(session)).toHaveLength(1);
  });
});

describe("caps validation (malformed caps never bypass)", () => {
  it("denies when ALLOW_WITH_CAPS carries no caps object", async () => {
    mockCycles([{ status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_nc" } }]);
    await preToolUse(input(), ENV);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies when a caps field is mistyped — a string denylist is not a missing cap", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_mc", caps: { tool_denylist: "Bash" } } },
    ]);
    await preToolUse(input(), ENV);
    const out = JSON.parse(written());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("tool_denylist");
    expect(pendingRecords(session)).toEqual([]);

    stdout.mockClear();
    mockCycles([
      { status: 200, body: { decision: "ALLOW_WITH_CAPS", reservation_id: "rsv_mt2", caps: { max_tokens: "500" } } },
    ]);
    await preToolUse(input(), ENV);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("session-start recovery", () => {
  it("sweeps stale sessions: applies pending events, releases holds, keeps correctable failures", async () => {
    const stale = `stale-${Math.random().toString(36).slice(2)}`;
    const { writeRecord, rememberReservation: rem } = await import("../hooks/lib/state.mjs");
    writeRecord(stale, "k_evt", { type: "event", toolName: "Bash", amount: 2 });
    rem(stale, "k_hold", "rsv_stale");
    const fn = mockCycles([
      { status: 200, body: { status: "APPLIED", event_id: "evt_s" } },
      { status: 200, body: { status: "RELEASED" } },
    ]);
    const { run: sessionStart } = await import("../hooks/session-start.mjs");
    await sessionStart({ session_id: session }, ENV);
    const urls = fn.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(["http://cycles/v1/events", "http://cycles/v1/reservations/rsv_stale/release"]);
    expect(pendingRecords(stale)).toEqual([]);

    // correctable failure retains the record for the next replay point
    const stale2 = `stale2-${Math.random().toString(36).slice(2)}`;
    rem(stale2, "k2", "rsv_stale2");
    mockCycles([{ status: 401, body: { error: "UNAUTHORIZED", message: "bad key" } }]);
    await sessionStart({ session_id: session }, ENV);
    expect(pendingRecords(stale2)).toHaveLength(1);
    clearState(stale2);
  });

  it("never touches the current session's records", async () => {
    const { rememberReservation: rem } = await import("../hooks/lib/state.mjs");
    rem(session, "k_mine", "rsv_mine");
    const fn = mockCycles([]);
    const { run: sessionStart } = await import("../hooks/session-start.mjs");
    await sessionStart({ session_id: session }, ENV);
    expect(pendingRecords(session)).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("post-tool-use settlement", () => {
  it("charges via usage event when the reservation expired mid-run", async () => {
    const fn = mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_exp" } },
      { status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } },
      { status: 200, body: { status: "APPLIED", event_id: "evt_1" } },
    ]);
    const call = input({ tool_use_id: "tooluse_exp" });
    await preToolUse(call, ENV);
    await postToolUse(call, ENV);
    expect(fn.mock.calls[2][0]).toBe("http://cycles/v1/events");
    expect(JSON.parse(fn.mock.calls[2][1].body).idempotency_key).toBe(`${toolCallKey(call)}_e`);
    expect(pendingRecords(session)).toEqual([]);
  });

  it("keeps a durable pending-event record when the fallback event fails", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_pend" } },
      { status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } },
      { status: 502, body: {} },
    ]);
    const call = input({ tool_use_id: "tooluse_pend" });
    await preToolUse(call, ENV);
    await postToolUse(call, ENV);
    expect(peekRecord(session, toolCallKey(call))).toEqual({ type: "event", toolName: "Bash", amount: 1 });

    // session end applies the pending event instead of releasing
    const fn2 = mockCycles([{ status: 200, body: { status: "APPLIED", event_id: "evt_p" } }]);
    await sessionEnd({ session_id: session }, ENV);
    expect(fn2.mock.calls[0][0]).toBe("http://cycles/v1/events");
    expect(pendingRecords(session)).toEqual([]);
  });

  it("post retries a pending event record directly (success and failure paths)", async () => {
    // success: pending event applied by a replayed post hook
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_r1" } },
      { status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } },
      { status: 502, body: {} }, // event fails -> durable pending record
      { status: 200, body: { status: "APPLIED", event_id: "evt_r" } }, // replayed post applies it
    ]);
    const call = input({ tool_use_id: "tooluse_replay" });
    await preToolUse(call, ENV);
    await postToolUse(call, ENV);
    expect(peekRecord(session, toolCallKey(call))).toMatchObject({ type: "event" });
    await postToolUse(call, ENV);
    expect(pendingRecords(session)).toEqual([]);

    // failure: retry also fails -> record kept, stderr logged
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_r2" } },
      { status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } },
      { status: 502, body: {} },
      { status: 502, body: {} },
    ]);
    const call2 = input({ tool_use_id: "tooluse_replay2" });
    await preToolUse(call2, ENV);
    await postToolUse(call2, ENV);
    await postToolUse(call2, ENV);
    expect(peekRecord(session, toolCallKey(call2))).toMatchObject({ type: "event" });
  });

  it("post no-ops when unconfigured/misconfigured/exempt", async () => {
    const fn = mockCycles([]);
    await postToolUse(input(), {});
    await postToolUse(input(), { ...ENV, CYCLES_DEFAULT_TENANT: "  " });
    await postToolUse(input({ tool_name: "TodoWrite" }), ENV);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clears state when the reservation was already finalized", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_fin" } },
      { status: 409, body: { error: "RESERVATION_FINALIZED", message: "done" } },
    ]);
    const call = input({ tool_use_id: "tooluse_fin" });
    await preToolUse(call, ENV);
    await postToolUse(call, ENV);
    expect(pendingRecords(session)).toEqual([]);
  });
});

describe("post-tool-use-failure", () => {
  it("no-ops when unconfigured, misconfigured, or tool is exempt", async () => {
    const fn = mockCycles([]);
    await postToolUseFailure(input(), {});
    await postToolUseFailure(input(), { ...ENV, CYCLES_DEFAULT_TENANT: "   " });
    await postToolUseFailure(input({ tool_name: "mcp__cycles__cycles_reserve" }), ENV);
    await postToolUseFailure(input({ tool_name: "TodoWrite" }), ENV);
    await postToolUseFailure(input(), ENV); // configured but nothing reserved
    expect(fn).not.toHaveBeenCalled();
    expect(written()).toBe("");
  });

  it("releases the hold when the tool call failed", async () => {
    const fn = mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_tf" } },
      { status: 200, body: { status: "RELEASED" } },
    ]);
    const call = input({ tool_use_id: "tooluse_tf" });
    await preToolUse(call, ENV);
    await postToolUseFailure(call, ENV);
    expect(fn.mock.calls[1][0]).toBe("http://cycles/v1/reservations/rsv_tf/release");
    expect(JSON.parse(fn.mock.calls[1][1].body).reason).toBe("tool call failed");
    expect(pendingRecords(session)).toEqual([]);
  });

  it("keeps the record on transient AND correctable-4xx failures, clears only on terminal codes", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_tr" } },
      { status: 502, body: {} },
    ]);
    const call = input({ tool_use_id: "tooluse_tr" });
    await preToolUse(call, ENV);
    await postToolUseFailure(call, ENV);
    expect(pendingRecords(session)).toHaveLength(1);

    // auth failure is 4xx but CORRECTABLE — the record must survive
    mockCycles([{ status: 401, body: { error: "UNAUTHORIZED", message: "bad key" } }]);
    await postToolUseFailure(call, ENV);
    expect(pendingRecords(session)).toHaveLength(1);

    // terminal: the hold is definitively gone server-side
    mockCycles([{ status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } }]);
    await postToolUseFailure(call, ENV);
    expect(pendingRecords(session)).toEqual([]);
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
    expect(pendingRecords(session)).toEqual([]);
  });

  it("clears expired holds and retains records on transient failures", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_x" } },
      { status: 410, body: { error: "RESERVATION_EXPIRED", message: "gone" } },
    ]);
    const call = input({ tool_use_id: "tooluse_se1" });
    await preToolUse(call, ENV);
    await sessionEnd({ session_id: session }, ENV);
    expect(pendingRecords(session)).toEqual([]);

    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_y" } },
      { status: 502, body: {} },
    ]);
    await preToolUse(input({ tool_use_id: "tooluse_se2" }), ENV);
    await sessionEnd({ session_id: session }, ENV);
    expect(pendingRecords(session)).toHaveLength(1); // transient — kept for TTL story
  });

  it("retains records on correctable 4xx at session end (auth is not terminal)", async () => {
    mockCycles([
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_auth" } },
      { status: 401, body: { error: "UNAUTHORIZED", message: "bad key" } },
    ]);
    await preToolUse(input({ tool_use_id: "tooluse_se3" }), ENV);
    await sessionEnd({ session_id: session }, ENV);
    expect(pendingRecords(session)).toHaveLength(1);
  });

  it("no-ops when unconfigured or misconfigured", async () => {
    const fn = mockCycles([]);
    await sessionEnd({ session_id: session }, {});
    await sessionEnd({ session_id: session }, { ...ENV, CYCLES_DEFAULT_TENANT: "  " });
    expect(fn).not.toHaveBeenCalled();
  });
});
