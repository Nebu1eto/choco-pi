import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readTextIfExists } from "./fs-async.ts";
import type { ModelEntry } from "./model-resolver.ts";
import { isString } from "./value-guards.ts";

export interface ModelRegistryRef {
  getAll(): ModelEntry[];
  getAvailable?(): ModelEntry[];
}

function settingsPaths(cwd: string): [project: string, global: string] {
  return [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")];
}

async function readField(path: string): Promise<string[] | undefined> {
  try {
    const text = await readTextIfExists(path);
    if (text === undefined) return undefined;
    const raw = JSON.parse(text);
    if (Array.isArray(raw?.enabledModels)) {
      return raw.enabledModels.filter(isString);
    }
  } catch {}
  return undefined;
}

export interface EnabledModelsSnapshot {
  readonly patterns: string[] | undefined;
  readonly hash: string;
}

const snapshots = new Map<string, EnabledModelsSnapshot>();
const inFlight = new Map<string, Promise<EnabledModelsSnapshot>>();

async function hashOf(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.mtimeMs}-${s.size}`;
  } catch {
    return "missing";
  }
}

async function revalidate(cwd: string): Promise<EnabledModelsSnapshot> {
  const [project, global] = settingsPaths(cwd);
  const [projectHash, globalHash] = await Promise.all([hashOf(project), hashOf(global)]);
  const hash = `${projectHash};${globalHash}`;
  const cached = snapshots.get(cwd);
  if (cached !== undefined && cached.hash === hash) return cached;
  const [projectPatterns, globalPatterns] = await Promise.all([
    readField(project),
    readField(global),
  ]);
  const snapshot: EnabledModelsSnapshot = { patterns: projectPatterns ?? globalPatterns, hash };
  snapshots.set(cwd, snapshot);
  return snapshot;
}

export function loadEnabledModels(cwd: string): Promise<EnabledModelsSnapshot> {
  const pending = inFlight.get(cwd);
  if (pending !== undefined) return pending;
  const next = revalidate(cwd).finally(() => {
    if (inFlight.get(cwd) === next) inFlight.delete(cwd);
  });
  inFlight.set(cwd, next);
  return next;
}

export function ensureEnabledModels(cwd: string): Promise<EnabledModelsSnapshot> {
  const cached = snapshots.get(cwd);
  return cached === undefined ? loadEnabledModels(cwd) : Promise.resolve(cached);
}

export function peekEnabledModels(cwd: string): EnabledModelsSnapshot | undefined {
  return snapshots.get(cwd);
}

export function refreshEnabledModels(cwd: string): void {
  void loadEnabledModels(cwd);
}

let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

export function resolveEnabledModels(
  snapshot: EnabledModelsSnapshot | undefined,
  registry: ModelRegistryRef,
): Set<string> | undefined {
  const patterns = snapshot?.patterns;
  const patternsKey = JSON.stringify(patterns);
  const fileHash = snapshot?.hash ?? "";

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  if (!patterns || patterns.length === 0) {
    cachedHash = fileHash;
    cachedPatternsKey = patternsKey;
    cachedAllowed = undefined;
    return undefined;
  }

  const available = registry.getAvailable?.() ?? registry.getAll();
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    resolveExact(trimmed, available, allowed);
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}

export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

function resolveExact(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return;

  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find(
    (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
  if (exact) {
    allowed.add(modelKey(exact));
  }
}
