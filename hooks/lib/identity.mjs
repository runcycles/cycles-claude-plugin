// Retry-stable identity for a tool call. The documented contract provides
// tool_use_id on PreToolUse, PostToolUse, and PostToolUseFailure — a unique
// id per tool call in the conversation — which is the correct identity:
// distinct identical calls get distinct keys, and a transport retry of the
// same call reproduces the same key (the Cycles server then replays the
// stored response instead of double-reserving).
//
// Fallback for older Claude Code versions without tool_use_id: hash of the
// stable fields both hooks see. Known fallback limit (documented): identical
// calls sharing session/prompt/tool/args collide and share one reservation —
// under-counts, never over-charges.

import { createHash } from "node:crypto";

function digest(material) {
  return `cc_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

export function toolCallKey(input) {
  if (typeof input.tool_use_id === "string" && input.tool_use_id !== "") {
    return digest(`${input.session_id ?? ""}|${input.tool_use_id}`);
  }
  return digest(
    stableStringify({
      session: input.session_id ?? "",
      prompt: input.prompt_id ?? "",
      tool: input.tool_name ?? "",
      args: input.tool_input ?? {},
    }),
  );
}
