---
description: Diagnose Cycles Budget Guard configuration and connectivity without revealing secrets
---

Diagnose this plugin's effective enforcement posture. Never print, echo, return, or summarize the value of `CYCLES_API_KEY` or any other credential.

1. Use Bash to run exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"`. Do not run `env`, `printenv`, `set`, or any command that enumerates unrelated environment variables.
2. If Bash is blocked by the PreToolUse gate, treat the denial reason as diagnostic evidence and continue. Never weaken the gate or add a skip-list exemption for this command.
3. Call the `cycles_check_balance` tool from the pinned companion Cycles MCP server with no arguments. This verifies server reachability, authentication, and the configured default subject without exposing credentials.
4. Report a concise table covering: active/dormant/invalid status, Node.js version, base URL configuration, configured subject fields, unit, per-call cost, fail-open/fail-closed posture, reservation TTL, skipped-tool pattern, companion connectivity, and current balance.
5. If dormant or invalid, name the exact missing or invalid variable and link the remedy to the plugin README. If the MCP call fails, distinguish configuration/authentication failures from server unavailability when the error permits it.
