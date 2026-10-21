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
export type CompactionOwner = "none" | "codex-native" | "anthropic-native" | "xai-native" | "local";

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

/**
 * Owner key prefix of a subagent child's coordinator. Mirrors the subagent
 * bridge's `CHILD_OWNER_KEY_PREFIX` (a test pins the two); it is not imported
 * so this module, which the Codex package loads, never pulls the bridge in.
 */
export const CHILD_OWNER_KEY_PREFIX = "subagent-child:";

/**
 * Registry owner key of the coordinator that serves `sessionId`: the subagent
 * bridge's `subagent-child:<sessionId>` for a live child session, otherwise
 * {@link mainOwnerKey}. Backends that bind per session (Codex) key their
 * bindings with this so a child coordinator finds its child's binding.
 */
export function ownerKeyFor(sessionId: string): string {
  return isChildSession(sessionId)
    ? `${CHILD_OWNER_KEY_PREFIX}${sessionId}`
    : mainOwnerKey(sessionId);
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

// ---------------------------------------------------------------------------
// Codex native-compaction eligibility slot (D12)
// ---------------------------------------------------------------------------

/**
 * Process-global slot on which the Codex package publishes its live
 * native-compaction eligibility. It lives here rather than in
 * `background-host/` so ownership, which the Codex package also loads, reads
 * it without pulling the host runtime in.
 */
export const CODEX_ELIGIBILITY_SLOT: unique symbol = Symbol.for(
  "choco-pi.codex-compaction-eligibility",
);

/** The model fields the Codex eligibility predicate decides on. */
export interface CodexEligibilityModel {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly baseUrl: string;
}

/**
 * The published slot: `revision` changes whenever an input of the predicate
 * changes (Codex `/codex` compaction, scope, voice-only or extras switches,
 * canonical-alias endpoint trust); `isNativeCompactionOwner` is Codex's own
 * `resolveCodexRuntimePlan(...).nativeCompaction` for the model;
 * `subscribe` calls the listener with the new revision and returns its removal.
 */
export interface CodexEligibility {
  readonly version: 1;
  readonly revision: number;
  /**
   * False while no Codex registration is published (all shut down); the
   * snapshot heuristic then applies. Absent counts as published.
   */
  readonly published?: boolean;
  /**
   * The answering registration's live `compaction.responsesCompaction` (the
   * OpenAI row of the derived default lanes). Absent: unknown, the session
   * snapshot applies.
   */
  readonly responsesCompaction?: boolean;
  isNativeCompactionOwner(model: CodexEligibilityModel): boolean;
  subscribe(listener: (revision: number) => void): () => void;
}

const SlotFunction = Type.Function([], Type.Unknown());
/** Shape only: the functions are checked to be callable, their results at each call. */
const CodexEligibilitySchema = Type.Object(
  {
    version: Type.Literal(1),
    revision: Type.Integer({ minimum: 0 }),
    published: Type.Optional(Type.Boolean()),
    responsesCompaction: Type.Optional(Type.Boolean()),
    isNativeCompactionOwner: SlotFunction,
    subscribe: SlotFunction,
  },
  { additionalProperties: true },
);

function isCodexEligibility<T>(value: T): value is T & CodexEligibility {
  return Value.Check(CodexEligibilitySchema, value);
}

/** The published eligibility, or undefined when the slot is absent or does not have the expected shape. */
export function readCodexEligibility(): CodexEligibility | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(globalThis, CODEX_ELIGIBILITY_SLOT)?.value;
  return isCodexEligibility(found) ? found : undefined;
}

/**
 * Codex's live `compaction.responsesCompaction` from the eligibility slot, or
 * undefined when no Codex registration is published (no slot, a foreign
 * value, every registration shut down, or a slot without the field). Owner
 * restarts derive the OpenAI lane row from this before the session snapshot,
 * which a `/codex` change made after session start leaves stale.
 */
export function publishedCodexResponsesCompaction(): boolean | undefined {
  const slot = readCodexEligibility();
  if (slot === undefined || slot.published === false) return undefined;
  return slot.responsesCompaction;
}

/** Owner inputs beyond the Codex snapshot. */
export interface OwnerOptions {
  /**
   * Anthropic server-side compaction is selected for this session. It claims
   * `anthropic-messages` models only after every Codex rule declined; its
   * handler falls back to the local summarizer whenever it cannot answer.
   */
  readonly anthropicServerSide?: boolean;
  /**
   * xAI server-side compaction is selected for this session. It claims the
   * `xai` provider's `openai-responses` models only after every Codex rule
   * declined; its handler falls back to the local summarizer whenever it
   * cannot answer.
   */
  readonly xaiServerSide?: boolean;
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
 * When the Codex package published its live eligibility
 * ({@link readCodexEligibility}), that predicate is authoritative: it is
 * Codex's own runtime-plan decision (extras, voice-only, inactive and
 * untrusted-alias plans included) and follows `/codex` changes without a new
 * session. Otherwise the session-start snapshot heuristic below applies.
 *
 * `snapshot` is passed in rather than read here so the configuration read
 * happens once per session, off the hot path. An absent snapshot means no
 * configuration was loaded yet; a codex transport then still abstains,
 * because codex may be configured for native compaction and a failure here
 * would cancel its handler, while abstaining is safe either way (codex
 * summarizes, or the host default does).
 */
/** Codex's claim: the published eligibility when present, else the snapshot heuristic. */
function codexOwns(
  ctx: Pick<ExtensionContext, "model">,
  model: CodexEligibilityModel,
  snapshot: CodexCompactionSnapshot | undefined,
): boolean {
  const eligibility = readCodexEligibility();
  if (eligibility !== undefined && eligibility.published !== false) {
    const native: unknown = eligibility.isNativeCompactionOwner({
      provider: model.provider,
      id: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
    });
    return native === true;
  }
  if (isCodexTransportContext(ctx) && (snapshot === undefined || snapshot.responsesCompaction)) {
    return true;
  }
  if (!snapshot?.responsesCompaction || !isResponsesContext(ctx)) return false;
  const provider = model.provider.trim().toLowerCase();
  return provider.length > 0 && snapshot.additionalProviders.includes(provider);
}

export function resolveOwner(
  ctx: Pick<ExtensionContext, "model">,
  snapshot?: CodexCompactionSnapshot | undefined,
  options: OwnerOptions = {},
): CompactionOwner {
  const model = ctx.model;
  if (!model) {
    return "none";
  }
  if (codexOwns(ctx, model, snapshot)) {
    return "codex-native";
  }
  if (options.anthropicServerSide === true && model.api === "anthropic-messages") {
    return "anthropic-native";
  }
  if (
    options.xaiServerSide === true &&
    model.api === "openai-responses" &&
    model.provider === "xai"
  ) {
    return "xai-native";
  }
  return "local";
}
