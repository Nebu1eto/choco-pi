import { conditionalProperties } from "../runtime-values.ts";
import { JsonObjectSchema } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  type Api,
  type Context,
  getCurrentTools,
  normalizeContext,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  codexLaneRoute,
  findLatestNativeCompactionEntry,
  findLatestNativeCompactionEntryIndex,
  nativeCompactionEntryMatches,
  resolveLatestNativeCompactionEntry,
  type LatestNativeCompactionResolution,
} from "./details-store.ts";
import {
  appendLaneRecord,
  type LaneReason,
  type LaneRecordInput,
  type LaneRoute,
} from "../../../../choco-pi-compaction/src/background/lane-journal.ts";
import {
  lossAuthorizedFor,
  OPAQUE_GUARD_NOTICE,
  opaqueCheckpointOf,
} from "../../../../choco-pi-compaction/src/opaque-checkpoint.ts";
import { codexBackgroundAccountScope } from "./background-v2.ts";
import {
  rewriteResponsesPayloadWithNativeReplay,
  serializeLiveTailToResponsesInput,
} from "../replay/payload-rewrite.ts";
import {
  DEFAULT_SUPPORTED_PROVIDERS,
  isResponsesCompatiblePayload,
  resolveNativeCompactionEnvironment,
  type ResponsesCompatibleRequestPayload,
} from "./compaction-runtime.ts";
import {
  serializeActiveSessionToResponsesInput,
  serializeMessagesToResponsesInput,
  type NativeCompactionRequestOptions,
  type ResponsesInputItem,
  type SerializeResponsesMessagesOptions,
} from "./serializer.ts";
import {
  createNativeCompactionDetails,
  createNativeCompactionShimResult,
  NATIVE_COMPACTION_SHIM_SUMMARY,
  type NativeCompactionEntry,
} from "../compaction/types.ts";
import { isResponsesContext } from "../prompt/codex-model.ts";
import { isCodeModeRuntime, resolveCodexRuntimePlanForState } from "../activation/runtime-plan.ts";
import type { AdapterState } from "../activation/state.ts";
import { executeRemoteCompactionV2, type RemoteCompactionV2Result } from "./remote-v2-client.ts";
import { buildRemoteCompactionV2Window } from "./remote-v2-history.ts";
import { CODE_MODE_EXEC_GRAMMAR_INPUTS } from "../../tools/code-mode/exec-contract.ts";
import { getActiveToolsInActiveOrder } from "../active-tools.ts";
import { isProviderContextExcludedMessage } from "../prompt/context-filter.ts";
import { resolveCanonicalCompactionPromptInput } from "../../providers/openai-codex/session-continuity.ts";
import {
  extractAccountId,
  resolveCodexWebSocketUrl,
} from "../../providers/openai-codex/headers.ts";
import type { CodexCompactionDiagnostic } from "./diagnostics.ts";
import { projectForcedPromptContext } from "../forced-prompt-projection.ts";
import { OPENAI_SIGN_IN_COMPACTION_REASON } from "../openai-sign-in.ts";

const notifiedOpenAISignInCompactionSessions = new Set<string>();

/**
 * A provider request that must not be sent: the latest Codex checkpoint cannot
 * be replayed for it and its loss is not authorized. Throwing from
 * `before_provider_request` does not stop the host from sending, so the
 * extension records the refusal and the Codex transport fails the request
 * before any network call (`events.ts` / `register.ts`).
 */
export class CodexRequestRefusedError extends Error {
  override name = "CodexRequestRefusedError";
}

/** The lane-record fields a foreground Codex site chooses; the rest is fixed per site. */
type CodexForegroundRecord = Pick<LaneRecordInput, "event" | "reason" | "noticeAttempted"> &
  Partial<Pick<LaneRecordInput, "to" | "detail" | "checkpointEntryId">>;

/** Append one `codex-foreground` lane record through `pi.appendEntry`. */
function journalCodexForeground(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionContext,
  route: LaneRoute,
  record: CodexForegroundRecord,
): void {
  appendLaneRecord(
    (customType, data) => pi.appendEntry(customType, data),
    {
      at: Date.now(),
      sessionId: ctx.sessionManager.getSessionId(),
      provider: "codex",
      route,
      from: "codex-foreground",
      ...record,
    },
    (message) => ctx.ui.notify(message, "warning"),
  );
}

