# Cycles Budget Guard — Claude Code plugin

**Hard budget enforcement for Claude Code tool calls.** The [Cycles MCP server](https://github.com/runcycles/cycles-mcp-server) gives agents budget *tools*; this plugin puts Cycles in the **dispatch path**: every tool call is gated by a `PreToolUse` hook that reserves budget first, and a Cycles DENY blocks the call at the harness layer — the model cannot skip it. This closes the cooperative-enforcement gap documented in the MCP server's [Security Model](https://github.com/runcycles/cycles-mcp-server#security-model--enforcement-boundary).

## What it does

- **PreToolUse** — reserves a flat per-call cost before each tool call. DENY (or budget exhaustion) blocks the call with a reason the model sees. Retry-stable idempotency keys are derived from the session/prompt/tool-call identity, so transport retries never double-reserve — this is the layer that *can* hold a key stable, unlike a stateless MCP server.
- **PostToolUse** — commits the reservation, and injects a low-budget warning into the model's context when any scope drops under 15% remaining.
- **SessionEnd** — releases any reservations left dangling by crashes or interrupts.
- **Bundled MCP server** — the full `@runcycles/mcp-server` toolset (balances, explicit reserves for costly operations, usage events) rides along, so the model can plan around budget while the hooks enforce it.
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
- **Identity & retries**: the idempotency key is a hash of `(session, prompt, tool, arguments)`. A retried identical call replays the same reservation server-side. Known limit: two *deliberately identical* calls in one prompt turn share a reservation — the pair under-counts by one flat cost; it never over-charges.
- **Units**: flat per-call cost is deliberate for v0.1 — tool calls don't carry token counts. Meter LLM spend itself with the Cycles integrations for your model gateway, and use this plugin for action-level authority.

## Privacy

The hooks send only: your configured subject identifiers, the tool *name*, unit and amount, and derived opaque hashes. **Tool arguments, file contents, and prompts are never sent** — the hash of `tool_input` is computed locally and only the digest leaves the machine as part of the idempotency key. Full policy: https://runcycles.io/privacy

## License

Apache-2.0
