/**
 * Seam for Codex ownership parity (D12). The Codex package publishes its live
 * native-compaction eligibility on a process-global slot; the host watches it
 * once per session start and replaces the main owner when the revision
 * changes.
 *
 * Stub: the read is final, the watcher reads once and never subscribes. The
 * Codex eligibility unit (U-CODEX) fills `watchCodexEligibility`; its
 * signature is final so `register.ts` does not change again.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { HostRuntime } from "./runtime.ts";

export const CODEX_ELIGIBILITY_SLOT: unique symbol = Symbol.for(
  "choco-pi.codex-compaction-eligibility",
);

export interface CodexEligibility {
  readonly revision: number;
  readonly nativeCompaction: boolean;
  readonly reason?: string;
}

const CodexEligibilitySchema = Type.Object(
  {
    revision: Type.Number({ minimum: 0 }),
    nativeCompaction: Type.Boolean(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** The published eligibility, or undefined when the slot is absent or does not have the expected shape. */
export function readCodexEligibility(): CodexEligibility | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, CODEX_ELIGIBILITY_SLOT)?.value;
  if (!Value.Check(CodexEligibilitySchema, found)) return undefined;
  const { revision, nativeCompaction, reason } = found;
  return reason === undefined
    ? { revision, nativeCompaction }
    : { revision, nativeCompaction, reason };
}

/**
 * Watch Codex eligibility for this registration; returns the disposer.
 * Stub: reads once and returns a no-op disposer (U-CODEX subscribes and
 * calls `onChange` on revision changes).
 */
export function watchCodexEligibility(
  _rt: HostRuntime,
  _onChange: (eligibility: CodexEligibility) => void,
): () => void {
  readCodexEligibility();
  return () => {
    // Nothing subscribed yet.
  };
}
