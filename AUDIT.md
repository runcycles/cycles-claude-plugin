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
