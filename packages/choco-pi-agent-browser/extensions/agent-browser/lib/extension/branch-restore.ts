import {
  extractExplicitNamespace,
  extractExplicitSessionName,
  isAgentBrowserSessionIdentityKeyInNamespace,
  isUpstreamEnvFlagEnabled,
} from "../argv-grammar.ts";
import {
  batchHasSuccessfulCloseAll,
  getSuccessfulBatchCloseLifecycle,
} from "../batch-lifecycle.ts";
import { isCloseAllCommand, isCloseCommand } from "../command-taxonomy.ts";
import { hasLaunchScopedFlagToken } from "../launch-scoped-flags.ts";
import {
  parseAllowedDomainsPolicyFromArgs,
  type AllowedDomainsPolicy,
} from "../navigation-policy.ts";
import { getSessionContextKey } from "../orchestration/browser-run/index.ts";
import { hasRuntimeType, isRecord, type RuntimeRecord, type RuntimeValue } from "../parsing.ts";
import { getAgentBrowserProcessEnvironment } from "../process-environment.ts";
import { isSessionArtifactManifest } from "../results/artifact-manifest.ts";
import type { SessionArtifactManifest } from "../results/contracts.ts";
import {
  canUseHeadlessCompatibilityUserAgent,
  extractUpstreamCommandTokens,
  type CompatibilityWorkaround,
} from "../runtime.ts";

export interface ElectronClosedManagedSessionIdentity {
  namespace?: string;
  sessionName: string;
}

export function getCleanupResultClosedManagedSessionIdentities<Result>(
  result: Result,
  fallbackNamespace?: string,
): ElectronClosedManagedSessionIdentity[] {
  if (!isRecord(result) || !Array.isArray(result.steps)) return [];
  const identities = new Map<string, ElectronClosedManagedSessionIdentity>();
  const record = isRecord(result.record) ? result.record : undefined;
  for (const step of result.steps) {
    if (!isRecord(step) || step.resource !== "managed-session") continue;
    if (step.state !== "removed" && step.state !== "already-gone") continue;
    const sessionName = hasRuntimeType(step.sessionName, "string")
      ? step.sessionName
      : hasRuntimeType(record?.sessionName, "string")
        ? record.sessionName
        : undefined;
    const namespace = hasRuntimeType(step.namespace, "string")
      ? step.namespace
      : hasRuntimeType(record?.namespace, "string")
        ? record.namespace
        : fallbackNamespace;
    if (sessionName)
      identities.set(getSessionContextKey(sessionName, namespace) ?? sessionName, {
        namespace,
        sessionName,
      });
  }
  return [...identities.values()];
}

export function getCleanupResultsClosedManagedSessionIdentities(
  cleanupResults: unknown[],
  fallbackNamespace?: string,
): ElectronClosedManagedSessionIdentity[] {
  const identities = new Map<string, ElectronClosedManagedSessionIdentity>();
  for (const result of cleanupResults) {
    for (const identity of getCleanupResultClosedManagedSessionIdentities(
      result,
      fallbackNamespace,
    )) {
      identities.set(
        getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
        identity,
      );
    }
  }
  return [...identities.values()];
}

export function getManagedSessionOutcome(
  details: RuntimeRecord<RuntimeValue>,
): RuntimeRecord<RuntimeValue> | undefined {
  return isRecord(details.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
}

export function getSuccessfulToolResult(
  details: RuntimeRecord<RuntimeValue>,
  message: RuntimeRecord<RuntimeValue>,
): boolean {
  const messageIsError = hasRuntimeType(message.isError, "boolean") ? message.isError : undefined;
  const exitCode = hasRuntimeType(details.exitCode, "number") ? details.exitCode : undefined;
  return messageIsError === undefined ? exitCode === undefined || exitCode === 0 : !messageIsError;
}

export function restoreArtifactManifestFromBranch(
  branch: unknown[],
): SessionArtifactManifest | undefined {
  let restoredManifest: SessionArtifactManifest | undefined;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (
      isSessionArtifactManifest(details?.artifactManifest) &&
      (!restoredManifest || details.artifactManifest.updatedAtMs >= restoredManifest.updatedAtMs)
    ) {
      restoredManifest = details.artifactManifest;
    }
  }
  return restoredManifest;
}

