import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readRegisteredCodexCompactionSnapshot } from "@choco-pi/shared/codex-compaction-contract";

import { isBoolean, isRecord, isString, type RuntimeValue } from "./guards.ts";
import type { CodexCompactionSnapshot } from "./ownership.ts";

export interface CompactionSessionState {
  readonly generation: number;
  readonly retryPolicy: RetryPolicy | undefined;
  readonly codexCompaction: CodexCompactionSnapshot | undefined;
  readonly compactionPolicy?: HostCompactionPolicyReader | undefined;
}

export type SessionStateReader = () => CompactionSessionState;

export function readRetryPolicy(cwd: string): RetryPolicy {
  return readHostSettings(cwd).retryPolicy;
}

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

function hostSettingsFrom(settings: SettingsManager): HostSettingsSnapshot {
  const retry = settings.getRetrySettings();
  return {
    retryPolicy: {
      enabled: retry.enabled,
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelayMs,
      maxAgentDelayMs: retry.maxAgentDelayMs,
    },
    compactionPolicy: (model) => {
      const compaction = settings.getCompactionSettings(model);
      return {
        keepRecentTokens: compaction.keepRecentTokens,
        reserveTokens: compaction.reserveTokens,
      };
    },
  };
}

export function readHostSettings(cwd: string): HostSettingsSnapshot {
  return hostSettingsFrom(SettingsManager.create(cwd, getAgentDir()));
}

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
  if (isRecord(scope) && Object.hasOwn(scope, "additionalProviders")) {
    layer.additionalProviders = providerList(scope["additionalProviders"]);
  }
  return layer;
}

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
