# Changelog

All notable changes to Cycles Budget Guard are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-07-22

### Added

- Add a secret-safe `/cycles-budget-guard:doctor` command backed by the production configuration parser.
- Add macOS coverage, strict plugin and marketplace validation, package/marketplace metadata consistency enforcement, bounded jobs and local installation smoke testing, and scheduled public-repository validation/installation against the current Claude Code release.
- Keep exact Cycles recovery tools available during invalid plugin configuration while continuing to gate namespace lookalikes.
- Add weekly npm and GitHub Actions dependency updates plus monitoring for newer companion MCP server releases.
- Add an architecture diagram, five-minute quickstart, concrete denial proof, troubleshooting guide, security policy, code ownership, and structured issue forms.

### Security

- Reject HTTP redirects as authoritative responses so `X-Cycles-API-Key` cannot be forwarded and redirects cannot trigger fail-open execution.
- Require HTTPS for non-loopback Cycles endpoints and reject query/fragment-bearing base URLs, including empty delimiters, so credentials and budget decisions cannot be intercepted, altered, or routed to an unintended target.

### Repository operations

- Protect `main` with pull-request, status-check, and conversation-resolution requirements.
- Enable automatic merged-branch deletion and Dependabot security updates.

## [0.1.1] - 2026-07-22

### Security and reliability

- Enforce all authoritative Cycles rejections and malformed-response denials at the `PreToolUse` boundary.
- Preserve settlement state across retries, expired reservations, interrupted writes, concurrent sessions, and routing changes.
- Validate caps, configuration, hook input, settlement responses, and exact Cycles MCP recursion exemptions.
- Pin the companion `@runcycles/mcp-server` to version 0.6.0 and require supported Node.js releases.

### Documentation and metadata

- Align the plugin, marketplace, package, lockfile, README, and audit version at 0.1.1.
- Complete marketplace, package, and repository metadata for search and catalog discovery.
- Add README badges, audience guidance, an enforcement verification flow, canonical resources, and a GitHub social-preview asset.

[0.1.1]: https://github.com/runcycles/cycles-claude-plugin/releases/tag/v0.1.1
[0.2.0]: https://github.com/runcycles/cycles-claude-plugin/releases/tag/v0.2.0
