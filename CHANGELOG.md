# Changelog

All notable changes to Cycles Budget Guard are documented here. This project follows [Semantic Versioning](https://semver.org/).

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
