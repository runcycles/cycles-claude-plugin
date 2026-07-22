// Retry-stable identity for a tool call. PreToolUse/PostToolUse provide no
// tool_use_id, so the key is derived from the stable fields both hooks see:
// (session_id, prompt_id, tool_name, tool_input). A transport-level retry of
// the same call reproduces the same key — the Cycles server then replays the
// stored response instead of double-reserving. Known limit (documented):
// two IDENTICAL calls within one prompt turn share a key and therefore a
// reservation; budget effect is a single hold for the pair, which
// under-counts by one flat cost rather than over-charging.

import { createHash } from "node:crypto";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

export function toolCallKey(input) {
  const material = stableStringify({
    session: input.session_id ?? "",
    prompt: input.prompt_id ?? "",
    tool: input.tool_name ?? "",
    args: input.tool_input ?? {},
  });
  return `cc_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}
