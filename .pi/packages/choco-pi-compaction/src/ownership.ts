import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  isCodexTransportContext,
  isResponsesContext,
} from "../../choco-pi-codex/src/adapter/prompt/codex-model.ts";

/**
 * Which component owns the summary for the active model.
 *
 * The union stays open on purpose: a future native Anthropic compaction path
 * becomes another owner value instead of a second boolean.
 */
export type CompactionOwner = "none" | "codex-native" | "anthropic-native" | "local";

/**
 * The codex configuration that decides native compaction, read once per session.
 *
 * Provider ids are already trimmed and lowercased by codex's own config
 * normalization, so matching here lowercases the model provider only.
 */
export interface CodexCompactionSnapshot {
  /** Codex's `compaction.responsesCompaction` flag. */
  readonly responsesCompaction: boolean;
  /** Codex's `scope.additionalProviders`, normalized to lowercase. */
  readonly additionalProviders: readonly string[];
}

/**
 * Resolve the owner of the compaction summary for this context.
 *
 * Codex owns the summary whenever its own handler would produce one, because
 * that handler runs after this one and its result would replace anything
 * produced here; worse, cancelling here on a failure would stop the codex
 * handler from ever running. Codex's condition is
 * `responsesCompaction && (codex transport || configured extra provider)`
 * (`choco-pi-codex` `resolveCodexRuntimePlan`), where a configured extra
 * provider is a responses-API model whose provider is listed in
 * `scope.additionalProviders`. A codex transport abstains unconditionally:
 * even when codex falls back, the host then runs its own default compaction.
 *
 * `snapshot` is passed in rather than read here so this function stays pure
 * and the configuration read happens once per session, off the hot path. An
 * absent snapshot means no configuration was loaded yet, which only leaves the
 * transport rule in force.
 */
export function resolveOwner(
  ctx: Pick<ExtensionContext, "model">,
  snapshot?: CodexCompactionSnapshot | undefined,
): CompactionOwner {
  const model = ctx.model;
  if (!model) {
    return "none";
  }
  if (isCodexTransportContext(ctx)) {
    return "codex-native";
  }
  if (snapshot?.responsesCompaction && isResponsesContext(ctx)) {
    const provider = model.provider.trim().toLowerCase();
    if (provider.length > 0 && snapshot.additionalProviders.includes(provider)) {
      return "codex-native";
    }
  }
  return "local";
}
