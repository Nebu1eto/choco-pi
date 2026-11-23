import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimCodeModeHost, probeCodeModeHostOwner } from "@choco-pi/code-mode/host-slot";
import type { CodeModeRegistration } from "@choco-pi/code-mode/tools/code-mode/tools";
import { registerNativeFeatures } from "./native-features.ts";
import { registerCodeModeProxyProvider } from "../providers/code-mode-proxy-provider.ts";
import { registerOpenAICodexCustomProvider } from "../providers/openai-codex-provider-registration.ts";
import { registerApplyPatchDisplayBroker } from "@choco-pi/code-mode/tools/apply-patch/display-broker";
import { registerCodexCommand } from "../ui/settings/command.ts";
import { registerCodexCodeMode } from "@choco-pi/code-mode/adapter/code-mode";
import {
  prepareCodeModeHost,
  registerCanonicalAliasEndpointPreflight,
  registerCodexEvents,
} from "./events.ts";
import { createCodexExtensionRuntime } from "./runtime.ts";
import { registerCodexTools } from "./tools.ts";
import { registerCodexUi } from "./ui.ts";
import { registerCodexTransportCleanup } from "./transport-cleanup.ts";
import { registerNativeSteeringBridge } from "./native-steering-bridge.ts";
import { resolveCodexRuntimePlan } from "../adapter/activation/runtime-plan.ts";
import { captureActiveProviderSystemPrompt } from "../adapter/provider-prompt-capture.ts";
import { withLiveCtx } from "./live-context.ts";
import { createCodexCompactionEligibility } from "./compaction-eligibility.ts";
import { publishCodexCompactionConfigReaderIfVacant } from "./compaction-config-reader.ts";
import { assertCodexRequestAllowed } from "./background-compaction.ts";
import { registerCodexWebRunSearchAdapter } from "./search-adapter.ts";
import {
  createNativeCompactionBudgetHook,
  type NativeCompactionModelLookup,
  publishNativeCompactionBudgetHook,
} from "./native-compaction-budget.ts";

export const CODEX_PACKAGE_NAME = "choco-pi-codex";

/**
 * Stand-in for Code Mode when the standalone choco-pi-code-mode extension
 * loaded first and already owns it: that extension prepares, prompts and
 * shuts down its own host, so Codex must not drive it a second time.
 */
function standaloneOwnedCodeMode(): CodeModeRegistration {
  return {
    prepare: () => undefined,
    refreshPromptTools: (systemPrompt) => systemPrompt,
    checkpointNotebook: async () => {},
    shutdownHost: async () => {},
    shutdown: async () => {},
  };
}

function warnStandaloneCodeModeOwner(pi: ExtensionAPI): void {
  let warned = false;
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    withLiveCtx(() =>
      ctx.ui.notify(
        "choco-pi-code-mode loaded before choco-pi-codex, so Code Mode runs without the Codex ports. Load choco-pi-codex first (choco-pi self setup restores the order).",
        "warning",
      ),
    );
  });
}

