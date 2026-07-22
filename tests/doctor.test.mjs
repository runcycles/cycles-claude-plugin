import { describe, expect, it } from "vitest";

import { diagnose } from "../scripts/doctor.mjs";

describe("doctor diagnostics", () => {
  it("reports dormant configuration without exposing the API key", () => {
    const result = diagnose({ CYCLES_API_KEY: "top-secret" }, "v22.0.0");

    expect(result).toMatchObject({
      status: "dormant",
      nodeVersion: "v22.0.0",
      apiKeyConfigured: true,
      baseUrlConfigured: false,
      baseUrl: null,
      subject: {},
      failClosed: false,
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
  });

  it("reports effective active enforcement settings", () => {
    const result = diagnose({
      CYCLES_BASE_URL: "https://cycles.example.test/",
      CYCLES_API_KEY: "secret",
      CYCLES_DEFAULT_TENANT: "acme",
      CYCLES_DEFAULT_APP: "claude-code",
      CYCLES_CC_UNIT: "RISK_POINTS",
      CYCLES_CC_COST: "3",
      CYCLES_CC_FAIL_CLOSED: "true",
      CYCLES_CC_TTL_MS: "60000",
      CYCLES_CC_SKIP_TOOLS: "^(Read)$",
    });

    expect(result).toMatchObject({
      status: "active",
      baseUrl: "https://cycles.example.test",
      subject: { tenant: "acme", app: "claude-code" },
      unit: "RISK_POINTS",
      costPerToolCall: 3,
      failClosed: true,
      reservationTtlMs: 60000,
      skippedToolsPattern: "^(Read)$",
    });
    expect(result.routingKey).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports invalid configuration without throwing", () => {
    expect(diagnose({
      CYCLES_BASE_URL: "not-a-url",
      CYCLES_API_KEY: "secret",
      CYCLES_DEFAULT_TENANT: "acme",
    })).toEqual(expect.objectContaining({
      status: "invalid",
      apiKeyConfigured: true,
      error: expect.stringContaining("CYCLES_BASE_URL"),
    }));
  });
});
