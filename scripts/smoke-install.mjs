import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceSource = process.env.MARKETPLACE_SOURCE || repositoryRoot;
const claudeBin = process.env.CLAUDE_BIN || "claude";
const commandTimeoutMs = 180_000;

export function runCommand(command, args, {
  cwd = repositoryRoot,
  env = process.env,
  json = false,
  timeoutMs = commandTimeoutMs,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
      result.error?.code === "ETIMEDOUT" ? `Command timed out after ${timeoutMs} ms` : undefined,
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return json ? JSON.parse(result.stdout) : result.stdout;
}

export async function smokeInstall() {
  const scratch = await mkdtemp(join(tmpdir(), "cycles-plugin-smoke-"));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(scratch, "config"),
    CLAUDE_CODE_PLUGIN_CACHE_DIR: join(scratch, "plugins"),
  };
  const run = (args, options) => runCommand(claudeBin, args, { ...options, env });

  try {
    run(["plugin", "marketplace", "add", marketplaceSource]);
    run(["plugin", "install", "cycles-budget-guard@runcycles"]);
    const installed = run(["plugin", "list", "--json"], { json: true });
    const serialized = JSON.stringify(installed);
    if (!serialized.includes("cycles-budget-guard") || !serialized.includes("runcycles")) {
      throw new Error("Installed plugin was not present in `claude plugin list --json`");
    }
    const details = run(["plugin", "details", "cycles-budget-guard@runcycles"]);
    for (const component of ["budget", "doctor", "PreToolUse", "cycles"]) {
      if (!details.includes(component)) throw new Error(`Plugin details did not include ${component}`);
    }
    console.log(`Fresh plugin installation passed from ${marketplaceSource}.`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) await smokeInstall();
