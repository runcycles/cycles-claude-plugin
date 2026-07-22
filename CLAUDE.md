## Git Rules — STRICT
- ALWAYS use native git for ALL commits and pushes
- NEVER use mcp__github__ tools for committing or pushing
- Use mcp__github__ ONLY for: PRs, Issues, GitHub Actions
- Write commit messages to a temp file, then: `git commit -F <file>`
- NEVER use --no-gpg-sign flag

# Cycles strict rules
- yaml API specs always the authority (wire format is hand-built here — verify field names against cycles-protocol-v0.yaml)
- always update AUDIT.md when making changes
- maintain at least 95% or higher test coverage (enforced by vitest.config.js thresholds)

# This repo
Claude Code plugin (hooks + bundled MCP server). Plain ESM JavaScript, zero
runtime dependencies — keep it that way; the auditable-in-one-sitting size is
a feature. There is NO build or typecheck step.

- Install: `npm install`
- Test: `npm test`
- Coverage (thresholds enforced): `npm run test:coverage`
- Lint: `npm run lint`

Hook contract facts (from code.claude.com/docs): PreToolUse deny =
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`
on exit 0; hooks run synchronously in tool dispatch — every network call MUST
carry a timeout; PreToolUse/PostToolUse share no process — state goes through
hooks/lib/state.mjs (one file per reservation, atomic per-key).
