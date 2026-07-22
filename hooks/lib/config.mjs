// Plugin configuration, entirely from environment variables so it works
// identically under Claude Code's hook runner and in tests.

const SUBJECT_FIELDS = ["tenant", "workspace", "app", "workflow", "agent", "toolset"];

export function loadConfig(env = process.env) {
  const baseUrl = (env.CYCLES_BASE_URL ?? "").replace(/\/+$/, "");
  const subject = {};
  for (const field of SUBJECT_FIELDS) {
    const value = env[`CYCLES_DEFAULT_${field.toUpperCase()}`];
    if (value !== undefined && value !== "") {
      if (value.trim() === "" || value.length > 128) {
        throw new Error(`Invalid CYCLES_DEFAULT_${field.toUpperCase()}: must be 1-128 characters and not whitespace-only.`);
      }
      subject[field] = value;
    }
  }
  const cost = Number.parseInt(env.CYCLES_CC_COST ?? "1", 10);
  return {
    baseUrl,
    apiKey: env.CYCLES_API_KEY ?? "",
    subject,
    // Enforcement is skipped for tools matching this pattern. The cycles MCP
    // tools are ALWAYS skipped regardless (recursion guard in the hook).
    skipTools: new RegExp(env.CYCLES_CC_SKIP_TOOLS ?? "^(TodoWrite|AskUserQuestion)$"),
    unit: env.CYCLES_CC_UNIT ?? "CREDITS",
    cost: Number.isFinite(cost) && cost > 0 ? cost : 1,
    // Fail-open by default: if the Cycles server is unreachable, allow the
    // tool call and surface a warning. Set CYCLES_CC_FAIL_CLOSED=true to
    // block instead (strict enforcement).
    failClosed: env.CYCLES_CC_FAIL_CLOSED === "true",
    ttlMs: 300_000,
  };
}

export function isConfigured(config) {
  return config.baseUrl !== "" && Object.keys(config.subject).length > 0;
}