export function getRecognizedCompatibilityWorkaround<Value>(
  value: Value,
): CompatibilityWorkaround | undefined {
  const workaround = isRecord(value) ? value : undefined;
  return (workaround?.id === "chatgpt-headless-user-agent" ||
    workaround?.id === "cloudflare-headless-user-agent") &&
    hasRuntimeType(workaround.reason, "string")
    ? { id: workaround.id, reason: workaround.reason }
    : undefined;
}

export function restoreManagedSessionCompatibilityWorkaroundFromBranch(
  branch: unknown[],
  sessionName: string,
  namespace?: string,
): CompatibilityWorkaround | undefined {
  let restored: CompatibilityWorkaround | undefined;
  const targetKey = getSessionContextKey(sessionName, namespace);
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    if (
      getSessionContextKey(
        hasRuntimeType(details.sessionName, "string") ? details.sessionName : undefined,
        hasRuntimeType(details.namespace, "string") ? details.namespace : undefined,
      ) !== targetKey
    )
      continue;
    const recognizedWorkaround = getRecognizedCompatibilityWorkaround(
      details.compatibilityWorkaround,
    );
    const succeeded = getSuccessfulToolResult(details, message);
    const outcome = getManagedSessionOutcome(details);
    const activeAfterFailure =
      recognizedWorkaround &&
      outcome?.activeAfter === true &&
      hasRuntimeType(outcome.currentSessionName, "string") &&
      getSessionContextKey(
        outcome.currentSessionName,
        hasRuntimeType(outcome.currentSessionNamespace, "string")
          ? outcome.currentSessionNamespace
          : undefined,
      ) === targetKey &&
      (outcome.status === "created" ||
        outcome.status === "replaced" ||
        outcome.status === "unchanged");
    if (!succeeded && !activeAfterFailure) continue;
    if (recognizedWorkaround) {
      restored = recognizedWorkaround;
    } else if (!canUseHeadlessCompatibilityUserAgent(getToolResultArgs(details))) {
      restored = undefined;
    }
  }
  return restored;
}

export function restoreManagedSessionHeadedAutosaveDisabledFromBranch(
  branch: unknown[],
  sessionName: string,
  namespace?: string,
): boolean {
  let restored = false;
  const targetKey = getSessionContextKey(sessionName, namespace);
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    if (
      getSessionContextKey(
        hasRuntimeType(details.sessionName, "string") ? details.sessionName : undefined,
        hasRuntimeType(details.namespace, "string") ? details.namespace : undefined,
      ) !== targetKey
    )
      continue;
    const outcome = getManagedSessionOutcome(details);
    const activeAfterFailure =
      outcome?.activeAfter === true &&
      hasRuntimeType(outcome.currentSessionName, "string") &&
      getSessionContextKey(
        outcome.currentSessionName,
        hasRuntimeType(outcome.currentSessionNamespace, "string")
          ? outcome.currentSessionNamespace
          : undefined,
      ) === targetKey;
    if (
      (getSuccessfulToolResult(details, message) || activeAfterFailure) &&
      hasRuntimeType(details.managedSessionHeadedAutosaveDisabled, "boolean")
    ) {
      restored = details.managedSessionHeadedAutosaveDisabled;
    }
  }
  return restored;
}

export function restoreManagedSessionHeadedAutosaveIntervalFromBranch(
  branch: unknown[],
  sessionName: string,
  namespace?: string,
): string | undefined {
  let restored: string | undefined;
  const targetKey = getSessionContextKey(sessionName, namespace);
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    if (
      getSessionContextKey(
        hasRuntimeType(details.sessionName, "string") ? details.sessionName : undefined,
        hasRuntimeType(details.namespace, "string") ? details.namespace : undefined,
      ) !== targetKey
    )
      continue;
    const outcome = getManagedSessionOutcome(details);
    const activeAfterFailure =
      outcome?.activeAfter === true &&
      hasRuntimeType(outcome.currentSessionName, "string") &&
      getSessionContextKey(
        outcome.currentSessionName,
        hasRuntimeType(outcome.currentSessionNamespace, "string")
          ? outcome.currentSessionNamespace
          : undefined,
      ) === targetKey;
    if (!getSuccessfulToolResult(details, message) && !activeAfterFailure) continue;
    if (hasRuntimeType(details.managedSessionHeadedAutosaveInterval, "string"))
      restored = details.managedSessionHeadedAutosaveInterval;
    else if (details.managedSessionHeadedAutosaveDisabled === true) restored = "0";
  }
  return restored;
}

