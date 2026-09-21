import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isCodexTransportContext } from "../../choco-pi-codex/src/adapter/prompt/codex-model.ts";

/**
 * Which component owns the summary for the active model.
 *
 * The union stays open on purpose: a future native Anthropic compaction path
 * becomes another owner value instead of a second boolean.
 */
export type CompactionOwner = "none" | "codex-native" | "anthropic-native" | "local";

/**
 * Resolve the owner of the compaction summary for this context.
 *
 * Codex transports carry their own server-side compaction, and the codex
 * package's handler runs after this one, so its result would replace anything
 * produced here. Abstaining avoids a wasted provider call.
 *
 * The check is deliberately the transport predicate alone. The codex package's
 * `responsesCompaction` config flag is not consulted: reading another package's
 * settings would couple this handler to that package's configuration surface,
 * and abstaining on a codex transport is safe even when codex falls back,
 * because the host then runs its own default compaction.
 */
export function resolveOwner(ctx: Pick<ExtensionContext, "model">): CompactionOwner {
  if (!ctx.model) {
    return "none";
  }
  if (isCodexTransportContext(ctx)) {
    return "codex-native";
  }
  return "local";
}
