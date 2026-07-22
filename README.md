# Cycles Budget Guard — Claude Code plugin

**Hard budget enforcement for Claude Code tool calls.** The [Cycles MCP server](https://github.com/runcycles/cycles-mcp-server) gives agents budget *tools*; this plugin puts Cycles in the **dispatch path**: gated tool calls are held behind a `PreToolUse` hook that reserves budget first, and a Cycles DENY blocks the call at the harness layer — the model cannot skip it. This closes the cooperative-enforcement gap documented in the MCP server's [Security Model](https://github.com/runcycles/cycles-mcp-server#security-model--enforcement-boundary).

**Enforcement scope, precisely:** all tools are gated EXCEPT (a) the configurable skip list, which defaults to local zero-cost read tools (`Read`/`Glob`/`Grep`/`LS`/`NotebookRead`/`TodoWrite`/`AskUserQuestion`), and (b) the Cycles budget tools themselves, matched by exact namespace (recursion guard). Set `CYCLES_CC_SKIP_TOOLS=^$` to gate literally everything.

## What it does

- **PreToolUse** — reserves a flat per-call cost before each gated tool call. Any authoritative Cycles rejection — DENY, budget exhausted/frozen/closed, debt, auth failure, invalid request — blocks the call with a reason the model sees; fail-open applies ONLY to outages (5xx/network/timeout). `ALLOW_WITH_CAPS` tool allow/denylists are enforced (violating calls are blocked and the hold returned); other caps are surfaced to the transcript. Idempotency keys derive from `tool_use_id` (unique per call), so transport retries never double-reserve — this is the layer that *can* hold a key stable, unlike a stateless MCP server.
- **PostToolUse** (success) — commits the reservation; if it expired mid-run (long tool, permission prompt), usage is still charged via a fallback event. Injects a low-budget warning into the model's context under 15% remaining.
- **PostToolUseFailure** — releases the hold when the tool call failed: failed attempts return budget instead of charging it.
- **SessionEnd** — releases anything left dangling by crashes or interrupts (state survives failed settlements so this always has the full picture).
- **Companion MCP server** — the `@runcycles/mcp-server` toolset (balances, explicit reserves, usage events), **pinned to an exact version** and fetched via npx on first run (not vendored into this repo).
- **`/cycles-budget-guard:budget`** — one-command budget status report.

## Install

```
/plugin marketplace add runcycles/cycles-claude-plugin
/plugin install cycles-budget-guard@runcycles
```

Then set the environment (same variables as the MCP server):

```bash
export CYCLES_BASE_URL=https://your-cycles-server
export CYCLES_API_KEY=your-key
export CYCLES_DEFAULT_TENANT=acme        # required for enforcement — defines whose budget is charged
export CYCLES_DEFAULT_APP=claude-code    # optional, finer attribution
```

If `CYCLES_BASE_URL` or a subject default is missing, the plugin stays dormant (normal Claude Code permission flow) — it never half-enforces. An *invalid* value fails loudly by blocking calls with a config error.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CYCLES_CC_UNIT` | `CREDITS` | Unit charged per tool call |
| `CYCLES_CC_COST` | `1` | Flat cost reserved+committed per tool call |
| `CYCLES_CC_SKIP_TOOLS` | `^(Read\|Glob\|Grep\|LS\|NotebookRead\|TodoWrite\|AskUserQuestion)$` | Regex of tool names never gated (default: local zero-cost reads) |
| `CYCLES_CC_FAIL_CLOSED` | `false` | `true` blocks tool calls when the Cycles server is unreachable |

Cycles' own budget tools are never gated (recursion guard), regardless of `CYCLES_CC_SKIP_TOOLS`.

## Semantics worth knowing

- **Bounded latency**: every Cycles request carries a 4-second deadline, so a black-holed server can never hang tool dispatch.
- **Fail-open by default**: an unreachable (or timed-out) Cycles server allows the call and logs a warning. Enterprises wanting strict enforcement set `CYCLES_CC_FAIL_CLOSED=true`.
- **Identity & retries**: the idempotency key is derived from `tool_use_id` — unique per tool call, stable across transport retries, so retries replay the same reservation and distinct identical calls are charged separately. On Claude Code versions that predate `tool_use_id`, a content-hash fallback applies; under the fallback, identical calls sharing session/prompt/tool/arguments collide and under-count (never over-charge).
- **Units**: flat per-call cost is deliberate for v0.1 — tool calls don't carry token counts. Meter LLM spend itself with the Cycles integrations for your model gateway, and use this plugin for action-level authority.

## Privacy

The hooks send only: your configured subject identifiers, the tool *name*, unit and amount, and derived opaque hashes. **Tool arguments, file contents, and prompts are never sent** — the hash of `tool_input` is computed locally and only the digest leaves the machine as part of the idempotency key. Full policy: https://runcycles.io/privacy

## License

Apache-2.0
