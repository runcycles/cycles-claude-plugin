import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const [plugin, marketplace, pkg, lock, readme, audit, changelog] = await Promise.all([
  readJson(".claude-plugin/plugin.json"),
  readJson(".claude-plugin/marketplace.json"),
  readJson("package.json"),
  readJson("package-lock.json"),
  readFile("README.md", "utf8"),
  readFile("AUDIT.md", "utf8"),
  readFile("CHANGELOG.md", "utf8"),
]);

const entry = marketplace.plugins?.find((candidate) => candidate.name === plugin.name);
assert(entry !== undefined, `Marketplace has no entry for ${plugin.name}`);

const versions = [plugin.version, entry.version, pkg.version, lock.version, lock.packages?.[""]?.version];
assert(new Set(versions).size === 1, `Version mismatch: ${versions.join(", ")}`);
assert(/^(?:0|[1-9]\d*)\.\d+\.\d+$/.test(plugin.version), `Invalid semantic version: ${plugin.version}`);

for (const field of ["displayName", "description", "homepage", "repository", "license"]) {
  assert(entry[field] === plugin[field], `Marketplace ${field} does not match plugin.json`);
}
assert(JSON.stringify(entry.author) === JSON.stringify(plugin.author), "Marketplace author does not match plugin.json");
assert(JSON.stringify(entry.keywords) === JSON.stringify(plugin.keywords), "Marketplace keywords do not match plugin.json");
assert(new Set(plugin.keywords).size === plugin.keywords.length, "Plugin keywords contain duplicates");

const companion = plugin.mcpServers?.cycles?.args?.find((arg) => arg.startsWith("@runcycles/mcp-server@"));
assert(companion !== undefined, "Companion MCP server is not declared");
assert(/^@runcycles\/mcp-server@\d+\.\d+\.\d+$/.test(companion), `Companion MCP server is not exactly pinned: ${companion}`);

const displayVersion = `v${plugin.version}`;
assert(readme.includes(`plugin-${displayVersion.replace("-", "--")}`), "README version badge is stale");
assert(audit.includes(`\`${plugin.name}\` ${displayVersion}`), "AUDIT plugin version is stale");
assert(changelog.includes(`## [${plugin.version}]`), "CHANGELOG has no entry for the current version");

const releaseTag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "");
if (releaseTag !== "") assert(releaseTag === displayVersion, `Release tag ${releaseTag} does not match ${displayVersion}`);

console.log(`Metadata is consistent for ${plugin.name} ${displayVersion}; companion ${companion}.`);
