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

---

## Self-Review Round 2 — full-repo pass (2026-07-22)

**Disproven hypothesis, recorded for honesty:** suspected the entry-point detection would silently fail under install paths containing spaces (percent-encoding in `import.meta.url`). Tested empirically — hooks copied to a spaced directory fire correctly (verified deny output with fail-closed against an unreachable server) because only the space-free basename is compared. No change.

**Fixed:**
1. **Coverage thresholds now enforced** (`vitest.config.js`: 95% lines/functions/statements, 85% branches) — the org's 95% rule was previously aspirational; CI would have passed on any coverage.
2. **Windows CI leg added** — hooks run on end-user machines; path joining, tmpdir state, and process spawning now get exercised on windows-latest × Node 20/22.
3. **CLAUDE.md rewritten** — it was a stale copy from cycles-mcp-server referencing nonexistent build/typecheck scripts; now documents this repo's actual commands, the zero-dependency constraint, and the load-bearing hook-contract facts (deny JSON shape, mandatory network timeouts, cross-process state rules).
4. **Dormancy edge:** an invalid `CYCLES_DEFAULT_*` with NO base URL configured used to deny every tool call — turning a dormant plugin into a total blocker on a machine that never opted into enforcement. Now: no base URL ⇒ dormant regardless; invalid defaults fail loudly only when otherwise configured. Tested both ways.

**Accepted with documentation:** installing the plugin without env config leaves the bundled MCP server failing at startup (CYCLES_BASE_URL is required) until the user completes setup — deliberate; an enforcement product must not silently default to mock mode.

**Windows CI leg pays off immediately:** the new windows-latest matrix caught a real cross-platform bug on its first run — vite's shebang stripping fails when the shebang line ends in CRLF (windows runners check out with `core.autocrlf=true`), so every hook entry file failed to parse under vitest while passing under plain Node. Root-caused by local reproduction with an autocrlf clone and per-module bisection. Fix: shebangs removed (decorative — hooks.json invokes `node <script>` explicitly) and `.gitattributes` forces LF repo-wide, protecting user installs too (plugin installation is a git clone subject to the user's autocrlf).

---

## External Enforcement Review (2026-07-22) — nine findings, all accepted

The review's headline was correct: the repository was not yet entitled to claim reliable hard enforcement. Every finding was verified and addressed.

1. **Authoritative rejections failed open (P1).** Only DENY/BUDGET_EXCEEDED blocked; BUDGET_FROZEN/CLOSED, debt, auth failures, and invalid requests fell into the generic catch and were allowed. Now: any 4xx protocol envelope is authoritative → always deny (fail-open never applies); only 5xx/network/timeout are outages. Malformed 200s (missing/unknown decision, ALLOW without reservation_id) are rejected client-side and can never store a bogus reservation. Tested per error code.
2. **Key collisions (P1).** The identity hash ignored `tool_use_id` (the documented per-call unique id — a second docs pass confirmed the reviewer right and our first research pass incomplete) and leaned on `prompt_id`, which is only available on newer Claude Code — without it, identical calls collided session-wide. Keys now derive from `session_id + tool_use_id`, with the content-hash as explicit fallback for older versions. Tested: distinct identical calls get distinct keys.
3. **ALLOW_WITH_CAPS ignored (P1).** Caps were parsed and discarded. Now: `tool_denylist`/`tool_allowlist` are enforced at the gate (violating call blocked; the just-taken hold released best-effort); `max_tokens`/`max_steps_remaining`/`cooldown_ms` are surfaced to the transcript. Wire snake_case normalized. Tested both list directions.
4. **Settlement incomplete (P1).** (a) `PostToolUseFailure` (a real event, verified against docs) now releases holds for failed tools; (b) state is deleted only after settlement succeeds — transient commit/release failures keep the record for SessionEnd; (c) TTL is configurable (`CYCLES_CC_TTL_MS`, default 30min), and a commit hitting RESERVATION_EXPIRED charges via a fallback usage event — the action ran, so usage is recorded. All tested, including the expiry→event path.
5. **Recursion exemption bypassable (P1).** `/cycles/i` exempted any name containing "cycles" (`mcp__bicycles__deploy`). Now an exact-namespace match on the bundled and standalone Cycles server prefixes; a lookalike-name test pins the behavior.
6. **Unpinned runtime download (P1).** `npx -y @runcycles/mcp-server` executed whatever version npm served. Now pinned to an exact audited version (`@0.6.0`); "bundled" wording corrected to "companion, pinned, fetched via npx".
7. **EOL runtime (P2).** Engines now `>=22`; CI tests 22/24 (Node 20 reached EOL).
8. **Coverage vs contract (P2).** Tests now construct production-shaped inputs (`tool_use_id` present), and cover: every authoritative rejection class, malformed 200s, caps enforcement, failure settlement, transient-failure state retention, expiry event fallback, exact-namespace guard — plus a checked-in end-to-end suite spawning the real hook processes against a live HTTP server (entry blocks are no longer untested). 45 tests; thresholds enforced.
9. **Documentation honesty (P2).** README no longer claims every call is gated (enforcement scope stated precisely, with the skip list and an opt-out to gate everything); the collision claim is rewritten for the tool_use_id reality; "bundled" corrected; this AUDIT reflects current counts and discloses the above.

---

## Enforcement Review Round 2 (2026-07-22) — seven findings, all accepted

1. **CI blocker:** the coverage threshold failure was real and my local check had masked it via a grep pipeline (second occurrence of that verification mistake — checks now run with bare exit codes). Fixed before this round; this round's changes re-verified the same way.
2. **Malformed reserve responses now DENY** in both fail modes: a garbled answer is an integrity failure, not an outage — enforcement is never granted on a response we cannot interpret. README's fail-open scope statement now matches.
3. **Settlement responses are validated**: commit must confirm `COMMITTED`, release `RELEASED`, events `APPLIED` — anything else is malformed, state is retained, and the plugin never believes an unconfirmed settlement happened.
4. **Cap-denial release failures no longer leak**: if returning the just-taken hold fails, the hold is recorded so SessionEnd retries it.
5. **Caps surface via `additionalContext`** on stdout (the documented channel), emitted WITHOUT a permissionDecision so the normal permission flow is untouched; stderr was not transcript context.
6. **Expired-reservation charging is durable**: before attempting the fallback usage event, the record is downgraded to `{type:"event"}` on disk; failed applications are retried by replayed Post hooks and by SessionEnd, which now settles typed records (release holds, apply events) and only removes state that actually settled.
7. **Failure-hook 4xx discrimination**: only `RESERVATION_EXPIRED`/`RESERVATION_FINALIZED`/`NOT_FOUND` are terminal; auth/idempotency/invalid-request errors keep the record for retry.

**Verified:** 53 tests, statements 98.19% / lines 99.5% / branches 88.63% (thresholds enforced, exit codes checked directly), lint clean. New tests: malformed-deny both modes, settlement-status validation, cap-release leak recording, additionalContext without decision, durable pending-event lifecycle including replayed-Post retry and SessionEnd application, corrupt state-file tolerance, correctable-vs-terminal 4xx in the failure hook.
