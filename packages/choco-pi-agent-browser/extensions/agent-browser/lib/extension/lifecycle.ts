import type { ChildProcess } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isDirectAgentBrowserBashAllowed,
  isHarmlessAgentBrowserInspectionCommand,
  looksLikeDirectAgentBrowserBash,
} from "../bash-guard.ts";
import { loadAgentBrowserConfigSync } from "../config.ts";
import { cleanupManagedSessionRestoreConfig } from "../managed-session-restore.ts";
import type { AllowedDomainsPolicy } from "../navigation-policy.ts";
import type { TraceOwner } from "../orchestration/browser-run/index.ts";
import { getActiveElectronRecords } from "../orchestration/browser-run/session-state.ts";
import {
  cleanupActiveElectronHostLaunches,
  type ElectronLaunchRecord,
} from "../orchestration/electron-host/index.ts";
import { hasRuntimeType } from "../parsing.ts";
import { buildAgentBrowserToolResultPatch } from "../pi-tool-rendering.ts";
import {
  PROJECT_RULE_PROMPT,
  buildBrowserDefaultProfileGuideline,
  buildBrowserExecutablePathGuideline,
} from "../playbook.ts";
import {
  buildPromptPolicy,
  getLatestUserPrompt,
  shouldAppendBrowserSystemPrompt,
} from "../prompt-policy.ts";
import {
  appendRecordingReservationTransition,
  type ActiveRecordingReservation,
} from "../recording-reservations.ts";
import type { NetworkRouteRecord } from "../results/contracts.ts";
import { cleanupSecureTempArtifacts } from "../temp.ts";
import { runBranchRestoreForGeneration } from "./branch-restore.ts";
import { isBashToolCallEvent, shouldIncludeProjectConfig } from "./compatibility.ts";
import {
  closeOwnedManagedSessions,
  closeOwnedManagedSessionsExcept,
  getCleanupResultsClosedManagedSessionIdentities,
  getCleanupResultsPreservedUserDataDirs,
  getOffBranchOwnedElectronLaunchRecords,
  syncElectronCleanupManagedSessions,
} from "./managed-resources.ts";
import {
  recoverScriptSessionLeasesWithinQueue,
  registerWebSearchToolIfAvailable,
  restoreBranchBackedState,
  retireRecordingSession,
  type ExtensionRuntimeState,
} from "./state.ts";