/** The package-owned code of a failed native compaction. */
function compactionFailureReason(
  result: Extract<RemoteCompactionV2Result, { ok: false }>,
): LaneReason {
  if (result.reason === "aborted") return "canceled";
  if (result.reason === "oversized" || result.reason === "context-overflow") return "oversized";
  if (result.reason === "invalid-output") return "malformed";
  if (result.reason === "unsupported" || result.reason === "unavailable") return "unsupported";
  if (result.status === 401 || result.status === 403) return "auth";
  if (result.status === 429) return "429";
  return "provider-error";
}

/**
 * The background lane's account digest for this runtime, so a background
 * checkpoint is replayed only for the account that made it. A Codex runtime
 * whose credential names no account gets a value no digest equals (fail
 * closed); other runtimes are not account-scoped.
 */
function runtimeAccountScope(runtime: {
  readonly codexTransport: boolean;
  readonly apiKey?: string | undefined;
}): string | undefined {
  if (!runtime.codexTransport) return undefined;
  if (!runtime.apiKey) return "unverified-account";
  try {
    return codexBackgroundAccountScope(extractAccountId(runtime.apiKey));
  } catch {
    return "unverified-account";
  }
}

/** Tell the user once per session that sign-in uses Pi's local compaction instead. */
function notifyOpenAISignInCompactionFallback(ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  if (notifiedOpenAISignInCompactionSessions.has(sessionId)) return;
  notifiedOpenAISignInCompactionSessions.add(sessionId);
  ctx.ui.notify(`OpenAI native compaction skipped: ${OPENAI_SIGN_IN_COMPACTION_REASON}.`, "info");
}

function isRecord(value: BoundaryValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function stashLatestNativeWindowForPiCompactionFallback(
  ctx: ExtensionContext,
  branchEntries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
  runtime: { provider: string; api: string; baseUrl: string },
  state: AdapterState,
): boolean {
  state.pendingPiCompactionNativeWindow = undefined;
  const nativeEntry = findLatestNativeCompactionEntry(branchEntries, {
    provider: runtime.provider,
    api: runtime.api,
    baseUrl: runtime.baseUrl,
  });
  const compactedWindow = cloneCompactedWindow(nativeEntry?.details?.compactedWindow ?? []);
  if (!compactedWindow || compactedWindow.length === 0) return false;
  state.pendingPiCompactionNativeWindow = {
    window: compactedWindow,
    provider: runtime.provider,
    api: runtime.api,
    baseUrl: runtime.baseUrl,
    sessionId: ctx.sessionManager.getSessionId(),
    sourceCompactionEntryId: nativeEntry?.id,
  };
  return true;
}

function cloneCompactedWindow(window: readonly BoundaryValue[]): ResponsesInputItem[] | undefined {
  if (!window.every(isRecord)) return undefined;
  return window.map((item) => structuredClone(item));
}

function buildCompactionReasoning(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: ExtensionContext,
  state: AdapterState,
  compactionTargetModel: Model<Api>,
): NativeCompactionRequestOptions["reasoning"] {
  const level = pi.getThinkingLevel();
  if (!compactionTargetModel.reasoning || level === "off") return undefined;
  // SAFETY: getThinkingLevel returns ModelThinkingLevel or "off", and the preceding branch excludes "off".
  const clampedLevel = clampThinkingLevel(compactionTargetModel, level as ModelThinkingLevel);
  const rawEffort = compactionTargetModel.thinkingLevelMap?.[clampedLevel] ?? clampedLevel;
  const effort =
    Value.Check(Type.String(), rawEffort) &&
    resolveCodexRuntimePlanForState(ctx, state).effectiveOpenAICodex
      ? clampCodexReasoningEffort(compactionTargetModel.id, rawEffort)
      : rawEffort;
  return effort === null ? undefined : { effort, summary: "auto" };
}

function clampCodexReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
  const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1]!, 10) : undefined;
  if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini")
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

