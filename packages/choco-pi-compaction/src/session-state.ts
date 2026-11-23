/**
 * Per-session snapshots this extension resolves once at `session_start`.
 *
 * Both sources are host- or sibling-package configuration that cannot be read
 * from an `ExtensionContext` during compaction: the context exposes no settings
 * manager, and re-reading configuration files on the compaction path would put
 * filesystem work inside a request the user is waiting on.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readRegisteredCodexCompactionSnapshot } from "@choco-pi/shared/codex-compaction-contract";

import { isBoolean, isRecord, isString, type RuntimeValue } from "./guards.ts";
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
 * While the codex extension is loaded it publishes its effective-config reader
 * on a global slot, so both packages decide from one configuration state.
 * Without that reader (codex not loaded) the codex config files are read
 * directly for the two fields this package needs. A missing or unreadable
 * config file yields the codex defaults rather than throwing.
 *
 * This snapshot is the fallback for ownership: while the Codex package has
 * published its live eligibility slot (`ownership.ts` `readCodexEligibility`),
 * `resolveOwner` decides from that slot instead, which follows `/codex`
 * changes mid-session. The snapshot still feeds the derived background lanes
 * read at session start.
 */
export async function readCodexCompactionSnapshot(
  cwd: string,
  projectTrusted: boolean,
): Promise<CodexCompactionSnapshot> {
  const registered = readRegisteredCodexCompactionSnapshot({ cwd, projectTrusted });
  if (registered !== undefined) {
    return {
      responsesCompaction: registered.responsesCompaction,
      additionalProviders: [...registered.additionalProviders],
    };
  }
  return readCodexConfigFiles(cwd, projectTrusted);
}

const CODEX_CONFIG_BASENAME = "choco-pi-codex.json";
/** Codex's own default: native Responses compaction is off until configured. */
const DEFAULT_RESPONSES_COMPACTION = false;

interface CodexConfigLayer {
  responsesCompaction?: boolean;
  additionalProviders?: string[];
}

async function readCodexConfigFiles(
  cwd: string,
  projectTrusted: boolean,
): Promise<CodexCompactionSnapshot> {
  const globalPath = resolve(getAgentDir(), CODEX_CONFIG_BASENAME);
  const projectPath = resolve(cwd, CONFIG_DIR_NAME, CODEX_CONFIG_BASENAME);
  const layers = [await readCodexConfigLayer(globalPath)];
  if (projectTrusted && projectPath !== globalPath) {
    layers.push(await readCodexConfigLayer(projectPath));
  }
  let responsesCompaction = DEFAULT_RESPONSES_COMPACTION;
  let additionalProviders: string[] = [];
  for (const layer of layers) {
    if (layer.responsesCompaction !== undefined) responsesCompaction = layer.responsesCompaction;
    if (layer.additionalProviders !== undefined) additionalProviders = layer.additionalProviders;
  }
  return { responsesCompaction, additionalProviders };
}

/** One config file's relevant fields; absent, unreadable, or malformed values are omitted. */
async function readCodexConfigLayer(path: string): Promise<CodexConfigLayer> {
  let parsed: RuntimeValue;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const layer: CodexConfigLayer = {};
  const compaction = parsed["compaction"];
  if (isRecord(compaction)) {
    const responsesCompaction = compaction["responsesCompaction"];
    if (isBoolean(responsesCompaction)) layer.responsesCompaction = responsesCompaction;
  }
  const scope = parsed["scope"];
  // A layer without the key keeps the lower layer's list, as codex's deep merge does.
  if (isRecord(scope) && Object.hasOwn(scope, "additionalProviders")) {
    layer.additionalProviders = providerList(scope["additionalProviders"]);
  }
  return layer;
}

/** Same normalization as codex: trimmed, lower-cased, de-duplicated non-empty strings. */
function providerList(value: RuntimeValue): string[] {
  if (!Array.isArray(value)) return [];
  const providers = new Set<string>();
  for (const entry of value) {
    if (!isString(entry)) continue;
    const provider = entry.trim().toLowerCase();
    if (provider.length > 0) providers.add(provider);
  }
  return [...providers];
}