export function registerExtensionLifecycleHandlers(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
): void {
  pi.on("session_start", async (_event, ctx) => {
    state.branchRestoreGeneration += 1;
    const restoreGeneration = state.branchRestoreGeneration;
    const restored = restoreBranchBackedState(state, ctx, { resetRuntimeOwnership: true });
    state.electronChildProcesses = new Map<string, ChildProcess>();
    registerWebSearchToolIfAvailable(
      state,
      loadAgentBrowserConfigSync({
        cwd: ctx.cwd,
        includeProjectConfig: shouldIncludeProjectConfig(ctx),
      }),
    );
    await state.artifactExecutionQueue.run(() =>
      state.managedSessionExecutionQueue.run(() =>
        restoreGeneration === state.branchRestoreGeneration
          ? recoverScriptSessionLeasesWithinQueue(
              state,
              restored.branch,
              restored.cwd,
              () => restoreGeneration === state.branchRestoreGeneration,
            )
          : Promise.resolve(),
      ),
    );
  });

  pi.on("session_tree", async (_event, ctx) => {
    state.branchRestoreGeneration += 1;
    const restoreGeneration = state.branchRestoreGeneration;
    for (const controller of state.activeScriptControllers) controller.abort();
    await runBranchRestoreForGeneration({
      artifactQueue: state.artifactExecutionQueue,
      generation: restoreGeneration,
      isCurrent: (generation) => generation === state.branchRestoreGeneration,
      managedSessionQueue: state.managedSessionExecutionQueue,
      recover: (restored, isCurrent) =>
        recoverScriptSessionLeasesWithinQueue(state, restored.branch, restored.cwd, isCurrent),
      restore: () => restoreBranchBackedState(state, ctx, { resetRuntimeOwnership: false }),
      waitForActiveScripts: async () => {
        await Promise.allSettled(Array.from(state.activeScriptExecutions));
      },
    });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    for (const controller of state.activeScriptControllers) controller.abort();
    await Promise.allSettled(Array.from(state.activeScriptExecutions));
    state.branchRestoreGeneration += 1;
    state.branchStateGeneration += 1;
    let preservedElectronProfileDirs: string[] = [];
    await state.artifactExecutionQueue.run(() =>
      state.managedSessionExecutionQueue.run(async () => {
        const shutdownCwd = ctx?.cwd ?? state.managedSessionCwd;
        const quitting = event?.reason === "quit";
        preservedElectronProfileDirs = quitting
          ? []
          : getActiveElectronRecords(state.electronLaunchRecords).map(
              (record) => record.userDataDir,
            );
        const electronRecordsToCleanup = quitting
          ? state.ownedElectronLaunchRecords
          : getOffBranchOwnedElectronLaunchRecords(
              state.ownedElectronLaunchRecords,
              state.electronLaunchRecords,
            );
        const electronCleanupResults = await cleanupActiveElectronHostLaunches({
          attachedSessionKeys: state.attachedSessionKeys,
          cwd: shutdownCwd,
          electronChildProcesses: state.electronChildProcesses,
          electronLaunchRecords: electronRecordsToCleanup,
          managedSessionRestoreState: state.managedSessionRestoreState,
          ownedManagedSessions: state.ownedManagedSessions,
          timeoutMs: state.implicitSessionCloseTimeoutMs,
        });
        preservedElectronProfileDirs = [
          ...new Set([
            ...preservedElectronProfileDirs,
            ...getCleanupResultsPreservedUserDataDirs(electronCleanupResults),
          ]),
        ];
        syncElectronCleanupManagedSessions(state.ownedManagedSessions, electronCleanupResults);
        for (const identity of getCleanupResultsClosedManagedSessionIdentities(
          electronCleanupResults,
        ))
          retireRecordingSession(state, identity.sessionName, identity.namespace);
        if (quitting) {
          await closeOwnedManagedSessions(
            state.ownedManagedSessions,
            state.managedSessionRestoreState,
            state.implicitSessionCloseTimeoutMs,
            state.attachedSessionKeys,
            (owner) => retireRecordingSession(state, owner.sessionName, owner.namespace),
          );
        } else {
          await closeOwnedManagedSessionsExcept(
            state.ownedManagedSessions,
            state.managedSessionRestoreState,
            state.managedSessionActive ? state.managedSessionName : undefined,
            state.implicitSessionCloseTimeoutMs,
            state.attachedSessionKeys,
            state.managedSessionActive ? state.managedSessionNamespace : undefined,
            (owner) => retireRecordingSession(state, owner.sessionName, owner.namespace),
          );
        }
      }),
    );
    state.managedSessionActive = false;
    state.managedSessionCompatibilityWorkaround = undefined;
    state.managedSessionHeadedAutosaveDisabled = false;
    state.managedSessionHeadedAutosaveInterval = undefined;
    state.managedSessionNamespace = undefined;
    for (const reservation of state.recordingSessionTombstonesToPersist.values()) {
      try {
        appendRecordingReservationTransition(pi, { reservation, state: "closed" });
      } catch {
        // Best-effort durable tombstone persistence during session shutdown.
      }
    }
    for (const reservation of state.activeRecordingReservations.values()) {
      try {
        appendRecordingReservationTransition(pi, { reservation, state: "active" });
      } catch {
        // Best-effort durable recording persistence during session shutdown.
      }
    }
    state.sessionPageState.reset();
    state.traceOwners = new Map<string, TraceOwner>();
    state.artifactManifest = undefined;
    state.activeRecordingReservations = new Map<string, ActiveRecordingReservation>();
    state.recordingSessionTombstones = new Map<string, ActiveRecordingReservation>();
    state.recordingSessionTombstonesToPersist = new Map<string, ActiveRecordingReservation>();
    state.allowedDomainsBySession = new Map<string, AllowedDomainsPolicy>();
    state.attachedSessionKeys = new Set<string>();
    state.networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
    state.electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
    state.ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
    state.branchOwnedElectronLaunchIds = new Set<string>();
    state.electronChildProcesses = new Map<string, ChildProcess>();
    state.ownedManagedSessions.clear();
    cleanupManagedSessionRestoreConfig();
    await cleanupSecureTempArtifacts({ preservePaths: preservedElectronProfileDirs });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // A run started by a custom message keeps the latest user prompt's decision,
    // so its system prompt matches the user run before it.
    const prompt =
      event.messageType === "user"
        ? event.prompt
        : getLatestUserPrompt(ctx.sessionManager.getBranch());
    if (!shouldAppendBrowserSystemPrompt(prompt)) {
      return undefined;
    }
    const runtimeConfig = loadAgentBrowserConfigSync({
      cwd: ctx.cwd,
      includeProjectConfig: shouldIncludeProjectConfig(ctx),
    });
    const browserGuidance = [
      runtimeConfig.browserExecutablePathScope === "project"
        ? buildBrowserExecutablePathGuideline(runtimeConfig.browserExecutablePath)
        : undefined,
      runtimeConfig.browserDefaultProfileScope === "project"
        ? buildBrowserDefaultProfileGuideline(runtimeConfig.browserDefaultProfile)
        : undefined,
    ].filter((line): line is string => hasRuntimeType(line, "string") && line.length > 0);
    const runtimeConfigPrompt =
      browserGuidance.length > 0
        ? `\n\nProject agent_browser config guidance:\n${browserGuidance.map((line) => `- ${line}`).join("\n")}`
        : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${PROJECT_RULE_PROMPT}${runtimeConfigPrompt}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
    if (
      isBashToolCallEvent(event) &&
      !promptPolicy.allowLegacyAgentBrowserBash &&
      looksLikeDirectAgentBrowserBash(event.input.command) &&
      !isHarmlessAgentBrowserInspectionCommand(event.input.command) &&
      !(await isDirectAgentBrowserBashAllowed(ctx.cwd))
    ) {
      return {
        block: true,
        reason:
          "Use the native agent_browser tool instead of bash for agent-browser in this environment.",
      };
    }
  });

  pi.on("tool_result", async (event) => buildAgentBrowserToolResultPatch(event));
}
