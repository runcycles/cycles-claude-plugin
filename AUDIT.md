# Cycles Budget Guard (Claude Code plugin) — Audit

**Last full revision:** 2026-07-22 (after external enforcement review rounds 1–7)
**Spec:** [`cycles-protocol-v0.yaml`](https://github.com/runcycles/cycles-protocol/blob/main/cycles-protocol-v0.yaml) (wire format hand-implemented, zero-dependency; reference docs at https://runcycles.io/protocol)
**Plugin:** `cycles-budget-guard` v0.1.0 — hooks: PreToolUse / PostToolUse / PostToolUseFailure / SessionEnd / SessionStart + companion `@runcycles/mcp-server` (pinned `@0.6.0`, fetched via npx — not vendored)

## Current design (authoritative — supersedes anything below that contradicts it)

- **Dispatch-path enforcement:** PreToolUse reserves before every GATED tool call and denies on: server DENY; any authoritative 4xx protocol rejection (exhausted/frozen/closed budgets, debt, auth, invalid request); any MALFORMED response (unknown decision, ALLOW without reservation_id, mistyped caps fields) — integrity failures never grant execution. Fail-open (allow + warning) applies ONLY to outages: 5xx, network errors, and the 4s request timeout; `CYCLES_CC_FAIL_CLOSED=true` denies on outages too.
- **Enforcement scope:** all tools EXCEPT the operator skip list (default: local zero-cost reads — `Read|Glob|Grep|LS|NotebookRead|TodoWrite|AskUserQuestion`; set `CYCLES_CC_SKIP_TOOLS=^$` to gate everything) and the Cycles budget tools themselves, matched by exact namespace (`^mcp__(plugin_cycles-budget-guard_)?cycles__` — lookalikes like `mcp__bicycles__*` are gated).
- **Caps:** ALLOW_WITH_CAPS requires a closed-schema caps object: integer/non-negative numeric fields, ≤256-character list entries, no unknown fields, and no caps on other decisions. `tool_allowlist`/`tool_denylist` are enforced at the gate with the protocol's allowlist precedence. Violations are malformed → deny; any plausible hold is released or recorded. Remaining caps are surfaced via `hookSpecificOutput.additionalContext` without altering the user permission flow.
- **Identity:** keys are `cc_<sha256(session_id | tool_use_id)[:32]>` — `tool_use_id` is the documented per-call unique id, so distinct identical calls charge separately and transport retries replay. Content-hash fallback exists only for Claude Code versions predating `tool_use_id` (collision limit documented there).
- **Settlement lifecycle:** state is atomically replaced and typed by lifecycle: `hold` before outcome, `commit` once the action succeeded, and `event` once a gone reservation requires fallback charging. Successful tools are NEVER released after a failed commit: Post, SessionEnd, and SessionStart retry commit, then create an idempotent event on EXPIRED/FINALIZED/NOT_FOUND. Tool failure releases only `hold` records. State is deleted only after a confirmed `COMMITTED`, `RELEASED`, or `APPLIED` response (or a terminal release result for an unexecuted hold).
- **Routing-scoped state:** per-user temporary state lives under a non-secret routing hash of (base URL, subject, unit), so recovery can only see records created by the same OS user under an IDENTICAL routing configuration.
- **Replay points:** replayed Post hooks, SessionEnd, and SessionStart retry `commit`/`event` records; SessionStart never releases `hold` records because another session may be mid-call. Stranded unresolved holds are time-bounded by TTL. Reserve-time validation failures carrying a plausible reservation id are released immediately or recorded for retry.
- **TTL:** configurable `CYCLES_CC_TTL_MS` (default 30 min, validated 1s–24h) — chosen to outlive permission prompts and long tool runs.
- **Failure posture:** unconfigured (no base URL or no subject setting) = dormant; once both are present, every invalid enforcement setting is a loud deny naming the variable; outages = fail-open by default. Once a reservation is granted, inability to persist settlement state denies and returns the hold rather than falling through to fail-open.
- **Privacy:** only the configured API credential, subject identifiers, tool NAMEs, unit/amount, and local hash digests leave the machine; `tool_input` is hashed locally and never transmitted.
- **Zero runtime dependencies** by policy; every network call carries a 4s deadline; LF enforced repo-wide (`.gitattributes`).

## Current verification (2026-07-22)

73 tests across unit + checked-in e2e (real hook processes against a live HTTP server); coverage thresholds ENFORCED in vitest.config.js and verified with bare exit codes: statements ≥95, lines ≥95, functions ≥95, branches ≥85. CI: Node 22/24 × ubuntu/windows.

## History (appended review rounds; superseded statements above)

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

---

## Enforcement Review Round 4 (2026-07-22) — two findings, both accepted

1. **P1 — SessionStart could release a CONCURRENT session's live hold** (introduced by round 3's recovery hook): two simultaneous Claude Code sessions are normal; session B's sweep released session A's mid-call hold, and A's commit then hit RESERVATION_FINALIZED — treated as settled with no usage event, so the executed tool went uncharged. Fixed exactly per the review's prescription: SessionStart now replays EVENT records only (idempotent, safe from any session, including the current one on resume) and never touches hold records — those are owned by their session's SessionEnd and time-bounded by the server TTL. Tests assert the concurrent hold is untouched.
2. **P2 — malformed-caps responses stranded the server-side hold**: caps validation threw after the server had already created the reservation, and the deny path had no id to clean up. The client now carries `reservationId` on post-hold validation errors; PreToolUse releases it (or records it for session-end retry if the release fails). Both paths tested.