function clampOpenAIPromptCacheKey(key: string): string {
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function buildCompactionRequestOptions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: AdapterState,
  compactionTargetModel: Model<Api>,
): NativeCompactionRequestOptions {
  const reasoning = buildCompactionReasoning(pi, ctx, state, compactionTargetModel);
  return {
    parallel_tool_calls: true,
    prompt_cache_key: clampOpenAIPromptCacheKey(ctx.sessionManager.getSessionId()),
    text: { verbosity: state.config.openai.verbosity },
    ...conditionalProperties(Boolean(reasoning), { reasoning }),
  };
}

export function buildCompactionTranscriptContext(
  messages: Context["messages"],
  systemPrompt: string,
  tools: NonNullable<Context["tools"]>,
): ReturnType<typeof normalizeContext> {
  return projectForcedPromptContext(systemPrompt, tools, messages);
}

function notifyNativeCompactionFallback(
  ctx: ExtensionContext,
  state: AdapterState,
  branchEntries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
  runtime: { provider: string; api: string; baseUrl: string },
  message: string,
): void {
  const stashed = stashLatestNativeWindowForPiCompactionFallback(
    ctx,
    branchEntries,
    runtime,
    state,
  );
  ctx.ui.notify(
    `${message}; Pi compaction will run.${stashed ? " Previous native compacted window will be included in Pi compaction fallback." : ""}`,
    "error",
  );
}

/** The `session_before_compact` answer that stops the host compaction. */
interface CompactionCancel {
  readonly cancel: true;
}

/** Notice and journal one foreground cancel. */
function cancelForeground(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  reason: LaneReason,
  message: string | undefined,
): CompactionCancel {
  if (message !== undefined) ctx.ui.notify(message, "error");
  journalCodexForeground(pi, ctx, codexLaneRoute(event.reason), {
    event: "cancel",
    reason,
    noticeAttempted: message !== undefined,
  });
  return { cancel: true };
}