export function getToolResultArgs(details: RuntimeRecord<RuntimeValue>): string[] {
  if (Array.isArray(details.args) && details.args.every((arg) => hasRuntimeType(arg, "string")))
    return details.args;
  if (
    Array.isArray(details.effectiveArgs) &&
    details.effectiveArgs.every((arg) => hasRuntimeType(arg, "string"))
  )
    return details.effectiveArgs;
  return [];
}

export function detailsReportCloseAllApplied(
  details: RuntimeRecord<RuntimeValue>,
  succeeded: boolean,
): boolean {
  const args = getToolResultArgs(details);
  return (
    details.closeAllApplied === true ||
    (succeeded && isCloseAllCommand(extractUpstreamCommandTokens(args))) ||
    batchHasSuccessfulCloseAll(details.batchSteps)
  );
}

export function deleteIdentityKeysInNamespace(
  entries: Set<string> | Map<string, unknown>,
  namespace?: string,
): void {
  for (const key of entries.keys()) {
    if (isAgentBrowserSessionIdentityKeyInNamespace(key, namespace)) entries.delete(key);
  }
}

export function isAttachedBrowserInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment(),
): boolean {
  const autoConnectEnv = env.AGENT_BROWSER_AUTO_CONNECT;
  return (
    extractUpstreamCommandTokens(args)[0] === "connect" ||
    hasLaunchScopedFlagToken(args, "--cdp") ||
    hasLaunchScopedFlagToken(args, "--auto-connect") ||
    env.AGENT_BROWSER_CDP !== undefined ||
    isUpstreamEnvFlagEnabled(autoConnectEnv)
  );
}

export function restoreAttachedSessionKeysFromBranch(branch: unknown[]): Set<string> {
  const attachedSessionKeys = new Set<string>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    const managedSessionOutcome = isRecord(details.managedSessionOutcome)
      ? details.managedSessionOutcome
      : undefined;
    const retainedFailedAttachment =
      details.attachedBrowserSession === true && managedSessionOutcome?.activeAfter === true;
    const succeeded = getSuccessfulToolResult(details, message);
    const batchCloseLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
    const terminalBatchClose = batchCloseLifecycle?.endsClosed === true;
    const args = getToolResultArgs(details);
    const namespace = hasRuntimeType(details.namespace, "string")
      ? details.namespace
      : extractExplicitNamespace(args);
    const sessionName = hasRuntimeType(details.sessionName, "string")
      ? details.sessionName
      : extractExplicitSessionName(args);
    const electron = isRecord(details.electron) ? details.electron : undefined;
    const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
    for (const cleanupResult of Array.isArray(cleanup?.results) ? cleanup.results : []) {
      for (const identity of getCleanupResultClosedManagedSessionIdentities(
        cleanupResult,
        namespace,
      )) {
        attachedSessionKeys.delete(
          getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
        );
      }
    }
    if (detailsReportCloseAllApplied(details, succeeded)) {
      deleteIdentityKeysInNamespace(attachedSessionKeys, namespace);
      if (
        sessionName &&
        details.attachedBrowserSession === true &&
        batchCloseLifecycle?.endsClosed === false
      ) {
        attachedSessionKeys.add(getSessionContextKey(sessionName, namespace) ?? sessionName);
      }
      continue;
    }
    if (!succeeded && !retainedFailedAttachment && !terminalBatchClose) continue;
    if (!sessionName) continue;
    const sessionKey = getSessionContextKey(sessionName, namespace) ?? sessionName;
    if ((succeeded && isCloseCommand(extractUpstreamCommandTokens(args)[0])) || terminalBatchClose)
      attachedSessionKeys.delete(sessionKey);
    else if (details.attachedBrowserSession === true || isAttachedBrowserInvocation(args, {}))
      attachedSessionKeys.add(sessionKey);
  }
  return attachedSessionKeys;
}

