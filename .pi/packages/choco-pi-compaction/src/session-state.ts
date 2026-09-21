/**
 * Per-session snapshots this extension resolves once at `session_start`.
 *
 * Both sources are host- or sibling-package configuration that cannot be read
 * from an `ExtensionContext` during compaction: the context exposes no settings
 * manager, and re-reading configuration files on the compaction path would put
 * filesystem work inside a request the user is waiting on.
 */
import type { RetryPolicy } from "@earendil-works/pi-ai";
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
}

/**
 * Read the session's retry policy from the same settings the host uses.
 *
 * `ExtensionContext` carries no settings manager, so the settings are loaded
 * from disk exactly like `AgentSession` loads them (`SettingsManager.create`
 * over the project cwd and the agent directory). The result is copied into a
 * plain policy so nothing holds the manager alive past `session_start`.
 */
export function readRetryPolicy(cwd: string): RetryPolicy {
  const settings = SettingsManager.create(cwd, getAgentDir()).getRetrySettings();
  return {
    enabled: settings.enabled,
    maxRetries: settings.maxRetries,
    baseDelayMs: settings.baseDelayMs,
    maxAgentDelayMs: settings.maxAgentDelayMs,
  };
}

/**
 * Read the codex package's effective configuration for native compaction.
 *
 * Same call the codex extension makes in its own `session_start`, so both
 * packages decide from one configuration state. A missing or unreadable config
 * file yields the documented defaults rather than throwing.
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