function textFromResponsesContent(content: BoundaryValue): string {
  if (Value.Check(Type.String(), content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      isRecord(item) && item["type"] === "input_text" && Value.Check(Type.String(), item["text"]!)
        ? item["text"]!
        : "",
    )
    .join("\n");
}

function isPiCompactionSummarizationPayload(payload: ResponsesCompatibleRequestPayload): boolean {
  const instructions = Value.Check(Type.String(), payload.instructions) ? payload.instructions : "";
  if (/compact|summar/i.test(instructions)) return true;

  return payload.input.some((item) => {
    if (!isRecord(item)) return false;
    const role = item["role"]!;
    const text = textFromResponsesContent(item["content"]!);
    if ((role === "system" || role === "developer") && /compact|summar/i.test(text)) return true;
    if (role === "user" && /<conversation>|previous compaction summary|summary/i.test(text))
      return true;
    return false;
  });
}

function getSupportedNativeCompactionProviders(state: AdapterState): string[] {
  return [...new Set([...DEFAULT_SUPPORTED_PROVIDERS, ...state.config.scope.additionalProviders])];
}

export function buildNativeCompactionInput(args: {
  model: Model<Api>;
  branchEntries: SessionEntry[];
  allEntries: SessionEntry[];
  leafId?: string | null | undefined;
  latestNativeCompaction: LatestNativeCompactionResolution;
  serializationOptions?: SerializeResponsesMessagesOptions | undefined;
  projectedContext?: ReturnType<typeof normalizeContext> | undefined;
}): { input: ResponsesInputItem[]; compactedKeptWindow: boolean } | undefined {
  if (args.latestNativeCompaction.ok) {
    const compactedWindow = cloneCompactedWindow(
      args.latestNativeCompaction.entry.details?.compactedWindow ?? [],
    );
    if (!compactedWindow) return undefined;
    const liveTailEntries = args.branchEntries.slice(args.latestNativeCompaction.index + 1);
    const baselineEntries = args.branchEntries.slice(0, args.latestNativeCompaction.index + 1);
    const baselineTools = getCurrentTools(
      convertToLlm(buildSessionContext(baselineEntries).messages),
    );
    const projectedTools = args.projectedContext
      ? getCurrentTools(args.projectedContext.messages)
      : undefined;
    const projectedTailMessages = args.projectedContext
      ? projectForcedPromptContext(
          "",
          projectedTools ?? [],
          convertToLlm(buildSessionContext(liveTailEntries).messages),
        ).messages
      : undefined;
    const serializedTail = projectedTailMessages
      ? serializeMessagesToResponsesInput(args.model, projectedTailMessages, {
          ...args.serializationOptions,
          leadingSystemHandled: false,
          baselineTools,
        }).filter(
          (item) =>
            !(
              !("type" in item) &&
              "role" in item &&
              (item.role === "system" || item.role === "developer")
            ),
        )
      : serializeLiveTailToResponsesInput({
          model: args.model,
          entries: liveTailEntries,
          baselineEntries,
          serializationOptions: args.serializationOptions,
        });
    return {
      input: [...compactedWindow, ...serializedTail],
      compactedKeptWindow: false,
    };
  }

  return {
    input: args.projectedContext
      ? serializeMessagesToResponsesInput(
          args.model,
          args.projectedContext.messages,
          args.serializationOptions,
        )
      : serializeActiveSessionToResponsesInput({
          model: args.model,
          entries: args.allEntries,
          leafId: args.leafId,
          options: args.serializationOptions,
        }),
    compactedKeptWindow: true,
  };
}

export async function handleCodexSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  state: AdapterState,
  pi: ExtensionAPI,
) {
  if (!resolveCodexRuntimePlanForState(ctx, state).nativeCompaction) {
    return undefined;
  }

  try {
    return await handleCodexSessionBeforeCompactInner(event, ctx, state, pi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cancelForeground(
      pi,
      ctx,
      event,
      "provider-error",
      `OpenAI native compaction failed unexpectedly: ${message}; Pi compaction was not run.`,
    );
  }
}

async function handleCodexSessionBeforeCompactInner(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  state: AdapterState,
  pi: ExtensionAPI,
) {
  const plan = resolveCodexRuntimePlanForState(ctx, state);
  const route = codexLaneRoute(event.reason);
  if (!plan.effectiveOpenAICodex && !isResponsesContext(ctx)) {
    return cancelForeground(
      pi,
      ctx,
      event,
      "unsupported",
      "OpenAI native compaction is enabled, but the current model is not Responses-compatible; Pi compaction was not run.",
    );
  }
  if (event.signal.aborted) return cancelForeground(pi, ctx, event, "canceled", undefined);

  const resolution = await resolveNativeCompactionEnvironment(ctx, {
    enabled: true,
    supportedProviders: getSupportedNativeCompactionProviders(state),
  });
  if (!resolution.ok) {
    if (resolution.reason === "unsupported-provider" || resolution.reason === "unsupported-api") {
      journalCodexForeground(pi, ctx, route, {
        event: "fallback",
        to: "local",
        reason: "unsupported",
        detail: resolution.reason,
        noticeAttempted: false,
      });
      return undefined;
    }
    if (resolution.reason === "openai-subscription-sign-in") {
      notifyOpenAISignInCompactionFallback(ctx);
      journalCodexForeground(pi, ctx, route, {
        event: "fallback",
        to: "local",
        reason: "unsupported",
        detail: resolution.reason,
        noticeAttempted: true,
      });
      return undefined;
    }
    return cancelForeground(
      pi,
      ctx,
      event,
      resolution.reason === "missing-api-key" ? "auth" : "unsupported",
      `OpenAI native compaction is enabled but unavailable (${resolution.reason}); Pi compaction was not run.`,
    );
  }

  const runtime = resolution.runtime;
  const compactionTargetModel = runtime.currentModel;
  const codeMode = isCodeModeRuntime(plan);
  const serializationOptions = codeMode
    ? { grammarToolInputProperties: CODE_MODE_EXEC_GRAMMAR_INPUTS }
    : undefined;
  const requestOptions = buildCompactionRequestOptions(pi, ctx, state, compactionTargetModel);
  const branchEntries = ctx.sessionManager.getBranch();
  const transcriptMessages = convertToLlm(
    buildSessionContext(branchEntries).messages.filter(
      (message) => !isProviderContextExcludedMessage(message),
    ),
  );
  const context = buildCompactionTranscriptContext(
    transcriptMessages,
    state.activeProviderSystemPrompt ?? ctx.getSystemPrompt(),
    getActiveToolsInActiveOrder(pi, codeMode),
  );
  const accountScope = runtimeAccountScope(runtime);
  const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
    provider: runtime.provider,
    api: runtime.api,
    baseUrl: runtime.baseUrl,
    ...conditionalProperties(accountScope !== undefined, { accountScope }),
  });
  if (
    !latestNativeCompaction.ok &&
    latestNativeCompaction.reason === "latest-native-compaction-mismatch"
  ) {
    return cancelForeground(
      pi,
      ctx,
      event,
      "scope-mismatch",
      "OpenAI native compaction cannot reuse the latest checkpoint with this provider or endpoint; compaction was cancelled to preserve its encrypted history.",
    );
  }
  const builtInput = buildNativeCompactionInput({
    model: compactionTargetModel,
    branchEntries,
    allEntries: ctx.sessionManager.getEntries(),
    leafId: ctx.sessionManager.getLeafId(),
    latestNativeCompaction,
    serializationOptions,
    projectedContext: context,
  });
  if (!builtInput) {
    return cancelForeground(
      pi,
      ctx,
      event,
      "malformed",
      "OpenAI native compaction could not clone the previous compacted window; Pi compaction was not run.",
    );
  }
  const canonicalReplay =
    runtime.codexTransport && runtime.apiKey
      ? resolveCanonicalCompactionPromptInput(
          ctx.sessionManager.getSessionId(),
          runtime.model,
          {
            url: resolveCodexWebSocketUrl(runtime.baseUrl),
            accountId: extractAccountId(runtime.apiKey),
          },
          builtInput.input,
        )
      : { decision: "not_applicable" as const };
  // SAFETY: Canonical replay produced these JSON objects from Responses input items and every retained item passed the record parser.
  const validatedCanonicalInput = canonicalReplay.input?.every(isRecord)
    ? (canonicalReplay.input as ResponsesInputItem[])
    : undefined;
  const input = validatedCanonicalInput ?? builtInput.input;
  const { compactedKeptWindow } = builtInput;
  const checkpointModel = latestNativeCompaction.ok
    ? latestNativeCompaction.entry.details?.model
    : undefined;
  const compactionDiagnostic: CodexCompactionDiagnostic = {
    model: runtime.model,
    inputSource: validatedCanonicalInput ? "canonical" : "reconstructed",
    canonicalReplay: canonicalReplay.decision,
    checkpointReused: latestNativeCompaction.ok,
    ...conditionalProperties(Boolean(checkpointModel), { checkpointModel }),
  };

  if (input.length === 0) {
    return cancelForeground(
      pi,
      ctx,
      event,
      "nothing-to-summarize",
      "OpenAI native compaction had no serializable conversation items; Pi compaction was not run.",
    );
  }
  const compactResult = await executeRemoteCompactionV2({
    customInstructions: event.customInstructions,
    runtime,
    modelRegistry: ctx.modelRegistry,
    context,
    promptInput: input,
    promptInputSource: compactionDiagnostic.inputSource,
    compactionDiagnostic,
    requestOptions,
    tokensBefore: event.preparation.tokensBefore,
    sessionId: ctx.sessionManager.getSessionId(),
    signal: event.signal,
  });
  journalCompactionFocus(pi, ctx, route, compactResult);
  if (!compactResult.ok) {
    if (compactResult.reason === "aborted")
      return cancelForeground(pi, ctx, event, "canceled", undefined);
    notifyNativeCompactionFallback(
      ctx,
      state,
      branchEntries,
      runtime,
      `Responses compaction v2 failed (${compactResult.reason}): ${compactResult.errorMessage}`,
    );
    journalCodexForeground(pi, ctx, route, {
      event: "fallback",
      to: "local",
      reason: compactionFailureReason(compactResult),
      noticeAttempted: true,
    });
    return undefined;
  }
  const compactedWindow = buildRemoteCompactionV2Window(
    input,
    compactResult.compaction,
    state.config.compaction.v2UserMessageRetention * 1_000,
  );
  try {
    const details = createNativeCompactionDetails({
      provider: runtime.provider,
      api: runtime.api,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      compactedWindow,
      compactResponseId: compactResult.responseId,
      createdAt: compactResult.createdAt,
      usage: compactResult.usage,
      requestMeta: {
        tokensBefore: event.preparation.tokensBefore,
        previousSummaryPresent: Boolean(event.preparation.previousSummary),
        compactedKeptWindow,
      },
    });
    return {
      compaction: createNativeCompactionShimResult({
        summary: NATIVE_COMPACTION_SHIM_SUMMARY,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      }),
    };
  } catch {
    notifyNativeCompactionFallback(
      ctx,
      state,
      branchEntries,
      runtime,
      "Responses compaction v2 produced details Pi could not store",
    );
    journalCodexForeground(pi, ctx, route, {
      event: "fallback",
      to: "local",
      reason: "malformed",
      noticeAttempted: true,
    });
    return undefined;
  }
}