export async function registerCodexConversion(pi: ExtensionAPI): Promise<void> {
  // Code Mode ownership on this Pi runtime: Codex composes it with its ports
  // unless the standalone choco-pi-code-mode extension loaded first and owns it.
  const codeModeOwner = probeCodeModeHostOwner(pi);
  const standaloneCodeMode = codeModeOwner?.kind === "standalone";
  const releaseCodeModeClaim = codeModeOwner
    ? () => {}
    : claimCodeModeHost(pi, { kind: "provider", name: CODEX_PACKAGE_NAME });
  if (standaloneCodeMode) warnStandaloneCodeModeOwner(pi);
  registerCodexTransportCleanup();
  registerNativeSteeringBridge();
  if (!standaloneCodeMode) registerApplyPatchDisplayBroker(pi);
  const runtime = createCodexExtensionRuntime(pi);
  // The budget follows the live adapter config, so a compaction-row change
  // (which also resets the transport below) applies on the consumer's next read.
  let findModel: NativeCompactionModelLookup | undefined;
  const budgetHook = createNativeCompactionBudgetHook({
    state: () => runtime.state,
    findModel: () => findModel,
  });
  let unpublishBudget: (() => void) | undefined = publishNativeCompactionBudgetHook(budgetHook);
  // Published once registration succeeds; withdrawn at shutdown, re-published at session start.
  let configReaderPublished = false;
  let unpublishConfigReader: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    const registry = ctx.modelRegistry;
    findModel = (provider, id) => registry.find(provider, id);
    unpublishBudget ??= publishNativeCompactionBudgetHook(budgetHook);
    if (configReaderPublished)
      unpublishConfigReader ??= publishCodexCompactionConfigReaderIfVacant();
  });
  pi.on("session_shutdown", () => {
    findModel = undefined;
    const unpublish = unpublishBudget;
    unpublishBudget = undefined;
    unpublish?.();
    const unpublishReader = unpublishConfigReader;
    unpublishConfigReader = undefined;
    unpublishReader?.();
  });
  const nativeFeatures = registerNativeFeatures(
    pi,
    () => runtime.state.config.openai.midTurnSteering,
    () => runtime.state.config.ui.steeringDeliveryStatus,
  );
  registerCanonicalAliasEndpointPreflight(pi, runtime);
  const searchAdapter = registerCodexWebRunSearchAdapter(pi, runtime);
  pi.on("session_shutdown", () => searchAdapter.unregister());
  let codeMode: CodeModeRegistration;
  try {
    codeMode = standaloneCodeMode
      ? standaloneOwnedCodeMode()
      : await registerCodexCodeMode(pi, runtime);
  } catch (error) {
    releaseCodeModeClaim();
    searchAdapter.unregister();
    unpublishBudget?.();
    throw error;
  }
  let cleanupProxyProvider: ReturnType<typeof registerCodeModeProxyProvider> | undefined;
  // Published once registered so the compaction host's ownership follows this
  // registration's live config; withdrawn at shutdown, re-published at session start.
  const eligibility = createCodexCompactionEligibility(() => runtime.state);
  try {
    registerOpenAICodexCustomProvider(pi, {
      getConfig: () => ({
        executionMode: runtime.state.executionMode,
        openai: runtime.state.config.openai,
        compaction: runtime.state.config.compaction,
      }),
      useResponsesLite: (model) =>
        resolveCodexRuntimePlan({ model }, runtime.state.config, runtime.state.executionMode)
          .transport === "responses-lite",
      turnState: runtime.state.codexTurnState,
      getDiagnostics: () => runtime.diagnosticsSink(),
      onPreparedPayload: (payload) => {
        // A request refused for an incompatible checkpoint fails here, before any network call.
        assertCodexRequestAllowed(payload);
        runtime.captureCacheKeepaliveRequest(payload);
        if (!runtime.state.pendingActiveProviderPromptCapture) return;
        captureActiveProviderSystemPrompt(payload, runtime.state);
        runtime.state.pendingActiveProviderPromptCapture = false;
      },
    });
    const proxyProvider = registerCodeModeProxyProvider(
      pi,
      () => runtime.state.config,
      () => runtime.state.executionMode,
    );
    cleanupProxyProvider = proxyProvider;
    const tools = registerCodexTools(pi, runtime, { coreTools: !standaloneCodeMode });
    const ui = registerCodexUi(pi, runtime);
    registerCodexCommand(pi, runtime.state, (config, ctx, previousConfig) => {
      // Compaction, scope, voice-only or tool-only switches change native-compaction ownership.
      eligibility.refresh();
      const executionModeChanged = config.executionMode !== previousConfig.executionMode;
      proxyProvider.applyConfig(config, ctx.modelRegistry);
      tools.applyConfig(config);
      ui.applyConfig(config, ctx, previousConfig);
      if (!config.ui.steeringDeliveryStatus) nativeFeatures.clearDeliveryStatus(ctx);
      if (config.openai.cacheDiagnostics !== previousConfig.openai.cacheDiagnostics) {
        void withLiveCtx(() =>
          runtime.configureDiagnostics(
            ctx,
            previousConfig.openai.cacheDiagnostics !== "status-and-log" &&
              config.openai.cacheDiagnostics === "status-and-log",
          ),
        );
      }
      if (config.openai.cacheKeepalive !== previousConfig.openai.cacheKeepalive) {
        runtime.cancelCacheKeepalive();
      }
      if (
        config.voiceFeaturesOnly !== previousConfig.voiceFeaturesOnly ||
        executionModeChanged ||
        config.prompt.heavySystemPromptOverwrite !==
          previousConfig.prompt.heavySystemPromptOverwrite ||
        config.openai.fast !== previousConfig.openai.fast ||
        config.compaction.responsesCompaction !== previousConfig.compaction.responsesCompaction
      ) {
        runtime.resetTransport(ctx.sessionManager.getSessionId());
      }
      if (config.voiceFeaturesOnly && !previousConfig.voiceFeaturesOnly) {
        void codeMode
          .shutdownHost()
          .catch((error) =>
            withLiveCtx(() =>
              ctx.ui.notify(
                `Could not stop Code Mode host: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              ),
            ),
          );
      } else if (executionModeChanged) {
        void codeMode
          .shutdownHost()
          .then(() => prepareCodeModeHost(codeMode, ctx))
          .catch((error) =>
            withLiveCtx(() =>
              ctx.ui.notify(
                `Could not switch execution mode: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              ),
            ),
          );
      }
    });
    registerCodexEvents(pi, runtime, tools, ui, codeMode, proxyProvider, eligibility);
    eligibility.publish();
    configReaderPublished = true;
    unpublishConfigReader = publishCodexCompactionConfigReaderIfVacant();
  } catch (registrationError) {
    releaseCodeModeClaim();
    configReaderPublished = false;
    unpublishConfigReader?.();
    unpublishConfigReader = undefined;
    eligibility.unpublish();
    searchAdapter.unregister();
    unpublishBudget?.();
    try {
      try {
        cleanupProxyProvider?.shutdown();
      } finally {
        await codeMode.shutdown();
      }
    } catch (shutdownError) {
      throw new AggregateError(
        [registrationError, shutdownError],
        "Codex conversion registration and Code Mode cleanup failed",
      );
    }
    throw registrationError;
  }
}
