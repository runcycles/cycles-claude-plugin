# Cycles Budget Guard — Claude Code plugin

[![CI](https://github.com/runcycles/cycles-claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/runcycles/cycles-claude-plugin/actions/workflows/ci.yml)
[![Plugin v0.2.0](https://img.shields.io/badge/plugin-v0.2.0-7c3aed)](CHANGELOG.md)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Hard budget enforcement for Claude Code tool calls.** The [Cycles MCP server](https://github.com/runcycles/cycles-mcp-server) gives agents budget *tools*; this plugin puts Cycles in the **dispatch path**: gated tool calls are held behind a `PreToolUse` hook that reserves budget first, and a Cycles DENY blocks the call at the harness layer — the model cannot skip it. This closes the cooperative-enforcement gap documented in the MCP server's [Security Model](https://github.com/runcycles/cycles-mcp-server#security-model--enforcement-boundary).

**Enforcement scope, precisely:** all tools are gated EXCEPT (a) the configurable skip list, which defaults to local zero-cost read tools (`Read`/`Glob`/`Grep`/`LS`/`NotebookRead`/`TodoWrite`/`AskUserQuestion`), and (b) the Cycles budget tools themselves, matched by exact namespace (recursion guard). Set `CYCLES_CC_SKIP_TOOLS=^$` to gate literally everything.

Built for teams that need enforceable AI-agent budgets, auditable action-level cost control, and a clear runtime authority boundary around Claude Code automation.

## How enforcement works

```mermaid
flowchart LR
    A[Claude requests a tool] --> B[PreToolUse gate]
    B -->|reserve cost| C[Cycles budget authority]
    C -->|ALLOW / ALLOW_WITH_CAPS| D[Tool executes]
    C -->|DENY or authoritative error| E[Tool is blocked]
    D -->|success| F[Commit reservation]
    D -->|failure| G[Release reservation]
    F --> H[Session recovery retries unsettled usage]
    G --> H
```

The model never decides whether the gate runs. Claude Code invokes the hook synchronously before dispatch, and only a confirmed reservation lets a gated tool proceed.

## Who it is for

- Platform and security teams governing autonomous Claude Code workflows.
- FinOps and engineering leaders who need tool usage tied to explicit budgets.
- Developers who want an enforcement layer that does not depend on the model voluntarily checking a balance.

## What it does

- **PreToolUse** — reserves a flat per-call cost before each gated tool call. Any authoritative Cycles rejection — DENY, budget exhausted/frozen/closed, debt, auth failure, invalid request — blocks the call with a reason the model sees; malformed protocol or hook inputs also block, while fail-open applies ONLY to outages (5xx/network/timeout). `ALLOW_WITH_CAPS` is validated against the protocol and tool allow/denylists are enforced with allowlist precedence; other caps are surfaced to the transcript. A granted call is denied and its hold returned if durable local settlement state cannot be written. Idempotency keys derive from `tool_use_id` (unique per call), so transport retries never double-reserve.
- **PostToolUse** (success) — durably marks the action as executed, then commits the reservation. Transient failures remain pending commits and are retried; if the reservation expired, disappeared, or was finalized, usage is charged via an idempotent fallback event. Injects a low-budget warning into the model's context under 15% remaining.
- **PostToolUseFailure** — releases the hold when the tool call failed: failed attempts return budget instead of charging it.
- **SessionEnd** — settles anything the per-call hooks could not: releases unresolved holds, retries pending commits, and applies pending usage events. State survives failed settlements.
- **SessionStart** — replays pending commits and usage-event charges from any session with the same server/subject/unit routing identity. It deliberately never releases holds — concurrent sessions are normal, and stranded holds are already time-bounded by the reservation TTL.
- **Companion MCP server** — the `@runcycles/mcp-server` toolset (balances, explicit reserves, usage events), **pinned to an exact version** and fetched via npx on first run (not vendored into this repo).
- **`/cycles-budget-guard:budget`** — one-command budget status report.
- **`/cycles-budget-guard:doctor`** — secret-safe effective-configuration and connectivity diagnostics.

## Five-minute quickstart

Requires Node.js 22 or newer.

1. Add the marketplace and install the plugin:

```text
/plugin marketplace add runcycles/cycles-claude-plugin
/plugin install cycles-budget-guard@runcycles
```

2. Set the environment (the same variables are used by the companion MCP server):

```bash
export CYCLES_BASE_URL=https://your-cycles-server
export CYCLES_API_KEY=your-key
export CYCLES_DEFAULT_TENANT=acme        # required for enforcement — defines whose budget is charged
export CYCLES_DEFAULT_APP=claude-code    # optional, finer attribution
```

If `CYCLES_BASE_URL` or a subject default is missing, the plugin stays dormant (normal Claude Code permission flow) — it never half-enforces. An *invalid* value fails loudly by blocking calls with a config error.

3. Restart Claude Code or run `/reload-plugins`, then run:

```text
/cycles-budget-guard:doctor
/cycles-budget-guard:budget
```

The doctor's local diagnostic step remains subject to the normal gate and may reserve the configured per-call cost. It never adds a bypass or skip-list exemption.

4. Ask Claude Code to run a harmless gated action, such as `printf 'Cycles gate active\n'` with Bash. With available budget, Cycles reserves the configured per-call cost and the command proceeds.

## Prove denial enforcement

1. Use a test tenant with an exhausted, frozen, or closed Cycles budget.
2. Set `CYCLES_CC_SKIP_TOOLS=^$` if you want every tool included in the proof.
3. Ask Claude Code to run `printf 'THIS MUST NOT RUN\n'` with Bash.
4. Confirm Cycles denies the reservation and the command produces no output because the tool never executes.
5. Run `/cycles-budget-guard:budget` to inspect the active budget and routing identity.

For a fail-closed outage check, set `CYCLES_CC_FAIL_CLOSED=true`, point the test configuration at an unreachable Cycles endpoint, and confirm the gated tool call is blocked after the bounded four-second timeout.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CYCLES_CC_UNIT` | `CREDITS` | `USD_MICROCENTS`, `TOKENS`, `CREDITS`, or `RISK_POINTS` |
| `CYCLES_CC_COST` | `1` | Positive integer cost reserved+committed per tool call |
| `CYCLES_CC_SKIP_TOOLS` | `^(Read\|Glob\|Grep\|LS\|NotebookRead\|TodoWrite\|AskUserQuestion)$` | Regex of tool names never gated (default: local zero-cost reads) |
| `CYCLES_CC_FAIL_CLOSED` | `false` | `true` blocks tool calls when the Cycles server is unreachable |
| `CYCLES_CC_TTL_MS` | `1800000` (30 min) | Reservation TTL; must outlive permission prompts and long tool runs |

Cycles' own budget tools are never gated (recursion guard), regardless of `CYCLES_CC_SKIP_TOOLS`.
Once both a base URL and subject setting opt into enforcement, invalid URLs, subjects, units, costs, TTLs, regular expressions, or fail-mode values deny with a named configuration error; they are never treated as outages.

## Semantics worth knowing

- **Bounded latency**: every Cycles request carries a 4-second deadline, so a black-holed server can never hang tool dispatch.
- **Fail-open by default**: an unreachable (or timed-out) Cycles server allows the call and logs a warning. Enterprises wanting strict enforcement set `CYCLES_CC_FAIL_CLOSED=true`.
- **Identity & retries**: the idempotency key is derived from `tool_use_id` — unique per tool call, stable across transport retries, so retries replay the same reservation and distinct identical calls are charged separately. On Claude Code versions that predate `tool_use_id`, a content-hash fallback applies; under the fallback, identical calls sharing session/prompt/tool/arguments collide and under-count (never over-charge).
- **Units**: flat per-call cost is deliberate — tool calls don't carry token counts. Meter LLM spend itself with the Cycles integrations for your model gateway, and use this plugin for action-level authority.

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| Plugin is installed but tools are not gated | Missing base URL or default subject leaves enforcement dormant | Run `/cycles-budget-guard:doctor`; set `CYCLES_BASE_URL` and at least `CYCLES_DEFAULT_TENANT` |
| Companion MCP server does not start | Invalid/missing URL, authentication, or first-run npx download failure | Verify Node.js 22+, network access, URL, and `CYCLES_API_KEY`; then run `/reload-plugins` |
| Every gated action is blocked with a configuration error | A configured value is invalid | Use the named variable in the denial message; the doctor command reports the same strict validation safely |
| Server outage allows tool calls | Default posture is fail-open for transport outages only | Set `CYCLES_CC_FAIL_CLOSED=true` for strict environments |
| Server outage blocks tool calls | Fail-closed mode is active | Restore connectivity or explicitly choose fail-open after reviewing the policy impact |
| Expected tool is not charged | It matches the default or operator skip regex | Inspect `CYCLES_CC_SKIP_TOOLS`; set it to `^$` to gate every tool |
| Plugin update is not visible | Third-party marketplace auto-update is off or the session has not reloaded | Run `/plugin marketplace update runcycles`, run `claude plugin update cycles-budget-guard@runcycles` in the shell, then `/reload-plugins` |

When reporting a problem, include the redacted doctor output plus the plugin, Claude Code, Node.js, and operating-system versions. Never include API keys, prompts, tool arguments, or file contents.

## Privacy

The hooks send only: your configured API credential and subject identifiers, the tool *name*, unit and amount, and derived opaque hashes. **Tool arguments, file contents, and prompts are never sent** — the hash of `tool_input` is computed locally and only the digest leaves the machine as part of the idempotency key. Full policy: https://runcycles.io/privacy

## Resources

- [Cycles for Claude Code](https://runcycles.io/quickstart/mcp-claude-code)
- [Claude and Codex integration guide](https://runcycles.io/how-to/add-cycles-with-claude-or-codex)
- [Security and implementation audit](AUDIT.md)
- [Release history](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Report an issue](https://github.com/runcycles/cycles-claude-plugin/issues)

## License

Apache-2.0