/** Shown when the server rejected the `/compact` focus item and the compaction ran without it. */
export const CODEX_FOCUS_IGNORED_NOTICE =
  "Codex compaction ignored the /compact focus (server rejected it)";

/** Journal (and, when dropped, announce) what happened to `/compact <focus>`. */
function journalCompactionFocus(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionContext,
  route: LaneRoute,
  result: RemoteCompactionV2Result,
): void {
  if (result.focus === "forwarded") {
    // The focus went to the server with the compaction request; no lane changed.
    journalCodexForeground(pi, ctx, route, {
      event: "yield",
      to: "codex-foreground",
      reason: "instructions-forwarded",
      noticeAttempted: false,
    });
    return;
  }
  if (result.focus !== "ignored") return;
  ctx.ui.notify(CODEX_FOCUS_IGNORED_NOTICE, "warning");
  journalCodexForeground(pi, ctx, route, {
    event: "fallback",
    to: "codex-foreground",
    reason: "instructions-ignored",
    noticeAttempted: true,
  });
}

/**
 * Refuse a request whose replay is impossible, unless the user authorized
 * losing that checkpoint's history: then the request goes out with the
 * placeholder, and the loss is announced and journaled.
 */
function refuseOrLose(
  pi: Pick<ExtensionAPI, "appendEntry"> | undefined,
  ctx: ExtensionContext,
  entryId: string,
  refusal: { readonly message: string; readonly reason: LaneReason; readonly detail?: string },
): undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  if (lossAuthorizedFor(sessionId, entryId)) {
    ctx.ui.notify(
      `Codex checkpoint ${entryId} cannot be replayed; its history is dropped (loss authorized).`,
      "warning",
    );
    if (pi !== undefined)
      journalCodexForeground(pi, ctx, "replay", {
        event: "loss",
        reason: "loss",
        checkpointEntryId: entryId,
        noticeAttempted: true,
      });
    return undefined;
  }
  ctx.ui.notify(refusal.message, "error");
  if (pi !== undefined)
    journalCodexForeground(pi, ctx, "replay", {
      event: "refuse",
      reason: refusal.reason,
      checkpointEntryId: entryId,
      noticeAttempted: true,
      ...conditionalProperties(refusal.detail !== undefined, { detail: refusal.detail ?? "" }),
    });
  throw new CodexRequestRefusedError(refusal.message);
}

