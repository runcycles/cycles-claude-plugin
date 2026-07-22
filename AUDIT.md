# Cycles Budget Guard (Claude Code plugin) — Audit

**Date:** 2026-07-22
**Spec:** `cycles-protocol-v0.yaml` (wire format hand-implemented, zero-dependency)
**Plugin:** `cycles-budget-guard` v0.1.0 (Claude Code hooks: PreToolUse / PostToolUse / SessionEnd + bundled `@runcycles/mcp-server`)

## Design decisions

- **Dispatch-path enforcement:** PreToolUse reserves before every tool call and emits `permissionDecision: "deny"` on Cycles DENY / `BUDGET_EXCEEDED` — enforcement the model cannot skip, closing the cooperative gap documented in the MCP server's security model.
- **Retry-stable idempotency keys, at the correct layer:** keys are `cc_<sha256(session_id, prompt_id, tool_name, tool_input)[:32]>`. This is the design that was evaluated and deliberately REJECTED for the stateless MCP server (see cycles-mcp-server AUDIT, Agent Ergonomics section): only a layer with a stable per-call identity can generate keys safely. Hooks have one. PostToolUse recomputes the identical key for commit pairing (`_c` suffix; SessionEnd releases use `_r`). Documented limit: two identical calls in one prompt turn collide (single shared reservation — under-counts one flat cost, never over-charges).
- **Wire conformance:** requests hand-built per spec (snake_case: `idempotency_key`, `ttl_ms`, `estimate {unit, amount}`, `X-Cycles-API-Key` auth); responses read tolerantly (`reservation_id`, `reason_code`, `scope_path`). Zero runtime dependencies — the whole enforcement surface is ~200 lines of auditable code.
- **Fail-open default, fail-closed option:** unreachable server ⇒ allow + stderr warning (availability over enforcement, the OpenClaw guard's precedent); `CYCLES_CC_FAIL_CLOSED=true` inverts. INVALID config (bad `CYCLES_DEFAULT_*`) always fails closed with a named error — misconfiguration must not silently disable enforcement. UNconfigured (no base URL/subject) is dormant by design.
- **Recursion guard:** tool names matching `/cycles/i` are never gated (the bundled MCP server's tools would otherwise recurse through the hook), plus operator `CYCLES_CC_SKIP_TOOLS`.
- **Privacy:** only subject identifiers, tool NAME, unit/amount, and local hash digests leave the machine. `tool_input` is hashed locally for identity and never transmitted.
- **State:** per-session JSON in the OS temp dir maps identity-key → reservation_id across hook processes; session ids are sanitized for path safety; SessionEnd releases pending holds and clears the file; server-side TTL (300s) is the backstop for crashes.

## Verification (2026-07-22)

28 tests, 99.08% line coverage (enforcement paths: ALLOW/DENY/409/fail-open/fail-closed/misconfig-deny; recursion and skip guards; commit pairing and key stability; low-budget additionalContext; session-end release incl. failure tolerance; hostile session-id sanitization; wire-format assertions against the spec's field names). Process-level entry blocks excluded from coverage and exercised by an end-to-end stdin run.

---

## Self-Review Round 1 (2026-07-22) — four findings, all fixed

1. **No fetch deadline (serious):** hooks run synchronously in tool dispatch; a black-holed server would have hung every tool call until the hook runner's timeout. All requests now carry `AbortSignal.timeout(4000)`; fail-open/closed semantics apply to timeouts like any other failure. Asserted in tests.
2. **Broken MCP env passthrough (serious):** `plugin.json` mapped env via `"${CYCLES_BASE_URL}"`-style placeholders, but Claude Code substitutes only the `CLAUDE_*` plugin variables and `user_config` — the bundled MCP server would have received literal `${...}` strings. The env block is removed; the spawned server inherits the process environment, which is where these variables already live.
3. **State race under parallel tool calls:** Claude Code runs tools concurrently; the single-JSON read-modify-write could lose a reservation (orphaned until session end). State is now one file per reservation key — remember (write) and take (read+unlink) are independently atomic. Semantics and tests unchanged.
4. **Default gating of local reads:** charging `Read`/`Glob`/`Grep`/`LS`/`NotebookRead` added an HTTP round trip per file read and polluted the budget signal with non-actions. Default skip list expanded (operators can tighten via `CYCLES_CC_SKIP_TOOLS`); `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, and `Task` remain gated. Asserted in tests.

**Accepted and documented, not changed:** another plugin's `updatedInput` mutating a tool call between Pre and Post changes the identity hash — the reservation is then released at SessionEnd rather than committed (never double-charged). Session state files for crashed sessions accumulate as empty dirs in the OS temp dir; the OS temp cleaner and server-side TTL both bound the impact.
