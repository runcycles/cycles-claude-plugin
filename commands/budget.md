---
description: Show current Cycles budget status for this session's subject
---

Check the current Cycles budget and report it concisely.

1. Call the `cycles_check_balance` tool (from the bundled cycles MCP server) with no arguments — the operator-configured `CYCLES_DEFAULT_*` subject fills the filter.
2. Report, for each returned balance scope: remaining vs allocated (as a percentage), reserved, and spent.
3. If any scope is under 20% remaining, lead with a warning and suggest concrete economies (cheaper model, fewer retries, skipping optional work).
4. If the call fails because no subject default is configured, tell the user to set `CYCLES_DEFAULT_TENANT` (and optionally `CYCLES_BASE_URL`/`CYCLES_API_KEY`) in their environment.