/**
 * Replay the latest native checkpoint into a normal request. A background
 * checkpoint is replayed only for the account that made it (any model id of
 * that account, the foreground lenient path); another account, or a replay
 * that cannot be rebuilt, refuses the request with
 * {@link CodexRequestRefusedError} unless its loss is authorized.
 * So does a newest opaque Codex checkpoint this runtime cannot replay at all
 * (another provider, api or endpoint, or no native runtime): it is never sent
 * as its placeholder summary.
 */
export async function rewriteCodexCompactedProviderRequest(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
  pi?: Pick<ExtensionAPI, "appendEntry">,
): Promise<BoundaryValue | undefined> {
  const plan = resolveCodexRuntimePlanForState(ctx, state);
  if (!plan.nativeCompaction || (!plan.effectiveOpenAICodex && !isResponsesContext(ctx)))
    return undefined;
  // Snapshot before the first await: the request belongs to the branch as it is now.
  const opaque = opaqueCheckpointOf(ctx.sessionManager.getBranch());
  const unreplayable = (detail: string): undefined =>
    opaque?.owner === "codex-native"
      ? refuseOrLose(pi, ctx, opaque.entryId, {
          message: OPAQUE_GUARD_NOTICE("codex", opaque.entryId),
          reason: "opaque-checkpoint",
          detail,
        })
      : undefined;
  const resolution = await resolveNativeCompactionEnvironment(
    ctx,
    { enabled: true, supportedProviders: getSupportedNativeCompactionProviders(state) },
    payload,
  );
  if (!resolution.ok) return unreplayable(resolution.reason);
  const runtime = resolution.runtime;
  const branchEntries = ctx.sessionManager.getBranch();
  const latestNativeCompactionIndex = findLatestNativeCompactionEntryIndex(branchEntries, {
    provider: runtime.provider,
    api: runtime.api,
    baseUrl: runtime.baseUrl,
  });
  if (latestNativeCompactionIndex === undefined) return unreplayable("endpoint");
  if (!runtime.payload) return unreplayable("payload");
  // SAFETY: findLatestNativeCompactionEntryIndex returns an in-bounds entry accepted by isNativeCompactionEntry.
  const compactionEntry = branchEntries[latestNativeCompactionIndex]! as NativeCompactionEntry;
  // An older checkpoint of this endpoint is not the newest opaque one: that one cannot be replayed here.
  if (opaque?.owner === "codex-native" && compactionEntry.id !== opaque.entryId)
    return unreplayable("endpoint");
  const accountScope = runtimeAccountScope(runtime);
  if (
    accountScope !== undefined &&
    !nativeCompactionEntryMatches(compactionEntry, { accountScope })
  )
    return refuseOrLose(pi, ctx, compactionEntry.id, {
      message: OPAQUE_GUARD_NOTICE("codex", compactionEntry.id),
      reason: "scope-mismatch",
      detail: "account",
    });
  const rewrite = rewriteResponsesPayloadWithNativeReplay({
    model: runtime.currentModel,
    payload: runtime.payload,
    branchEntries,
    compactionEntry,
    serializationOptions: isCodeModeRuntime(plan)
      ? { grammarToolInputProperties: CODE_MODE_EXEC_GRAMMAR_INPUTS }
      : undefined,
  });
  if (rewrite.ok) return rewrite.rewrittenPayload;
  const detail = rewrite.parity?.mismatches.slice(0, 3).join("; ");
  const message = `OpenAI native compaction replay failed (${rewrite.reason})${detail ? `: ${detail}` : ""}; request was not sent with placeholder compaction context.`;
  return refuseOrLose(pi, ctx, compactionEntry.id, {
    message,
    reason: "incompatible",
    detail: rewrite.reason,
  });
}