---

## Enforcement Review Round 5 (2026-07-22) — three findings, all accepted

1. **P1 — cross-config event replay could charge the wrong tenant/server/unit:** pending-event records carried no routing context, and SessionStart replayed them with the CURRENT session's configuration — on a machine with two projects pointing at different Cycles servers or subjects, project B would charge ITS budget for project A's action and delete A's recovery record. Fixed by namespacing ALL state under a non-secret routing hash (base URL + sorted subject + unit): records made under a different routing configuration are invisible to recovery by construction. Isolation test: a different server/tenant config sees nothing and touches nothing.
2. **P2 — unknown-decision responses stranded their hold:** the reservation id was carried only on caps-validation errors; `{decision:"MAYBE", reservation_id:"..."}` threw without it. Every post-success validation error now carries any plausible reservation id; PreToolUse releases it or records it on release failure. Both paths tested.
3. **P3 — stale docs:** head revision line, spec link (protocol repo + reference docs), test counts, and the PR description refreshed.

---

## Enforcement Review Round 6 (2026-07-22) — enforcement lifecycle and protocol conformance

1. **P1 — successful actions were released after transient commit failures:** Post retained a generic hold, then SessionEnd released it, so executed work went uncharged. State now transitions to `commit` before settlement; Post, SessionEnd, and SessionStart retry it, with a durable event fallback once the reservation is gone.
2. **P1 — local state failure fell through to fail-open:** if reserve succeeded but the state write failed, the generic outage handler allowed execution without a commit path. PreToolUse now releases the hold and denies; denied-call cleanup remains deny even if both release and local persistence fail. State writes use atomic replacement and per-user temp roots.
3. **P1 — caps contradicted the protocol:** denylist was checked before an authoritative non-empty allowlist; floats, negatives, long strings, unknown fields, and caps on ALLOW were accepted. Validation and precedence now match the authoritative YAML.
4. **P2 — operator settings were parsed permissively:** partial integers and mistyped fail-closed values could silently weaken enforcement. Base URL, subject charset, unit, cost, TTL, skip regex, and fail mode are now strictly validated with named deny messages.
5. **P2 — finalized/missing reservations after successful execution were discarded:** Post deleted state without recording usage. Stable commit retries now fall back to an idempotent event for EXPIRED, FINALIZED, and NOT_FOUND.

---

## Enforcement Review Round 7 (2026-07-22) — recovery and integration edges

1. **P1 — interrupted atomic writes could be replayed as usage:** a crash after writing the temporary JSON but before rename left a dot-prefixed temp file that recovery treated as a real record with a new idempotency key. Recovery now ignores atomic-write temp files.
2. **P1 — a JSON `null` reserve response failed open:** dereferencing the body threw an untyped exception, so a malformed success response was mistaken for an outage. Non-object success bodies are now explicit malformed-response denials.
3. **P2 — URL validation and use could diverge:** the WHATWG parser accepted canonicalizable spellings while requests retained the raw spelling. Base URLs are now whitespace-strict and use the parser's canonical representation.
4. **P2 — hook commands used shell form despite path placeholders:** all handlers now use Claude Code's documented exec form (`command` + `args`), avoiding shell parsing across platforms and install paths.
5. **P3 — CI/action and privacy wording:** the pinned `setup-node` SHA is v7.0.0 (the stale v6 comment is corrected), and the privacy inventory now explicitly includes the configured API credential.
