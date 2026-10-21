/**
 * Per-session snapshots this extension resolves once at `session_start`.
 *
 * Both sources are host- or sibling-package configuration that cannot be read
 * from an `ExtensionContext` during compaction: the context exposes no settings
 * manager, and re-reading configuration files on the compaction path would put
 * filesystem work inside a request the user is waiting on.
 */
import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import { readEffectiveCodexConversionConfig } from "../../choco-pi-codex/src/adapter/activation/config-store.ts";
import type { CodexCompactionSnapshot } from "./ownership.ts";

/** Everything the compaction handler reads from outside the event. */
export interface CompactionSessionState {
  /**
   * Handler lifetime counter. A session start or shutdown increments it, which
   * invalidates any compaction still awaiting a provider response.
   */
  readonly generation: number;
  /** Retry policy for summarization, or undefined before the first session. */
  readonly retryPolicy: RetryPolicy | undefined;
  /** Codex's native-compaction configuration, or undefined before the first session. */
  readonly codexCompaction: CodexCompactionSnapshot | undefined;
  /**
   * The host's per-model compaction cut policy, from the same settings load as
   * `retryPolicy`; undefined before the first session.
   */
  readonly compactionPolicy?: HostCompactionPolicyReader | undefined;
}

/** Reads the state `session_start` resolved for the current session. */
export type SessionStateReader = () => CompactionSessionState;

/**
 * Read the session's retry policy from the same settings the host uses.
 *
 * `ExtensionContext` carries no settings manager, so the settings are loaded
 * from disk exactly like `AgentSession` loads them (`SettingsManager.create`
 * over the project cwd and the agent directory). The result is copied into a
 * plain policy so nothing holds the manager alive past `session_start`.
 */
export function readRetryPolicy(cwd: string): RetryPolicy {
  return readHostSettings(cwd).retryPolicy;
}

/** The host's compaction cut policy for one model, as the host itself resolves it. */
export interface HostCompactionPolicy {
  readonly keepRecentTokens: number;
  readonly reserveTokens: number;
}

export type HostCompactionPolicyReader = (
  model: Pick<Model<Api>, "provider" | "id"> | undefined,
) => HostCompactionPolicy;

export interface HostSettingsSnapshot {
  readonly retryPolicy: RetryPolicy;
  readonly compactionPolicy: HostCompactionPolicyReader;
}

/** Read retry and compaction settings from the given (already loaded) manager. */
function hostSettingsFrom(settings: SettingsManager): HostSettingsSnapshot {
  const retry = settings.getRetrySettings();
  return {
    retryPolicy: {
      enabled: retry.enabled,
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelayMs,
      maxAgentDelayMs: retry.maxAgentDelayMs,
    },
    // The manager is in memory after creation; per-model reads touch no file.
    compactionPolicy: (model) => {
      const compaction = settings.getCompactionSettings(model);
      return {
        keepRecentTokens: compaction.keepRecentTokens,
        reserveTokens: compaction.reserveTokens,
      };
    },
  };
}

/**
 * Load the host settings once per session start. This is the same single
 * settings load the retry policy always used; the background coordinator's
 * cut policy is read from that one manager rather than a second load.
 */
export function readHostSettings(cwd: string): HostSettingsSnapshot {
  return hostSettingsFrom(SettingsManager.create(cwd, getAgentDir()));
}

/**
 * Read the codex package's effective configuration for native compaction.
 *
 * Same call the codex extension makes in its own `session_start`, so both
 * packages decide from one configuration state. A missing or unreadable config
 * file yields the documented defaults rather than throwing.
 *
 * This snapshot is the fallback for ownership: while the Codex package has
 * published its live eligibility slot (`ownership.ts` `readCodexEligibility`),
 * `resolveOwner` decides from that slot instead, which follows `/codex`
 * changes mid-session. The snapshot still feeds the derived background lanes
 * read at session start.
 */
export function readCodexCompactionSnapshot(
  cwd: string,
  projectTrusted: boolean,
): CodexCompactionSnapshot {
  const config = readEffectiveCodexConversionConfig({ cwd, projectTrusted });
  return {
    responsesCompaction: config.compaction.responsesCompaction,
    additionalProviders: [...config.scope.additionalProviders],
  };
}