export async function injectPendingNativeWindowIntoPiCompactionRequest(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
): Promise<BoundaryValue | undefined> {
  const pending = state.pendingPiCompactionNativeWindow;
  if (!pending || pending.window.length === 0) return undefined;
  if (!isResponsesCompatiblePayload(payload)) return undefined;
  if (pending.sessionId !== ctx.sessionManager.getSessionId()) {
    state.pendingPiCompactionNativeWindow = undefined;
    return undefined;
  }
  if (!isPiCompactionSummarizationPayload(payload)) return undefined;

  const resolution = await resolveNativeCompactionEnvironment(
    ctx,
    { enabled: true, supportedProviders: getSupportedNativeCompactionProviders(state) },
    payload,
  );
  if (!resolution.ok) return undefined;
  const runtime = resolution.runtime;
  if (
    pending.provider !== runtime.provider ||
    pending.api !== runtime.api ||
    pending.baseUrl !== runtime.baseUrl
  ) {
    state.pendingPiCompactionNativeWindow = undefined;
    return undefined;
  }

  const input = [...payload.input];
  let insertAt = 0;
  while (insertAt < input.length) {
    const item = input[insertAt]!;
    if (!isRecord(item) || (item["role"] !== "system" && item["role"] !== "developer")) break;
    insertAt++;
  }

  state.pendingPiCompactionNativeWindow = undefined;
  return {
    ...payload,
    input: [
      ...input.slice(0, insertAt),
      ...pending.window.map((item) => structuredClone(item)),
      ...input.slice(insertAt),
    ],
  };
}
