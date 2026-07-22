import { describe, expect, it } from "vitest";

import { runCommand } from "../scripts/smoke-install.mjs";

describe("install smoke command runner", () => {
  it("terminates a stalled command at the configured deadline", () => {
    const startedAt = Date.now();

    expect(() => runCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10_000)"],
      { timeoutMs: 100 },
    )).toThrow("Command timed out after 100 ms");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
