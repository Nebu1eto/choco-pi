import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  extractExplicitNamespace,
  extractExplicitSessionName,
  getAgentBrowserSessionIdentityKey,
  isAgentBrowserSessionIdentityKeyInNamespace,
  resolveAgentBrowserNamespace,
} from "../argv-grammar.ts";
import { parseArgvDescriptor } from "../argv-descriptor.ts";
import { getSuccessfulBatchCloseLifecycle } from "../batch-lifecycle.ts";
import { needsManagedSession } from "../command-policy.ts";
import {
  isCloseCommand,
  isOpenNavigationCommand,
  isRecordPageTransitionCommand,
  isUnverifiedPageTransitionCommand,
} from "../command-taxonomy.ts";
import type { AgentBrowserCompatibilityProfile } from "../compatibility-contract.ts";
import {
  getAgentBrowserExecutableFingerprintKey,
  resolveAgentBrowserExecutable,
} from "../executable-resolution.ts";
import type { AGENT_BROWSER_HOST_PARAMS } from "../input-modes/params.ts";
import {
  AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
  AGENT_BROWSER_SCRIPT_NAMESPACE,
  createAgentBrowserScriptSessionName,
  runAgentBrowserScript,
  type AgentBrowserScriptRunResult,
} from "../input-modes/script.ts";
import {
  getSessionContextKey,
  runAgentBrowserTool,
  type AgentBrowserToolResult,
  type BrowserRunState,
} from "../orchestration/browser-run/index.ts";
import {
  ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
  ELECTRON_PROFILE_ISOLATION_DETAILS,
  handleElectronHostInput,
} from "../orchestration/electron-host/index.ts";
import {
  buildValidationFailureResult,
  resolveAgentBrowserInput,
} from "../orchestration/input-plan.ts";
import {
  applyAgentBrowserOutputPath,
  getAgentBrowserOutputPathValidationError,
} from "../orchestration/output-file.ts";
import {
  appendScriptSessionLease,
  buildScriptBrowserEnvelope,
  buildScriptToolResult,
} from "../orchestration/script-mode.ts";
import { hasRuntimeType, isRecord } from "../parsing.ts";
import {
  hasAgentBrowserExecutableContext,
  runAgentBrowserProcess,
  withAgentBrowserExecutableContext,
} from "../process.ts";
import {
  getAgentBrowserProcessEnvironment,
  withIsolatedAgentBrowserEnvironment,
} from "../process-environment.ts";
import { buildPromptPolicy, getLatestUserPrompt } from "../prompt-policy.ts";
import { formatSessionArtifactRetentionSummary } from "../results/artifact-manifest.ts";
import {
  createFreshSessionName,
  extractUpstreamCommandTokens,
  isPlainTextInspectionArgs,
} from "../runtime.ts";
import { getCurrentToolCallAdmission } from "../tool-call-admission.ts";
import { preflightWebMcpParams } from "../webmcp-policy.ts";
import {
  commandClosesAllSessions,
  commandTouchesArtifactLifecycle,
  getArtifactCommandSteps,
  getArtifactPreflightValidationError,
  getRecordingDestinationPreflightError,
  mergeBrowserRunArtifactManifest,
  mergeBrowserRunMap,
  resultReportsNoRecordingInProgress,
} from "./artifacts.ts";
import { deleteIdentityKeysInNamespace, isAttachedBrowserInvocation } from "./branch-restore.ts";
import {
  getOptionValue,
  getUnsupportedCapabilityError,
  getWebMcpOwner,
  isAbortSignalAborted,
} from "./compatibility.ts";
import {
  getCleanupResultsClosedManagedSessionIdentities,
  getElectronHostLaunchRecordsForInput,
  getTouchedElectronLaunchIds,
  isElectronLaunchRecord,
  mergeActiveElectronLaunchRecords,
  mergeElectronCleanupRecords,
  replaceWithActiveElectronLaunchRecords,
  shouldSerializeBrowserCommand,
  shouldSerializeElectronHostInput,
  syncElectronCleanupManagedSessions,
  syncOwnedManagedSessionsFromResult,
  trackOwnedManagedSession,
  untrackOwnedManagedSession,
} from "./managed-resources.ts";
import {
  appendActiveRecordingCleanupAction,
  clearSessionScopedBrowserState,
  closeScriptSessionLeaseWithinQueue,
  inspectUpstreamVersion,
  retireRecordingSession,
  syncRecordingReservationsFromResult,
  type ExtensionRuntimeState,
} from "./state.ts";

type AgentBrowserExecute = ToolDefinition<typeof AGENT_BROWSER_HOST_PARAMS>["execute"];
type AgentBrowserExecuteParams = Parameters<AgentBrowserExecute>[1];
type AgentBrowserOnUpdate = Parameters<AgentBrowserExecute>[3];
type AgentBrowserExecuteContext = Parameters<AgentBrowserExecute>[4];

