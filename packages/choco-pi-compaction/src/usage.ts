import type { Usage } from "@earendil-works/pi-ai";

/**
 * Sum the usage of two summarization calls.
 *
 * Mirrors the host's private `combineUsage` (`core/compaction/compaction.js`),
 * which is not exported: the optional `cacheWrite1h` and `reasoning` fields
 * appear only when at least one input reported them, so a consumer can still
 * tell "not reported" from "zero".
 */
export function combineUsage(first: Usage, second: Usage): Usage {
  const combined: Usage = {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
  if (first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined) {
    combined.cacheWrite1h = (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0);
  }
  if (first.reasoning !== undefined || second.reasoning !== undefined) {
    combined.reasoning = (first.reasoning ?? 0) + (second.reasoning ?? 0);
  }
  return combined;
}