export function restoreAllowedDomainsBySessionFromBranch(
  branch: unknown[],
): Map<string, AllowedDomainsPolicy> {
  const restoredPolicies = new Map<string, AllowedDomainsPolicy>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    const succeeded = getSuccessfulToolResult(details, message);
    const batchCloseLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
    const args = getToolResultArgs(details);
    const command = hasRuntimeType(details.command, "string")
      ? details.command
      : extractUpstreamCommandTokens(args)[0];
    const sessionName = hasRuntimeType(details.sessionName, "string")
      ? details.sessionName
      : undefined;
    const namespace = hasRuntimeType(details.namespace, "string") ? details.namespace : undefined;
    const sessionKey = getSessionContextKey(sessionName, namespace);
    const explicitSessionName = extractExplicitSessionName(args);
    if (detailsReportCloseAllApplied(details, succeeded))
      deleteIdentityKeysInNamespace(restoredPolicies, namespace);
    const outcome = getManagedSessionOutcome(details);
    const outcomeSucceeded = outcome?.succeeded === true;
    const outcomeStatus = hasRuntimeType(outcome?.status, "string") ? outcome.status : undefined;
    const outcomeCurrentSessionName = hasRuntimeType(outcome?.currentSessionName, "string")
      ? outcome.currentSessionName
      : undefined;
    const outcomeAttemptedSessionName = hasRuntimeType(outcome?.attemptedSessionName, "string")
      ? outcome.attemptedSessionName
      : undefined;
    if (outcomeSucceeded && outcomeStatus === "closed") {
      const closedSessionName =
        outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName;
      if (closedSessionName)
        restoredPolicies.delete(
          getSessionContextKey(closedSessionName, namespace) ?? closedSessionName,
        );
    }
    if (outcomeSucceeded && outcomeStatus === "replaced") {
      const replacedSessionName = hasRuntimeType(outcome.replacedSessionName, "string")
        ? outcome.replacedSessionName
        : undefined;
      const replacedSessionNamespace = hasRuntimeType(outcome.replacedSessionNamespace, "string")
        ? outcome.replacedSessionNamespace
        : namespace;
      if (replacedSessionName)
        restoredPolicies.delete(
          getSessionContextKey(replacedSessionName, replacedSessionNamespace) ??
            replacedSessionName,
        );
    }
    if ((succeeded && isCloseCommand(command)) || batchCloseLifecycle) {
      const closedSessionName =
        explicitSessionName ??
        sessionName ??
        outcomeAttemptedSessionName ??
        outcomeCurrentSessionName;
      if (closedSessionName)
        restoredPolicies.delete(
          getSessionContextKey(closedSessionName, namespace) ?? closedSessionName,
        );
    }
    const electron = isRecord(details.electron) ? details.electron : undefined;
    const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
    const cleanupResults = Array.isArray(cleanup?.results) ? cleanup.results : [];
    for (const cleanupResult of cleanupResults) {
      for (const identity of getCleanupResultClosedManagedSessionIdentities(
        cleanupResult,
        namespace,
      )) {
        restoredPolicies.delete(
          getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
        );
      }
    }
    const outcomeKeepsSessionCurrent =
      outcome?.activeAfter === true &&
      (outcomeStatus === "created" ||
        outcomeStatus === "replaced" ||
        outcomeStatus === "unchanged") &&
      outcomeCurrentSessionName === sessionName;
    const policy =
      (succeeded || outcomeKeepsSessionCurrent) &&
      sessionKey &&
      !isCloseCommand(command) &&
      batchCloseLifecycle?.endsClosed !== true
        ? parseAllowedDomainsPolicyFromArgs(args)
        : undefined;
    if (policy && sessionKey) restoredPolicies.set(sessionKey, policy);
  }
  return restoredPolicies;
}

export interface BranchRestoreQueue {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface RestoredBranchSnapshot {
  branch: unknown[];
  cwd: string;
}

export async function runBranchRestoreForGeneration<T>(options: {
  artifactQueue: BranchRestoreQueue;
  generation: number;
  isCurrent: (generation: number) => boolean;
  managedSessionQueue: BranchRestoreQueue;
  recover: (restored: T, isCurrent: () => boolean) => Promise<void>;
  restore: () => T;
  waitForActiveScripts: () => Promise<void>;
}): Promise<void> {
  await options.waitForActiveScripts();
  if (!options.isCurrent(options.generation)) return;
  await options.artifactQueue.run(async () => {
    if (!options.isCurrent(options.generation)) return;
    await options.managedSessionQueue.run(async () => {
      if (!options.isCurrent(options.generation)) return;
      const restored = options.restore();
      if (!options.isCurrent(options.generation)) return;
      await options.recover(restored, () => options.isCurrent(options.generation));
    });
  });
}
