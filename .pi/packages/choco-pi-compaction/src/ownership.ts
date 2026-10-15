import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

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

/** Owner key prefix of a main (non-child) session's background coordinator. */
const MAIN_OWNER_KEY_PREFIX = "main-session:";

/**
 * Registry owner key of a main session's background coordinator.
 *
 * Deterministic: `main-session:<sessionId>`, where `sessionId` is
 * `ctx.sessionManager.getSessionId()`. It is the key under which the
 * coordinator is registered (`getCoordinator(mainOwnerKey(id))`) and the
 * `ownerKey` written into every adopted checkpoint's details. Child sessions
 * use the subagent bridge's `subagent-child:<childSessionId>` instead. The
 * owner generation is a process-unique counter and is not derivable; read it
 * from the registered coordinator.
 */
export function mainOwnerKey(sessionId: string): string {
  return `${MAIN_OWNER_KEY_PREFIX}${sessionId}`;
}

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const ChildSessionRegistrySchema = Type.Object({
  isChildSessionId: Type.Function([Type.String()], Type.Boolean()),
});

/**
 * Whether a session ID belongs to a live subagent child session.
 *
 * The subagents runner registers each child ID before its extensions bind, so
 * the probe is reliable at `session_start`. An absent or malformed registry
 * means "not a child". Child sessions get their coordinator from the runner's
 * bridge; the main extension stays inert there so a child never has two.
 */
export function isChildSession(sessionId: string): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  if (!Value.Check(ChildSessionRegistrySchema, entry)) return false;
  return entry.isChildSessionId(sessionId) === true;
}

/** Owner inputs beyond the Codex snapshot. */
export interface OwnerOptions {
  /**
   * Anthropic server-side compaction is selected for this session. It claims
   * `anthropic-messages` models only after every Codex rule declined; its
   * handler falls back to the local summarizer whenever it cannot answer.
   */
  readonly anthropicServerSide?: boolean;
}

/**
 * Resolve the owner of the compaction summary for this context.
 *
 * Codex owns the summary exactly when its own handler would produce one,
 * because that handler runs after this one and its result would replace
 * anything produced here; worse, cancelling here on a failure would stop the
 * codex handler from ever running. Codex's condition is
 * `responsesCompaction && (codex transport || configured extra provider)`
 * (`choco-pi-codex` `resolveCodexRuntimePlan`), where a configured extra
 * provider is a responses-API model whose provider is listed in
 * `scope.additionalProviders`.
 *
 * A codex transport with `responsesCompaction` off is summarized here. The
 * former unconditional abstention for codex transports left that case to the
 * host's default summarizer; it is gone because codex's handler abstains
 * whenever native compaction is off, so nothing replaces this result and a
 * cancellation here stops no codex summary.
 *
 * `snapshot` is passed in rather than read here so this function stays pure
 * and the configuration read happens once per session, off the hot path. An
 * absent snapshot means no configuration was loaded yet; a codex transport
 * then still abstains, because codex may be configured for native compaction
 * and a failure here would cancel its handler, while abstaining is safe either
 * way (codex summarizes, or the host default does).
 */
export function resolveOwner(
  ctx: Pick<ExtensionContext, "model">,
  snapshot?: CodexCompactionSnapshot | undefined,
  options: OwnerOptions = {},
): CompactionOwner {
  const model = ctx.model;
  if (!model) {
    return "none";
  }
  if (isCodexTransportContext(ctx) && (snapshot === undefined || snapshot.responsesCompaction)) {
    return "codex-native";
  }
  if (snapshot?.responsesCompaction && isResponsesContext(ctx)) {
    const provider = model.provider.trim().toLowerCase();
    if (provider.length > 0 && snapshot.additionalProviders.includes(provider)) {
      return "codex-native";
    }
  }
  if (options.anthropicServerSide === true && model.api === "anthropic-messages") {
    return "anthropic-native";
  }
  return "local";
}
