import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceSource = process.env.MARKETPLACE_SOURCE || repositoryRoot;
const claudeBin = process.env.CLAUDE_BIN || "claude";
const scratch = await mkdtemp(join(tmpdir(), "cycles-plugin-smoke-"));
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(scratch, "config"),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(scratch, "plugins"),
};

function run(args, { json = false } = {}) {
  const result = spawnSync(claudeBin, args, {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error([
      `${claudeBin} ${args.join(" ")} failed with exit ${result.status}`,
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return json ? JSON.parse(result.stdout) : result.stdout;
}

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
