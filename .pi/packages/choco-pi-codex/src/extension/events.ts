import { isBoundaryValue, type BoundaryValue } from "../adapter/runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

const CommandArgsSchema = Type.Object({ cmd: Type.String() });
const ToolCallOnlyAssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Object({ type: Type.Literal("toolCall") }), { minItems: 1 }),
});
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readEffectiveCodexConversionConfig } from "../adapter/activation/config-store.ts";
import { syncAdapter } from "../adapter/activation/activation.ts";
import {
  isAdapterRuntime,
  resolveCodexRuntimePlan,
  resolveCodexRuntimePlanForState,
} from "../adapter/activation/runtime-plan.ts";
import {
  isNativeCompactionDetails,
  NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
  NATIVE_COMPACTION_DISPLAY_TEXT,
  NATIVE_COMPACTION_STRATEGY,
  type NativeCompactionDisplayEntry,
  type NativeCompactionUsage,
} from "../adapter/compaction/types.ts";

import { isProviderContextExcludedMessage } from "../adapter/prompt/context-filter.ts";
import { hasNoSkillsFlag } from "../adapter/prompt/skills.ts";

import type { CodeModeProxyProviderRegistration } from "../providers/code-mode-proxy-provider.ts";
import { clearApplyPatchRenderState } from "../tools/apply-patch/render-state.ts";
import type { CodeModeRegistration } from "../tools/code-mode/tools.ts";
import { formatCompactionCacheDiagnostic } from "../adapter/compaction/diagnostics.ts";
import type { CodexExtensionRuntime } from "./runtime.ts";
import type { CodexToolRegistration } from "./tools.ts";
import type { CodexUiController } from "./ui.ts";
import { clearUsageLimitSignal } from "../providers/openai-codex/usage-limit-signal.ts";
import {
  CODEX_USAGE_LIMIT_ENTRY,
  type CodexUsageLimitEntry,
  isCodexErrorAssistantMessage,
  takeCodexUsageLimitEntry,
} from "./usage-limit-entry.ts";
import { withLiveCtx } from "./live-context.ts";
import type { CodexCompactionEligibility } from "./compaction-eligibility.ts";
import {
  createCodexBackgroundIntegration,
  recordCodexRequestDecision,
  registerCodexBackgroundFactory,
  updateCodexBackgroundElision,
  willAdoptCodexBackgroundCheckpoint,
  type CodexBackgroundElisionState,
} from "./background-compaction.ts";
import { registerCodexDaybreakProbe } from "./daybreak-probe.ts";
import { resetRegisteredToolCapture } from "../tools/code-mode/registered-tool-bridge.ts";
import { isNativeSteerPending } from "../providers/openai-codex/native-steering.ts";
import { initializeCodexFastModeDefault } from "../providers/openai-codex/fast-mode-decision.ts";
import {
  assignTurnOrdinals,
  computeCut,
  eligibleToolResultChars,
  elideToolResults,
} from "./context-elision.ts";

const CONTEXT_ELISION_ENTRY = "codex-context-elision";
const ContextElisionEntrySchema = Type.Object({
  epoch: Type.String(),
  cut: Type.Integer({ minimum: 0 }),
});

function memoizedImport<Module>(loader: () => Promise<Module>): () => Promise<Module> {
  let promise: Promise<Module> | undefined;
  return () => (promise ??= loader());
}

const loadBash = memoizedImport(() => import("../shell/bash.ts"));
const loadCompaction = memoizedImport(() => import("../adapter/compaction/compaction.ts"));
const loadCompactionDetails = memoizedImport(
  () => import("../adapter/compaction/details-store.ts"),
);
const loadLocalVersionWarning = memoizedImport(() => import("../adapter/local-version-warning.ts"));
const loadPromptBuilder = memoizedImport(() => import("../prompt/build-system-prompt.ts"));
const loadProviderRequest = memoizedImport(() => import("../adapter/provider-request.ts"));

function formatCompactionUsage(usage: NativeCompactionUsage): string {
  const ratio =
    usage.inputTokens > 0
      ? `${((usage.cachedInputTokens / usage.inputTokens) * 100).toFixed(1)}%`
      : "0%";
  const tokens = (value: number) => Math.round(value).toLocaleString("en-US");
  const diagnostic = formatCompactionCacheDiagnostic(usage, usage.diagnostic);
  return `Compaction V2 · input ${tokens(usage.inputTokens)} · cache read ${tokens(usage.cachedInputTokens)} (${ratio}) · cache write ${tokens(usage.cacheWriteInputTokens)} · output ${tokens(usage.outputTokens)}${diagnostic ? ` ${diagnostic}` : ""}`;
}