export async function executeAgentBrowserTool(
  state: ExtensionRuntimeState,
  executeSelf: AgentBrowserExecute,
  toolCallId: string,
  params: AgentBrowserExecuteParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentBrowserOnUpdate,
  ctx: AgentBrowserExecuteContext,
): Promise<AgentBrowserToolResult> {
  // The executable-resolution re-entry below inherits this turn through async context.
  const admission = getCurrentToolCallAdmission();
  const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
  const outputPath =
    isRecord(params) && hasRuntimeType(params.output_path, "string")
      ? params.output_path
      : undefined;
  const resolvedInput = resolveAgentBrowserInput({
    getBatchPreflightValidationError: (args, stdin) =>
      getArtifactPreflightValidationError({ args, cwd: ctx.cwd, outputPath, stdin }),
    managedSessionActive: state.managedSessionActive,
    params,
  });
  if (resolvedInput.status === "invalid") {
    return buildValidationFailureResult(resolvedInput);
  }
  const outputPathValidationError = getAgentBrowserOutputPathValidationError(outputPath, ctx.cwd);
  if (outputPathValidationError) {
    return buildValidationFailureResult({
      attemptedKind: resolvedInput.kind,
      kind: "invalid",
      redactedArgs: resolvedInput.redactedArgs,
      status: "invalid",
      toolArgs: resolvedInput.toolArgs,
      toolStdin: resolvedInput.toolStdin,
      validationError: outputPathValidationError,
    });
  }
  const nestedSafetySteps = getArtifactCommandSteps(
    resolvedInput.toolArgs,
    resolvedInput.toolStdin,
  );
  if (nestedSafetySteps.batch) {
    const unsafeNestedStep = nestedSafetySteps.steps.find((step) => {
      const command = extractUpstreamCommandTokens(step);
      return (command[0] === "snapshot" && command.includes("--delta")) || command[0] === "webmcp";
    });
    if (unsafeNestedStep)
      return buildValidationFailureResult({
        attemptedKind: resolvedInput.kind,
        kind: "invalid",
        redactedArgs: resolvedInput.redactedArgs,
        status: "invalid",
        toolArgs: resolvedInput.toolArgs,
        toolStdin: resolvedInput.toolStdin,
        validationError:
          "Nested batch snapshot --delta and WebMCP operations require standalone calls so revision identity, params preflight, action policy, and detached invocation ownership can be enforced before execution.",
      });
  }
  const recordingPreflightGeneration = state.branchStateGeneration;
  const recordingDestinationError = await getRecordingDestinationPreflightError({
    activeRecordingReservations: state.activeRecordingReservations.values(),
    args: resolvedInput.toolArgs,
    cwd: ctx.cwd,
    outputPath,
    stdin: resolvedInput.toolStdin,
  });
  if (recordingPreflightGeneration !== state.branchStateGeneration)
    return buildValidationFailureResult({
      attemptedKind: resolvedInput.kind,
      kind: "invalid",
      redactedArgs: resolvedInput.redactedArgs,
      status: "invalid",
      toolArgs: resolvedInput.toolArgs,
      toolStdin: resolvedInput.toolStdin,
      validationError:
        "Browser session ownership changed while recording destinations were checked; retry once with current state.",
    });
  if (recordingDestinationError)
    return buildValidationFailureResult({
      attemptedKind: resolvedInput.kind,
      kind: "invalid",
      redactedArgs: resolvedInput.redactedArgs,
      status: "invalid",
      toolArgs: resolvedInput.toolArgs,
      toolStdin: resolvedInput.toolStdin,
      validationError: recordingDestinationError,
    });
  const applyUnserializedOutputPath = async (
    result: AgentBrowserToolResult,
    preserveTextContent = false,
  ): Promise<AgentBrowserToolResult> => {
    if (
      !outputPath ||
      result.isError === true ||
      (isRecord(result.details) && result.details.resultCategory === "failure")
    )
      return result;
    return state.artifactExecutionQueue.run(async () => {
      const reservationError = getArtifactPreflightValidationError({
        activeRecordingReservations: state.activeRecordingReservations.values(),
        args: [],
        cwd: ctx.cwd,
        outputPath,
      });
      if (reservationError) {
        return buildValidationFailureResult({
          attemptedKind: resolvedInput.kind,
          kind: "invalid",
          redactedArgs: resolvedInput.redactedArgs,
          status: "invalid",
          toolArgs: resolvedInput.toolArgs,
          toolStdin: resolvedInput.toolStdin,
          validationError: reservationError,
        });
      }
      return applyAgentBrowserOutputPath({
        cwd: ctx.cwd,
        outputPath,
        preserveTextContent,
        result,
      });
    });
  };
  const versionCheckCommand = extractUpstreamCommandTokens(resolvedInput.toolArgs)[0];
  const electronHostOnlyAction =
    resolvedInput.kind === "electron" &&
    ["cleanup", "list", "status"].includes(resolvedInput.compiledElectron.action);
  const browserBackedVersionCheck = needsManagedSession(
    parseArgvDescriptor(resolvedInput.toolArgs),
  );
  if (
    !electronHostOnlyAction &&
    browserBackedVersionCheck &&
    !hasAgentBrowserExecutableContext() &&
    signal?.aborted !== true
  ) {
    const processEnvironment = getAgentBrowserProcessEnvironment();
    const executable = await resolveAgentBrowserExecutable({
      cwd: ctx.cwd,
      path: processEnvironment.PATH ?? processEnvironment.Path,
      pathExt: processEnvironment.PATHEXT,
    });
    const executionAborted = isAbortSignalAborted(signal);
    if (executable && !executionAborted) {
      return withAgentBrowserExecutableContext(executable, () =>
        executeSelf(toolCallId, params, signal, onUpdate, ctx),
      );
    }
  }
  let compatibilityWarnings: readonly string[] = [];
  let compatibilityProfile: AgentBrowserCompatibilityProfile | undefined;
  if (
    !electronHostOnlyAction &&
    browserBackedVersionCheck &&
    !isPlainTextInspectionArgs(resolvedInput.toolArgs) &&
    !isCloseCommand(versionCheckCommand) &&
    signal?.aborted !== true
  ) {
    const inspection =
      resolvedInput.kind === "script"
        ? await withIsolatedAgentBrowserEnvironment(() =>
            inspectUpstreamVersion(state, ctx.cwd, signal),
          )
        : await inspectUpstreamVersion(state, ctx.cwd, signal);
    compatibilityWarnings = inspection.warnings;
    compatibilityProfile = inspection.profile;
  }
  const appendCompatibilityWarnings = (result: AgentBrowserToolResult): AgentBrowserToolResult => {
    if (compatibilityWarnings.length === 0) return result;
    if (compatibilityProfile?.executable)
      state.warnedUpstreamFingerprints.add(
        getAgentBrowserExecutableFingerprintKey(compatibilityProfile.executable),
      );
    const details = isRecord(result.details) ? result.details : {};
    return {
      ...result,
      content: [
        ...result.content,
        ...compatibilityWarnings.map((warning) => ({ type: "text" as const, text: warning })),
      ],
      details: { ...details, compatibilityWarnings: [...compatibilityWarnings] },
    };
  };
  const unsupportedCapabilityError = getUnsupportedCapabilityError(
    compatibilityProfile,
    resolvedInput.toolArgs,
    resolvedInput.toolStdin,
  );
  if (unsupportedCapabilityError)
    return appendCompatibilityWarnings(
      buildValidationFailureResult({
        attemptedKind: resolvedInput.kind,
        kind: "invalid",
        redactedArgs: resolvedInput.redactedArgs,
        status: "invalid",
        toolArgs: resolvedInput.toolArgs,
        toolStdin: resolvedInput.toolStdin,
        validationError: unsupportedCapabilityError,
      }),
    );
  if (resolvedInput.kind === "script") {
    // Script calls use their own isolated session and take their own turns, so this
    // outer call must not hold its turn while they wait behind it.
    admission?.release();
    if (!ctx.sessionManager.getSessionFile()) {
      return buildValidationFailureResult({
        attemptedKind: "script",
        kind: "invalid",
        redactedArgs: [],
        status: "invalid",
        toolArgs: [],
        validationError:
          "script requires a persisted Pi session so its isolated browser-session cleanup lease survives restart; relaunch Pi without --no-session.",
      });
    }
    const sessionName = createAgentBrowserScriptSessionName();
    const innerResults: AgentBrowserToolResult[] = [];
    const scriptTimeoutMs = params.timeout_ms ?? AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + scriptTimeoutMs;
    let leased = false;
    let cleanupError: string | undefined;
    let run: AgentBrowserScriptRunResult = {
      callCount: 0,
      emitCount: 0,
      error: "Script sandbox execution failed.",
      failureCategory: "upstream-error",
      ok: false,
      rejectedCallCount: 0,
      steps: [],
    };
    const scriptController = new AbortController();
    const abortScript = () => scriptController.abort();
    signal?.addEventListener("abort", abortScript, { once: true });
    if (signal?.aborted) scriptController.abort();
    state.activeScriptControllers.add(scriptController);
    let finishScriptExecution!: () => void;
    const scriptExecution = new Promise<void>((resolve) => {
      finishScriptExecution = resolve;
    });
    state.activeScriptExecutions.add(scriptExecution);
    try {
      const pendingRun = runAgentBrowserScript({
        beforeFirstCall() {
          appendScriptSessionLease(state.pi, sessionName, "active");
          trackOwnedManagedSession(state.ownedManagedSessions, sessionName, ctx.cwd, {
            namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
          });
          state.managedSessionRestoreState.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
          leased = true;
        },
        code: resolvedInput.compiledScript.code,
        dispatch: async (innerParams, innerSignal) => {
          const remainingMs = Math.max(1, deadline - Date.now());
          const innerTimeoutMs = Math.min(innerParams.timeoutMs ?? remainingMs, remainingMs);
          const runInnerCall = () =>
            withIsolatedAgentBrowserEnvironment(() =>
              executeSelf(
                `${toolCallId}:script:${innerResults.length + 1}`,
                {
                  args: [
                    "--namespace",
                    AGENT_BROWSER_SCRIPT_NAMESPACE,
                    "--session",
                    sessionName,
                    ...innerParams.args,
                  ],
                  stdin: innerParams.stdin,
                  timeout_ms: innerTimeoutMs,
                },
                innerSignal,
                undefined,
                ctx,
              ),
            );
          const innerResult: AgentBrowserToolResult = admission
            ? await admission.gate.run(runInnerCall)
            : await runInnerCall();
          innerResults.push(innerResult);
          return await buildScriptBrowserEnvelope(innerResult, innerParams.args, sessionName);
        },
        signal: scriptController.signal,
        timeoutMs: scriptTimeoutMs,
      });
      run = await pendingRun;
    } catch {
      // Script runner failures surface through the initialized fallback run result.
    } finally {
      state.activeScriptControllers.delete(scriptController);
      signal?.removeEventListener("abort", abortScript);
      if (leased) {
        try {
          cleanupError = await state.artifactExecutionQueue.run(() =>
            state.managedSessionExecutionQueue.run(() =>
              closeScriptSessionLeaseWithinQueue(state, sessionName, ctx.cwd),
            ),
          );
        } catch {
          cleanupError = "The isolated script session cleanup operation failed.";
          try {
            appendScriptSessionLease(state.pi, sessionName, "failed");
          } catch {
            // Best-effort durable lease update during cleanup failure.
          }
        }
      }
      state.activeScriptExecutions.delete(scriptExecution);
      finishScriptExecution();
    }
    let scriptResult = buildScriptToolResult({
      cleanupError,
      innerResults,
      run,
      sessionName: leased ? sessionName : undefined,
    });
    if (state.artifactManifest) {
      const priorDetails = isRecord(scriptResult.details) ? { ...scriptResult.details } : {};
      scriptResult = {
        ...scriptResult,
        details: {
          ...priorDetails,
          artifactManifest: state.artifactManifest,
          artifactRetentionSummary: formatSessionArtifactRetentionSummary(state.artifactManifest),
        },
      };
    }
    return applyUnserializedOutputPath(appendCompatibilityWarnings(scriptResult));
  }
  const { toolArgs } = resolvedInput;
  const compiledElectron =
    resolvedInput.kind === "electron" ? resolvedInput.compiledElectron : undefined;
  const redactedCompiledElectron =
    resolvedInput.kind === "electron" ? resolvedInput.redactedCompiledElectron : undefined;
  const runElectronHostInput = async () => {
    const electronHostLaunchRecords = getElectronHostLaunchRecordsForInput({
      branchRecords: state.electronLaunchRecords,
      compiledElectron,
      ownedRecords: state.ownedElectronLaunchRecords,
    });
    let electronHostResult = await handleElectronHostInput({
      attachedSessionKeys: state.attachedSessionKeys,
      compiledElectron,
      cwd: ctx.cwd,
      electronChildProcesses: state.electronChildProcesses,
      electronLaunchRecords: electronHostLaunchRecords,
      implicitSessionCloseTimeoutMs: state.implicitSessionCloseTimeoutMs,
      managedSessionActive: state.managedSessionActive,
      managedSessionName: state.managedSessionName,
      managedSessionNamespace: state.managedSessionNamespace,
      managedSessionRestoreState: state.managedSessionRestoreState,
      ownedManagedSessions: state.ownedManagedSessions,
      redactedCompiledElectron,
      sessionPageState: state.sessionPageState,
      signal,
    });
    if (electronHostResult && compiledElectron?.action === "cleanup") {
      state.branchStateGeneration += 1;
      const cleanupRecords =
        isRecord(electronHostResult.details) &&
        isRecord(electronHostResult.details.electron) &&
        isRecord(electronHostResult.details.electron.cleanup) &&
        Array.isArray(electronHostResult.details.electron.cleanup.results)
          ? electronHostResult.details.electron.cleanup.results
          : [];
      const cleanedLaunchIds = new Set<string>();
      for (const cleanupResult of cleanupRecords) {
        if (isRecord(cleanupResult) && isElectronLaunchRecord(cleanupResult.record)) {
          cleanedLaunchIds.add(cleanupResult.record.launchId);
        }
      }
      replaceWithActiveElectronLaunchRecords(
        state.ownedElectronLaunchRecords,
        electronHostLaunchRecords,
        state.branchOwnedElectronLaunchIds,
        cleanedLaunchIds,
      );
      mergeElectronCleanupRecords(state.electronLaunchRecords, cleanupRecords);
      const cleanupNamespace =
        isRecord(electronHostResult.details) &&
        hasRuntimeType(electronHostResult.details.namespace, "string")
          ? electronHostResult.details.namespace
          : undefined;
      const closedSessionIdentities = getCleanupResultsClosedManagedSessionIdentities(
        cleanupRecords,
        cleanupNamespace,
      );
      syncElectronCleanupManagedSessions(
        state.ownedManagedSessions,
        cleanupRecords,
        cleanupNamespace,
      );
      for (const identity of closedSessionIdentities) {
        retireRecordingSession(state, identity.sessionName, identity.namespace);
        const closedSessionKey =
          getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName;
        clearSessionScopedBrowserState(state, closedSessionKey);
        if (
          closedSessionKey ===
          (getSessionContextKey(state.managedSessionName, state.managedSessionNamespace) ??
            state.managedSessionName)
        ) {
          state.managedSessionActive = false;
          state.managedSessionCompatibilityWorkaround = undefined;
          state.managedSessionHeadedAutosaveDisabled = false;
          state.managedSessionHeadedAutosaveInterval = undefined;
          state.managedSessionNamespace = undefined;
          state.freshSessionOrdinal += 1;
          state.managedSessionName = createFreshSessionName(
            state.managedSessionBaseName,
            state.ephemeralSessionSeed,
            state.freshSessionOrdinal,
          );
        }
      }
      if (state.artifactManifest) {
        const priorDetails = isRecord(electronHostResult.details)
          ? { ...electronHostResult.details }
          : {};
        electronHostResult = {
          ...electronHostResult,
          details: {
            ...priorDetails,
            artifactManifest: state.artifactManifest,
            artifactRetentionSummary: formatSessionArtifactRetentionSummary(state.artifactManifest),
          },
        };
      }
    }
    return electronHostResult;
  };
  const runSerializedElectronHostInput = () => {
    const pending = shouldSerializeElectronHostInput(compiledElectron)
      ? state.managedSessionExecutionQueue.run(runElectronHostInput)
      : runElectronHostInput();
    if (compiledElectron) admission?.release();
    return pending;
  };
  // Preflight above may finish out of call order; wait until every earlier call has
  // entered its queue so this call reads and queues behind their session state.
  if (admission) await admission.ready;
  const electronHostResult =
    compiledElectron?.action === "cleanup"
      ? await state.artifactExecutionQueue.run(async () => {
          const reservationError = outputPath
            ? getArtifactPreflightValidationError({
                activeRecordingReservations: state.activeRecordingReservations.values(),
                args: [],
                cwd: ctx.cwd,
                outputPath,
              })
            : undefined;
          if (reservationError) {
            return buildValidationFailureResult({
              attemptedKind: resolvedInput.kind,
              kind: "invalid",
              redactedArgs: resolvedInput.redactedArgs,
              status: "invalid",
              toolArgs: resolvedInput.toolArgs,
              toolStdin: resolvedInput.toolStdin,
              validationError: reservationError,
            });
          }
          const result = await runSerializedElectronHostInput();
          return result
            ? applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result })
            : result;
        })
      : await runSerializedElectronHostInput();
  if (electronHostResult) {
    return compiledElectron?.action === "cleanup"
      ? electronHostResult
      : applyUnserializedOutputPath(appendCompatibilityWarnings(electronHostResult));
  }

  const explicitSessionName = extractExplicitSessionName(toolArgs);
  const explicitNamespace = extractExplicitNamespace(toolArgs);
  const serializeBrowserCommand = shouldSerializeBrowserCommand({
    explicitNamespace,
    explicitSessionName,
    managedSessionName: state.managedSessionName,
    ownedElectronLaunchRecords: state.ownedElectronLaunchRecords,
    ownedManagedSessions: state.ownedManagedSessions,
  });
  const callerOwnedSessionNamespace = explicitSessionName
    ? resolveAgentBrowserNamespace(
        toolArgs,
        getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE,
      )
    : undefined;
  const callerOwnedSessionQueueKey =
    !serializeBrowserCommand && explicitSessionName
      ? (getSessionContextKey(explicitSessionName, callerOwnedSessionNamespace) ??
        explicitSessionName)
      : undefined;
  const webMcpCommandTokens = extractUpstreamCommandTokens(toolArgs);
  const webMcpSubcommand = webMcpCommandTokens[0] === "webmcp" ? webMcpCommandTokens[1] : undefined;
  const webMcpSessionName = explicitSessionName ?? state.managedSessionName;
  const webMcpNamespace = explicitSessionName
    ? callerOwnedSessionNamespace
    : state.managedSessionNamespace;
  const webMcpSessionKey =
    getSessionContextKey(webMcpSessionName, webMcpNamespace) ?? webMcpSessionName;
  const webMcpGeneration = state.webMcpGenerationBySession.get(webMcpSessionKey) ?? 0;
  const webMcpOwner = getWebMcpOwner({
    args: webMcpCommandTokens,
    generation: webMcpGeneration,
    namespace: webMcpNamespace,
    session: webMcpSessionName,
  });
  if (webMcpSubcommand === "invoke") {
    try {
      await preflightWebMcpParams(getOptionValue(webMcpCommandTokens, "--params"), ctx.cwd);
    } catch (error) {
      return buildValidationFailureResult({
        attemptedKind: resolvedInput.kind,
        kind: "invalid",
        redactedArgs: resolvedInput.redactedArgs,
        status: "invalid",
        toolArgs: resolvedInput.toolArgs,
        toolStdin: resolvedInput.toolStdin,
        validationError:
          error instanceof Error ? error.message : "WebMCP params could not be checked safely.",
      });
    }
    if ((state.webMcpGenerationBySession.get(webMcpSessionKey) ?? 0) !== webMcpGeneration)
      return buildValidationFailureResult({
        attemptedKind: resolvedInput.kind,
        kind: "invalid",
        redactedArgs: resolvedInput.redactedArgs,
        status: "invalid",
        toolArgs: resolvedInput.toolArgs,
        toolStdin: resolvedInput.toolStdin,
        validationError:
          "WebMCP session generation changed during params validation; inspect the current page before retrying.",
      });
  }
  const webMcpInvocationId =
    webMcpSubcommand === "result" || webMcpSubcommand === "cancel"
      ? webMcpCommandTokens[2]
      : undefined;
  if (webMcpInvocationId) {
    try {
      state.webMcpInvocations.assertOwned(webMcpInvocationId, webMcpOwner);
    } catch (error) {
      return buildValidationFailureResult({
        attemptedKind: resolvedInput.kind,
        kind: "invalid",
        redactedArgs: resolvedInput.redactedArgs,
        status: "invalid",
        toolArgs: resolvedInput.toolArgs,
        toolStdin: resolvedInput.toolStdin,
        validationError:
          error instanceof Error ? error.message : "WebMCP invocation ownership check failed.",
      });
    }
  }
  const runBrowserCommand = async () => {
    const branchRestoreGenerationAtStart = state.branchRestoreGeneration;
    const generationAtStart = state.branchStateGeneration;
    // Implicit calls read the managed session inside the queue, after earlier calls ran.
    const sessionPageStateUpdate = state.sessionPageState.beginUpdate(
      explicitSessionName
        ? webMcpSessionKey
        : (getSessionContextKey(state.managedSessionName, state.managedSessionNamespace) ??
            state.managedSessionName),
    );
    const browserRunState: BrowserRunState = {
      allowedDomainsBySession: state.allowedDomainsBySession,
      artifactManifest: state.artifactManifest,
      attachedSessionKeys: state.attachedSessionKeys,
      closedManagedSessionNames: new Set<string>(),
      electronChildProcesses: state.electronChildProcesses,
      electronLaunchRecords: state.electronLaunchRecords,
      ephemeralSessionSeed: state.ephemeralSessionSeed,
      freshSessionOrdinal: state.freshSessionOrdinal,
      managedSessionActive: state.managedSessionActive,
      managedSessionBaseName: state.managedSessionBaseName,
      managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
      managedSessionHeadedAutosaveDisabled: state.managedSessionHeadedAutosaveDisabled,
      managedSessionHeadedAutosaveInterval: state.managedSessionHeadedAutosaveInterval,
      managedSessionCwd: state.managedSessionCwd,
      managedSessionName: state.managedSessionName,
      managedSessionNamespace: state.managedSessionNamespace,
      managedSessionRestoreState: state.managedSessionRestoreState,
      networkRoutesBySession: state.networkRoutesBySession,
      ownedManagedSessions: state.ownedManagedSessions,
      sessionPageState: state.sessionPageState,
      traceOwners: state.traceOwners,
    };
    const initialAllowedDomainsBySession = browserRunState.allowedDomainsBySession;
    const initialArtifactManifest = browserRunState.artifactManifest;
    const initialNetworkRoutesBySession = browserRunState.networkRoutesBySession;
    const attachedSessionRequested =
      isAttachedBrowserInvocation(toolArgs) ||
      (resolvedInput.kind === "electron" && resolvedInput.compiledElectron.action === "launch");
    const allocatesFreshManagedSession =
      explicitSessionName === undefined &&
      (params.session_mode === "fresh" ||
        (resolvedInput.kind === "electron" && resolvedInput.compiledElectron.action === "launch"));
    const reusableSessionKey = allocatesFreshManagedSession
      ? undefined
      : (callerOwnedSessionQueueKey ??
        getSessionContextKey(
          browserRunState.managedSessionName,
          browserRunState.managedSessionNamespace,
        ));
    const attachedSessionKnown =
      reusableSessionKey !== undefined && state.attachedSessionKeys.has(reusableSessionKey);
    const clearsWebMcpPage =
      isCloseCommand(webMcpCommandTokens[0]) ||
      isUnverifiedPageTransitionCommand(webMcpCommandTokens[0], webMcpCommandTokens[1]) ||
      isOpenNavigationCommand(webMcpCommandTokens[0]) ||
      isRecordPageTransitionCommand(webMcpCommandTokens);
    if (clearsWebMcpPage) {
      for (const [invocationId, owner] of state.webMcpOwnersByInvocation) {
        if (
          owner.session !== webMcpOwner.session ||
          owner.namespace !== webMcpOwner.namespace ||
          owner.generation !== webMcpOwner.generation
        )
          continue;
        const cancelArgs = [
          ...(owner.namespace ? ["--namespace", owner.namespace] : []),
          "--session",
          owner.session,
          "webmcp",
          "cancel",
          invocationId,
        ];
        const cancellation = await runAgentBrowserProcess({
          args: cancelArgs,
          cwd: ctx.cwd,
          signal,
          timeoutMs: params.timeout_ms,
        });
        if (
          !cancellation.spawnError &&
          cancellation.exitCode === 0 &&
          !cancellation.aborted &&
          !cancellation.timedOut
        ) {
          state.webMcpInvocations.settle(invocationId, owner);
          state.webMcpOwnersByInvocation.delete(invocationId);
        } else if (!isCloseCommand(webMcpCommandTokens[0])) {
          return buildValidationFailureResult({
            attemptedKind: resolvedInput.kind,
            kind: "invalid",
            redactedArgs: resolvedInput.redactedArgs,
            status: "invalid",
            toolArgs: resolvedInput.toolArgs,
            toolStdin: resolvedInput.toolStdin,
            validationError:
              "Pending WebMCP invocation cleanup failed; navigation was not attempted.",
          });
        } else {
          state.webMcpInvocations.takeOwned(owner);
          state.webMcpOwnersByInvocation.delete(invocationId);
        }
      }
    }
    let result = await runAgentBrowserTool({
      ctx,
      cwd: ctx.cwd,
      electronPostCommandStatusSettleMs: ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
      electronProfileIsolationDetails: ELECTRON_PROFILE_ISOLATION_DETAILS,
      implicitSessionCloseTimeoutMs: state.implicitSessionCloseTimeoutMs,
      implicitSessionIdleTimeoutMs: state.implicitSessionIdleTimeoutMs,
      input: resolvedInput,
      onUpdate,
      params,
      establishAttachedBrowserSession: attachedSessionRequested && !attachedSessionKnown,
      preserveAttachedBrowserSession: attachedSessionRequested || attachedSessionKnown,
      promptPolicy,
      sessionPageStateUpdate,
      snapshotIdentityBySession: state.snapshotIdentityBySession,
      snapshotRevisionStore: state.snapshotRevisionStore,
      signal,
      state: browserRunState,
    });
    const webMcpResultDetails = isRecord(result.details) ? result.details : undefined;
    const webMcpResultData = isRecord(webMcpResultDetails?.data)
      ? webMcpResultDetails.data
      : undefined;
    const detachedInvocationId = hasRuntimeType(webMcpResultData?.invocationId, "string")
      ? webMcpResultData.invocationId
      : undefined;
    if (
      result.isError !== true &&
      webMcpSubcommand === "invoke" &&
      webMcpCommandTokens.includes("--detach") &&
      detachedInvocationId
    ) {
      state.webMcpInvocations.register({ invocationId: detachedInvocationId, ...webMcpOwner });
      state.webMcpOwnersByInvocation.set(detachedInvocationId, webMcpOwner);
    } else if (
      result.isError !== true &&
      webMcpInvocationId &&
      (webMcpSubcommand === "result" || webMcpSubcommand === "cancel")
    ) {
      state.webMcpInvocations.settle(webMcpInvocationId, webMcpOwner);
      state.webMcpOwnersByInvocation.delete(webMcpInvocationId);
    }
    if (result.isError !== true && clearsWebMcpPage && !isCloseCommand(webMcpCommandTokens[0]))
      state.webMcpGenerationBySession.set(webMcpSessionKey, webMcpGeneration + 1);
    const branchRestoreStillCurrent =
      branchRestoreGenerationAtStart === state.branchRestoreGeneration;
    const resultDetails = isRecord(result.details) ? result.details : undefined;
    const resultSessionName = hasRuntimeType(resultDetails?.sessionName, "string")
      ? resultDetails.sessionName
      : extractExplicitSessionName(toolArgs);
    const resultNamespace = hasRuntimeType(resultDetails?.namespace, "string")
      ? resultDetails.namespace
      : resolveAgentBrowserNamespace(
          toolArgs,
          getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE,
        );
    if (branchRestoreStillCurrent) {
      const resultBatchCloseLifecycle = getSuccessfulBatchCloseLifecycle(resultDetails?.batchSteps);
      const resultSessionKey =
        getSessionContextKey(resultSessionName, resultNamespace) ?? resultSessionName;
      const managedSessionOutcome = isRecord(resultDetails?.managedSessionOutcome)
        ? resultDetails.managedSessionOutcome
        : undefined;
      const closeAllApplied = resultDetails?.closeAllApplied === true;
      const attachedSessionRemainsActive =
        result.isError !== true ||
        ((attachedSessionRequested || attachedSessionKnown) &&
          managedSessionOutcome?.activeAfter === true);
      const closesAttachedSession =
        (result.isError !== true && isCloseCommand(extractUpstreamCommandTokens(toolArgs)[0])) ||
        resultBatchCloseLifecycle?.endsClosed === true;
      if (closeAllApplied) {
        deleteIdentityKeysInNamespace(state.attachedSessionKeys, resultNamespace);
        if (
          resultSessionKey &&
          attachedSessionRemainsActive &&
          (attachedSessionRequested || attachedSessionKnown) &&
          resultBatchCloseLifecycle?.endsClosed === false
        ) {
          state.attachedSessionKeys.add(resultSessionKey);
          result = { ...result, details: { ...resultDetails, attachedBrowserSession: true } };
        }
      } else if (resultSessionKey && closesAttachedSession)
        state.attachedSessionKeys.delete(resultSessionKey);
      else if (
        resultSessionKey &&
        attachedSessionRemainsActive &&
        (attachedSessionRequested || attachedSessionKnown)
      ) {
        state.attachedSessionKeys.add(resultSessionKey);
        result = { ...result, details: { ...resultDetails, attachedBrowserSession: true } };
      }
    }
    if (branchRestoreStillCurrent) {
      state.allowedDomainsBySession = mergeBrowserRunMap(
        state.allowedDomainsBySession,
        initialAllowedDomainsBySession,
        browserRunState.allowedDomainsBySession,
      );
      state.networkRoutesBySession = mergeBrowserRunMap(
        state.networkRoutesBySession,
        initialNetworkRoutesBySession,
        browserRunState.networkRoutesBySession,
      );
      state.artifactManifest = mergeBrowserRunArtifactManifest(
        state.artifactManifest,
        initialArtifactManifest,
        browserRunState.artifactManifest,
      );
      const handledBatchCloseKeys = syncRecordingReservationsFromResult(state, result);
      if (resultDetails?.closeAllApplied === true) {
        for (const [sessionKey, reservation] of Array.from(state.activeRecordingReservations)) {
          if (isAgentBrowserSessionIdentityKeyInNamespace(sessionKey, resultNamespace)) {
            retireRecordingSession(state, reservation.sessionName, reservation.namespace);
          }
        }
      }
      for (const closedSessionKey of browserRunState.closedManagedSessionNames) {
        if (handledBatchCloseKeys.has(closedSessionKey)) continue;
        const reservation = state.activeRecordingReservations.get(closedSessionKey);
        if (reservation)
          retireRecordingSession(state, reservation.sessionName, reservation.namespace);
      }
      if (resultSessionName && resultReportsNoRecordingInProgress(result)) {
        retireRecordingSession(state, resultSessionName, resultNamespace);
      }
      if (resultSessionName) {
        const reservation = state.activeRecordingReservations.get(
          getAgentBrowserSessionIdentityKey(resultSessionName, resultNamespace),
        );
        if (reservation) result = appendActiveRecordingCleanupAction(result, reservation);
      }
      if (state.artifactManifest) {
        const priorDetails = isRecord(result.details) ? { ...result.details } : {};
        result = {
          ...result,
          details: {
            ...priorDetails,
            artifactManifest: state.artifactManifest,
            artifactRetentionSummary: formatSessionArtifactRetentionSummary(state.artifactManifest),
          },
        };
      }
    }
    const branchStateStillCurrent = generationAtStart === state.branchStateGeneration;
    if (serializeBrowserCommand || branchStateStillCurrent) {
      state.freshSessionOrdinal = Math.max(
        state.freshSessionOrdinal,
        browserRunState.freshSessionOrdinal,
      );
      state.managedSessionActive = browserRunState.managedSessionActive;
      state.managedSessionCompatibilityWorkaround =
        browserRunState.managedSessionCompatibilityWorkaround;
      state.managedSessionHeadedAutosaveDisabled =
        browserRunState.managedSessionHeadedAutosaveDisabled === true;
      state.managedSessionHeadedAutosaveInterval =
        browserRunState.managedSessionHeadedAutosaveInterval;
      state.managedSessionCwd = browserRunState.managedSessionCwd;
      state.managedSessionName = browserRunState.managedSessionName;
      state.managedSessionNamespace = browserRunState.managedSessionNamespace;
      for (const closedSessionName of browserRunState.closedManagedSessionNames) {
        untrackOwnedManagedSession(state.ownedManagedSessions, closedSessionName);
      }
      syncOwnedManagedSessionsFromResult(
        state.ownedManagedSessions,
        result,
        browserRunState.managedSessionCwd,
      );
      mergeActiveElectronLaunchRecords(
        state.ownedElectronLaunchRecords,
        state.electronLaunchRecords,
        {
          branchOwnedLaunchIds: state.branchOwnedElectronLaunchIds,
          touchedLaunchIds: !result.isError
            ? getTouchedElectronLaunchIds(
                explicitSessionName ?? browserRunState.managedSessionName,
                state.electronLaunchRecords,
                explicitSessionName
                  ? resolveAgentBrowserNamespace(
                      toolArgs,
                      getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE,
                    )
                  : browserRunState.managedSessionNamespace,
              )
            : undefined,
        },
      );
      if (serializeBrowserCommand) state.branchStateGeneration += 1;
    }
    return applyAgentBrowserOutputPath({
      cwd: ctx.cwd,
      outputPath,
      preserveTextContent: Array.isArray(params.args) && params.args.includes("--json"),
      result,
    });
  };

  const closesAllSessions = commandClosesAllSessions(toolArgs, resolvedInput.toolStdin);
  const closeAllNamespace = closesAllSessions
    ? resolveAgentBrowserNamespace(
        toolArgs,
        getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE,
      )
    : undefined;
  const runWithinSessionQueue = () => {
    const pending = closesAllSessions
      ? state.managedSessionExecutionQueue.run(() =>
          state.callerOwnedSessionExecutionQueues.runExclusive(
            closeAllNamespace,
            runBrowserCommand,
          ),
        )
      : serializeBrowserCommand
        ? state.managedSessionExecutionQueue.run(runBrowserCommand)
        : callerOwnedSessionQueueKey
          ? state.callerOwnedSessionExecutionQueues.run(
              callerOwnedSessionQueueKey,
              callerOwnedSessionNamespace,
              runBrowserCommand,
            )
          : runBrowserCommand();
    admission?.release();
    return pending;
  };
  if (!commandTouchesArtifactLifecycle(toolArgs, resolvedInput.toolStdin, outputPath))
    return appendCompatibilityWarnings(await runWithinSessionQueue());
  return state.artifactExecutionQueue.run(async () => {
    const artifactValidationError = getArtifactPreflightValidationError({
      activeRecordingReservations: state.activeRecordingReservations.values(),
      args: toolArgs,
      cwd: ctx.cwd,
      outputPath,
      stdin: resolvedInput.toolStdin,
    });
    if (!artifactValidationError) return appendCompatibilityWarnings(await runWithinSessionQueue());
    return applyAgentBrowserOutputPath({
      cwd: ctx.cwd,
      outputPath,
      result: buildValidationFailureResult({
        attemptedKind: resolvedInput.kind,
        kind: "invalid",
        redactedArgs: resolvedInput.redactedArgs,
        status: "invalid",
        toolArgs: resolvedInput.toolArgs,
        toolStdin: resolvedInput.toolStdin,
        validationError: artifactValidationError,
      }),
    });
  });
}
