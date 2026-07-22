import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isConfigured, loadConfig, routingKey } from "../hooks/lib/config.mjs";

export function diagnose(env = process.env, nodeVersion = process.version) {
  const common = {
    nodeVersion,
    apiKeyConfigured: typeof env.CYCLES_API_KEY === "string" && env.CYCLES_API_KEY !== "",
  };

  try {
    const config = loadConfig(env);
    return {
      status: isConfigured(config) ? "active" : "dormant",
      ...common,
      baseUrlConfigured: config.baseUrl !== "",
      baseUrl: config.baseUrl || null,
      subject: config.subject,
      routingKey: routingKey(config),
      unit: config.unit,
      costPerToolCall: config.cost,
      failClosed: config.failClosed,
      reservationTtlMs: config.ttlMs,
      skippedToolsPattern: config.skipTools.source,
    };
  } catch (error) {
    return {
      status: "invalid",
      ...common,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.stdout.write(`${JSON.stringify(diagnose(), null, 2)}\n`);
}