function commandArg(args: BoundaryValue): string | undefined {
  return Value.Check(CommandArgsSchema, args) ? args.cmd : undefined;
}

function isToolCallOnlyAssistantMessage(message: BoundaryValue): boolean {
  return Value.Check(ToolCallOnlyAssistantMessageSchema, message);
}

function isAbortError(error: Error | BoundaryValue): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "ABORT_ERR" ||
      ("code" in error && error.code === "ABORT_ERR"))
  );
}

export function prepareCodeModeHost(codeMode: CodeModeRegistration, ctx: ExtensionContext): void {
  const preparation = withLiveCtx(() => codeMode.prepare(ctx));
  if (!preparation) return;
  void preparation.catch((error) => {
    if (isAbortError(error)) return;
    withLiveCtx(() =>
      ctx.ui.notify(
        `Code Mode host setup failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      ),
    );
  });
}

export function registerCanonicalAliasEndpointPreflight(
  pi: ExtensionAPI,
  runtime: CodexExtensionRuntime,
): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    const { state } = runtime;
    if (!isAdapterRuntime(resolveCodexRuntimePlan(ctx, state.config, state.executionMode))) {
      state.canonicalAliasEndpoint = undefined;
      return;
    }
    const { prepareCanonicalAliasEndpoint } = await loadProviderRequest();
    await prepareCanonicalAliasEndpoint(ctx, state);
    syncAdapter(pi, ctx, state);
  });
}

export function registerSessionReplacementEvents(
  pi: ExtensionAPI,
  runtime: Pick<CodexExtensionRuntime, "cancelCacheKeepalive">,
): void {
  // A later handler may cancel the replacement, or it may fail before teardown; session_shutdown
  // owns background teardown so a surviving instance keeps its current generation.
  pi.on("session_before_switch", (_event, ctx) => {
    runtime.cancelCacheKeepalive();
    resetRegisteredToolCapture(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    runtime.cancelCacheKeepalive();
    resetRegisteredToolCapture(ctx);
  });
}

export function handleCodexAgentSettled(
  runtime: Pick<CodexExtensionRuntime, "armCacheKeepalive" | "state">,
  ui: Pick<CodexUiController, "refreshUsageStatus">,
  ctx: ExtensionContext,
): void {
  const { state } = runtime;
  state.pendingActiveProviderPromptCapture = false;
  state.voiceSystemPromptOverride = undefined;
  state.codexTurnState.reset();
  const hasUI = withLiveCtx(() => ctx.hasUI);
  if (hasUI === undefined) return;
  if (hasUI && !state.config.voiceFeaturesOnly) {
    void withLiveCtx(() => ui.refreshUsageStatus(ctx));
  }
  runtime.armCacheKeepalive(ctx);
}

export function registerCodexEvents(
  pi: ExtensionAPI,
  runtime: CodexExtensionRuntime,
  tools: CodexToolRegistration,
  ui: CodexUiController,
  codeMode: CodeModeRegistration,
  proxyProvider: CodeModeProxyProviderRegistration,
  eligibility?: CodexCompactionEligibility,
): void {
  registerCodexDaybreakProbe(pi);
  const { state, tracker, sessions } = runtime;
  // The host settings gate excludes this registry entry while native background compaction is off.
  registerCodexBackgroundFactory(true);
  const elisionStates = new Map<string, CodexBackgroundElisionState>();
  const elisionFor = (sessionId: string): CodexBackgroundElisionState => {
    let elision = elisionStates.get(sessionId);
    if (elision === undefined) {
      elision = { epoch: "", cut: 0 };
      elisionStates.set(sessionId, elision);
    }
    return elision;
  };
  const background = createCodexBackgroundIntegration({
    state,
    onInstalled: (sessionId, epoch) =>
      updateCodexBackgroundElision(elisionStates, sessionId, epoch),
    openaiServerSide: () => state.config.compaction.responsesCompaction,
    userMessageRetentionTokens: () => state.config.compaction.v2UserMessageRetention * 1_000,
    append: (customType, data) => pi.appendEntry(customType, data),
  });
  // The derived default lanes read the OpenAI row: re-resolve after it changed.
  eligibility?.onChange(() => background.invalidateSettings());
  const restoreElision = (ctx: ExtensionContext): void => {
    const elision = elisionFor(ctx.sessionManager.getSessionId());
    const branch = ctx.sessionManager.getBranch();
    elision.epoch = branch.findLast((entry) => entry.type === "compaction")?.id ?? "";
    elision.cut = 0;
    for (const entry of branch) {
      if (
        entry.type === "custom" &&
        entry.customType === CONTEXT_ELISION_ENTRY &&
        Value.Check(ContextElisionEntrySchema, entry.data) &&
        entry.data.epoch === elision.epoch
      )
        elision.cut = Math.max(elision.cut, entry.data.cut);
    }
  };
  sessions.onSessionExit((sessionId) => tracker.recordSessionFinished(sessionId));
  registerSessionReplacementEvents(pi, runtime);
  /** Rebind background compaction for the generation begin() returned; false once superseded. */
  const refreshBackground = async (
    ctx: ExtensionContext,
    ownerGeneration: number,
  ): Promise<boolean> => {
    await background.refresh(ctx, ownerGeneration);
    return background.isGenerationCurrent(ownerGeneration);
  };
  /** Shared activation tail; false when voice-only or superseded, so no host prep follows. */
  const activateAdapter = async (
    ctx: ExtensionContext,
    ownerGeneration: number,
  ): Promise<boolean> => {
    const voiceFeaturesOnly = state.config.voiceFeaturesOnly;
    tools.ensureOptionalTools();
    syncAdapter(pi, ctx, state);
    await runtime.configureDiagnostics(ctx);
    if (voiceFeaturesOnly || !background.isGenerationCurrent(ownerGeneration)) return false;
    void withLiveCtx(() => ui.refreshUsageStatus(ctx));
    prepareCodeModeHost(codeMode, ctx);
    if (!state.config.prompt.heavySystemPromptOverwrite)
      void withLiveCtx(() =>
        runtime.startPrewarm(ctx, codeMode.refreshPromptTools(ctx.getSystemPrompt(), ctx)),
      );
    return true;
  };

  pi.on("session_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const ownerGeneration = background.begin(ctx);
    restoreElision(ctx);
    ui.invalidateUsageStatus();
    const [{ initializeBashParser }, { extractPiPromptSkills }, { maybeWarnLocalCheckoutVersion }] =
      await Promise.all([loadBash(), loadPromptBuilder(), loadLocalVersionWarning()]);
    if (!background.isGenerationCurrent(ownerGeneration)) return;
    initializeBashParser();
    runtime.resetTransport(sessionId);
    state.cwd = ctx.cwd;
    state.config = readEffectiveCodexConversionConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    initializeCodexFastModeDefault(sessionId, state.config.openai.fast === true);
    state.weeklyUsageLeft = undefined;
    state.executionMode = state.config.executionMode;
    state.activeProviderSystemPrompt = undefined;
    state.voiceSystemPromptOverride = undefined;
    state.canonicalAliasEndpoint = undefined;
    eligibility?.publish();
    eligibility?.refresh();
    proxyProvider.applyConfig(state.config, ctx.modelRegistry);
    state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());
    if (!(await refreshBackground(ctx, ownerGeneration))) return;
    if (!state.config.voiceFeaturesOnly) {
      sessions.setBaseEnv(runtime.execEnv());
      tracker.clear();
    }
    clearApplyPatchRenderState();
    const activated = await activateAdapter(ctx, ownerGeneration);
    if (activated && event.reason === "startup") await maybeWarnLocalCheckoutVersion(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const ownerGeneration = background.begin(ctx);
    const { extractPiPromptSkills } = await loadPromptBuilder();
    if (!background.isGenerationCurrent(ownerGeneration)) return;
    ui.invalidateUsageStatus();
    runtime.resetTransport(sessionId);
    state.cwd = ctx.cwd;
    state.activeProviderSystemPrompt = undefined;
    state.voiceSystemPromptOverride = undefined;
    state.canonicalAliasEndpoint = undefined;
    state.weeklyUsageLeft = undefined;
    state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());
    proxyProvider.applyConfig(state.config, ctx.modelRegistry);
    if (!(await refreshBackground(ctx, ownerGeneration))) return;
    await activateAdapter(ctx, ownerGeneration);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const ownerGeneration = background.begin(ctx);
    restoreElision(ctx);
    state.activeProviderSystemPrompt = undefined;
    state.voiceSystemPromptOverride = undefined;
    runtime.resetTransport(sessionId);
    await codeMode.shutdownHost();
    if (!background.isGenerationCurrent(ownerGeneration)) return;
    if (!(await refreshBackground(ctx, ownerGeneration))) return;
    proxyProvider.applyConfig(state.config, ctx.modelRegistry);
    syncAdapter(pi, ctx, state);
    prepareCodeModeHost(codeMode, ctx);
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "toolResult" && !isToolCallOnlyAssistantMessage(event.message))
      tracker.resetExplorationGroup();
  });
  pi.on("tool_execution_start", async (event) => {
    // Calls a tool makes through ctx.executeTool() run inside the caller's group.
    if (event.parentToolCallId !== undefined) return;
    if (event.toolName !== "exec_command") {
      tracker.resetExplorationGroup();
      return;
    }
    const command = commandArg(event.args);
    if (command) tracker.recordStart(event.toolCallId, command);
  });
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "exec_command") tracker.recordEnd(event.toolCallId);
  });
  pi.on("message_end", (event, ctx) => {
    if (!isCodexErrorAssistantMessage(event.message)) return;
    // The host passes `sessionManager.getSessionId()` as the provider's stream `sessionId`.
    const entry = takeCodexUsageLimitEntry(event.message, ctx.sessionManager.getSessionId());
    if (entry) pi.appendEntry<CodexUsageLimitEntry>(CODEX_USAGE_LIMIT_ENTRY, entry);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    clearUsageLimitSignal(ctx.sessionManager.getSessionId());
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    background.stop(sessionId);
    eligibility?.unpublish();
    elisionStates.delete(sessionId);
    runtime.cancelCacheKeepalive();
    resetRegisteredToolCapture(ctx);
    clearUsageLimitSignal(ctx.sessionManager.getSessionId());
    const failures: BoundaryValue[] = [];
    await runShutdownStep(failures, () => runtime.shutdownTransport(sessionId));
    await runShutdownStep(failures, () => runtime.shutdownDiagnostics());
    await runShutdownStep(failures, () => sessions.shutdown());
    await runShutdownStep(failures, () => proxyProvider.shutdown());
    await runShutdownStep(failures, () => codeMode.shutdown());
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Codex extension shutdown failed");
  });
  pi.on("input", async (event) => {
    if (event.streamingBehavior === undefined) state.codexTurnState.beginTurn();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = event.systemPrompt;
    state.voiceSystemPromptOverride = undefined;
    if (!isAdapterRuntime(resolveCodexRuntimePlanForState(ctx, state))) {
      state.activeProviderSystemPrompt = undefined;
      state.pendingActiveProviderPromptCapture = false;
      return undefined;
    }
    const { resolvePromptSkills } = await loadPromptBuilder();
    const skills = resolvePromptSkills(
      event.systemPromptOptions?.skills,
      hasNoSkillsFlag() ? [] : state.promptSkills,
    );
    const codexSystemPrompt = runtime.codexSystemPrompt(
      systemPrompt,
      ctx,
      skills,
      event.systemPromptOptions,
    );
    state.activeProviderSystemPrompt = codexSystemPrompt;
    state.pendingActiveProviderPromptCapture = true;
    await runtime.waitForPrewarm(ctx, codexSystemPrompt);
    return {
      systemPrompt: codexSystemPrompt,
    };
  });
  pi.on("agent_start", async () => {
    runtime.cancelCacheKeepalive();
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!isAdapterRuntime(resolveCodexRuntimePlan(ctx, state.config, state.executionMode))) return;
    if (isNativeSteerPending(ctx.sessionManager.getSessionId())) return;
    const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages.filter(
      (message) => !isProviderContextExcludedMessage(message),
    );
    const elision = elisionFor(ctx.sessionManager.getSessionId());
    const cut = computeCut({
      ordinal: assignTurnOrdinals(messages),
      priorCut: elision.cut,
      eligibleChars: messages.map(eligibleToolResultChars),
    });
    if (cut === elision.cut) return;
    pi.appendEntry(CONTEXT_ELISION_ENTRY, { epoch: elision.epoch, cut });
    elision.cut = cut;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    handleCodexAgentSettled(runtime, ui, ctx);
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const fence = background.fence(sessionId);
    state.cwd = ctx.cwd;
    // Each request decides afresh; a refusal is enforced by the Codex transport.
    recordCodexRequestDecision(sessionId, undefined);
    // Picks up a canonical-alias trust the endpoint preflight settled.
    eligibility?.refresh();
    if (!isBoundaryValue(event.payload)) return undefined;
    await background.refresh(ctx, fence.generation);
    if (background.isStale(fence)) return undefined;
    const refusal = background.requestRefusal(ctx, sessionId);
    if (refusal !== undefined) {
      recordCodexRequestDecision(sessionId, refusal);
      return undefined;
    }
    const { rewriteCodexProviderRequest, CodexRequestRefusedError } = await loadProviderRequest();
    if (background.isStale(fence)) return undefined;
    const requestState = background.requestState(state, sessionId);
    let rewritten: Awaited<ReturnType<typeof rewriteCodexProviderRequest>>;
    try {
      rewritten = await rewriteCodexProviderRequest(event.payload, ctx, requestState, pi);
    } catch (cause) {
      if (!(cause instanceof CodexRequestRefusedError)) throw cause;
      recordCodexRequestDecision(sessionId, cause.message);
      return undefined;
    }
    if (background.isStale(fence)) return undefined;
    if (requestState !== state)
      state.activeProviderSystemPrompt = requestState.activeProviderSystemPrompt;
    return rewritten;
  });
  pi.on("before_provider_headers", async (event, ctx) => {
    const { rewriteCodexProviderHeaders } = await loadProviderRequest();
    rewriteCodexProviderHeaders(event.headers, ctx, state);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const fence = background.fence(sessionId);
    state.cwd = ctx.cwd;
    if (!resolveCodexRuntimePlanForState(ctx, state).nativeCompaction) {
      background.journalOpaqueTrap(ctx, event);
      return undefined;
    }
    const adopting = await willAdoptCodexBackgroundCheckpoint(sessionId, event);
    if (background.isStale(fence) || adopting) return undefined;
    const refusal = background.compactionRefusal(ctx, sessionId, event);
    if (refusal !== undefined) {
      ctx.ui.notify(refusal, "error");
      return { cancel: true };
    }
    // Loss authorized: the host path compacts without the checkpoint's history.
    if (background.requestState(state, sessionId) !== state) return undefined;
    const { handleCodexSessionBeforeCompact } = await loadCompaction();
    if (background.isStale(fence)) return undefined;
    return handleCodexSessionBeforeCompact(event, ctx, state, pi);
  });
  pi.on("session_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const fence = background.fence(sessionId);
    updateCodexBackgroundElision(elisionStates, sessionId, event.compactionEntry.id);
    background.invalidateReplay(sessionId);
    state.pendingPiCompactionNativeWindow = undefined;
    let nativeCompaction = false;
    const { findLatestCompactionEntry } = await loadCompactionDetails();
    if (background.isStale(fence)) return;
    const compactionEntry = findLatestCompactionEntry(ctx.sessionManager.getBranch());
    if (
      event.fromExtension &&
      compactionEntry &&
      isBoundaryValue(compactionEntry.details) &&
      isNativeCompactionDetails(compactionEntry.details)
    ) {
      const details = compactionEntry.details;
      nativeCompaction = true;
      // Presentation entries persist and render without entering Pi's turn queue or LLM context.
      pi.appendEntry<NativeCompactionDisplayEntry>(NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, {
        content: NATIVE_COMPACTION_DISPLAY_TEXT,
        compactionEntryId: compactionEntry.id,
      });
      if (details.strategy === NATIVE_COMPACTION_STRATEGY && details.usage) {
        pi.appendEntry<NativeCompactionDisplayEntry>(NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, {
          content: formatCompactionUsage(details.usage),
          compactionEntryId: compactionEntry.id,
          kind: "usage",
        });
      }
    }
    const postCompactionPrompt = codeMode.refreshPromptTools(
      state.activeProviderSystemPrompt ?? ctx.getSystemPrompt(),
      ctx,
    );
    state.activeProviderSystemPrompt = postCompactionPrompt;
    runtime.resetTransportAfterCompaction(sessionId);
    await background.refresh(ctx, fence.generation);
    if (background.isStale(fence)) return;
    await (nativeCompaction
      ? runtime.startCompactionPrewarm(ctx)
      : runtime.startPrewarm(ctx, postCompactionPrompt, true));
  });
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter((message) => !isProviderContextExcludedMessage(message));
    const elision = elisionFor(ctx.sessionManager.getSessionId());
    if (
      elision.cut > 0 &&
      isAdapterRuntime(resolveCodexRuntimePlan(ctx, state.config, state.executionMode))
    )
      return { messages: elideToolResults(messages, elision.cut) };
    return { messages };
  });
}

async function runShutdownStep(
  failures: BoundaryValue[],
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(error instanceof Error ? error : String(error));
  }
}
