// End-to-end: spawns the REAL hook processes (stdin JSON → stdout decision)
// against a live local HTTP server — covers the process entry blocks that
// unit tests (which import run()) cannot.

import { describe, it, expect, afterAll } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");

let nextResponses = [];
const server = createServer((req, res) => {
  const r = nextResponses.shift() ?? { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_e2e" } };
  res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
  res.end(JSON.stringify(r.body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let redirectedApiKey;
const redirectTarget = createServer((req, res) => {
  redirectedApiKey = req.headers["x-cycles-api-key"];
  res.end("{}");
});
await new Promise((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
const redirectTargetUrl = `http://127.0.0.1:${redirectTarget.address().port}/capture`;

afterAll(async () => {
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => redirectTarget.close(resolve)),
  ]);
});

function runHook(script, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(hooksDir, script)],
      {
        env: {
          ...process.env,
          CYCLES_BASE_URL: baseUrl,
          CYCLES_API_KEY: "e2e-key",
          CYCLES_DEFAULT_TENANT: "e2e",
          ...extraEnv,
        },
        encoding: "utf8",
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(JSON.stringify(input));
  });
}

const call = {
  session_id: "e2e-session",
  prompt_id: "p1",
  tool_use_id: `tooluse_e2e_${process.pid}`,
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
};

describe("hook processes end-to-end", () => {
  it("pre-tool-use: DENY over the wire becomes a deny decision", async () => {
    nextResponses = [{ status: 200, body: { decision: "DENY", reason_code: "BUDGET_EXHAUSTED" } }];
    const { code, stdout } = await runHook("pre-tool-use.mjs", call);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("BUDGET_EXHAUSTED");
  });

  it("does not forward the Cycles API key across redirects", async () => {
    redirectedApiKey = undefined;
    nextResponses = [{ status: 302, headers: { location: redirectTargetUrl }, body: {} }];
    const redirected = { ...call, tool_use_id: `tooluse_redirect_${process.pid}` };
    const { code, stdout } = await runHook("pre-tool-use.mjs", redirected);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(redirectedApiKey).toBeUndefined();
  });

  it("full lifecycle: reserve (pre) then commit (post) settles the hold", async () => {
    nextResponses = [
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_life" } },
      { status: 200, body: { status: "COMMITTED", charged: { unit: "CREDITS", amount: 1 } } },
    ];
    const lifecycle = { ...call, tool_use_id: `tooluse_life_${process.pid}` };
    const pre = await runHook("pre-tool-use.mjs", lifecycle);
    expect(pre.stdout).toBe(""); // silent allow
    const post = await runHook("post-tool-use.mjs", lifecycle);
    expect(post.code).toBe(0);
  });

  it("failure path: post-tool-use-failure releases instead of committing", async () => {
    nextResponses = [
      { status: 200, body: { decision: "ALLOW", reservation_id: "rsv_flife" } },
      { status: 200, body: { status: "RELEASED" } },
    ];
    const failing = { ...call, tool_use_id: `tooluse_flife_${process.pid}` };
    await runHook("pre-tool-use.mjs", failing);
    const post = await runHook("post-tool-use-failure.mjs", failing);
    expect(post.code).toBe(0);
  });

  it("session-end runs clean with nothing pending", async () => {
    const end = await runHook("session-end.mjs", { session_id: `e2e-clean-${process.pid}` });
    expect(end.code).toBe(0);
  });

  it("keeps malformed stdin non-blocking while enforcement is dormant", async () => {
    const child = await new Promise((resolve) => {
      const c = execFile(process.execPath, [join(hooksDir, "pre-tool-use.mjs")], { encoding: "utf8" }, (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
      c.stdin.end("this is not json");
    });
    expect(child.code).toBe(0);
    expect(child.stderr).toContain("cycles-plugin:");
  });

  it("malformed stdin blocks when enforcement is configured", async () => {
    const child = await new Promise((resolve) => {
      const c = execFile(
        process.execPath,
        [join(hooksDir, "pre-tool-use.mjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CYCLES_BASE_URL: baseUrl,
            CYCLES_DEFAULT_TENANT: "e2e",
          },
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
      c.stdin.end("this is not json");
    });
    expect(child.code).toBe(2);
    expect(child.stderr).toContain("cycles-plugin:");
  });
});
