/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) and resolves
 * entries to concrete `provider/modelId` keys for scope validation.
 *
 * **Project overrides global**, mirroring pi's own `SettingsManager`
 * deep-merge behavior and matching the precedence we use for our own
 * `subagents.json` settings (see `src/settings.ts:loadSettings`). If
 * project file has `enabledModels` set, it wholly replaces global's
 * (array fields are replaced, not concatenated).
 *
 * **Limited subset of upstream's resolveModelScope.** We support exact
 * `provider/modelId` matching only. Upstream (pi-coding-agent's
 * `core/model-resolver.ts`) additionally supports glob patterns
 * (`*sonnet*`, `anthropic/*`), bare model IDs without provider, and
 * thinking-level suffixes (`provider/*:high`). Those forms are silently
 * ignored here.
 *
 * In practice, pi's `/scoped-models` picker writes exact `provider/modelId`
 * entries, so the limitation is invisible for users who configure scope
 * through pi's UI. Hand-edited settings using globs or bare IDs will
 * produce an empty allowed set (scope check becomes a no-op).
 *
 * Example:
 *   enabledModels = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]
 *   → resolves to { "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6" }
 *
 * **Loading is asynchronous and cached per cwd.** `loadEnabledModels(cwd)`
 * stats both settings files concurrently and re-reads them only when their
 * mtime/size changed; concurrent calls for one cwd share one revalidation.
 * Synchronous consumers read the last loaded snapshot with
 * `peekEnabledModels(cwd)` and must make sure a load for that cwd completed
 * first (`ensureEnabledModels`).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readTextIfExists } from "./fs-async.ts";
import type { ModelEntry } from "./model-resolver.ts";

/** Minimal registry shape — only the methods resolveEnabledModels actually calls. */
export interface ModelRegistryRef {
  getAll(): ModelEntry[];
  getAvailable?(): ModelEntry[];
}

const EnabledModelSchema = Type.String();

function isString(value: string | number | boolean | null): value is string {
  return Value.Check(EnabledModelSchema, value);
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")];
}

/** Read `enabledModels` from a single settings.json file. Undefined when missing or absent. */
async function readField(path: string): Promise<string[] | undefined> {
  try {
    const text = await readTextIfExists(path);
    if (text === undefined) return undefined;
    const raw = JSON.parse(text);
    if (Array.isArray(raw?.enabledModels)) {
      return raw.enabledModels.filter(isString);
    }
  } catch {
    /* corrupt or unreadable file — silent */
  }
  return undefined;
}

/** One loaded view of `enabledModels` for a cwd. */
export interface EnabledModelsSnapshot {
  /** Project-local overrides global; undefined when neither file has the field. */
  readonly patterns: string[] | undefined;
  /** mtime+size of both settings files when `patterns` was read. */
  readonly hash: string;
}

const snapshots = new Map<string, EnabledModelsSnapshot>();
const inFlight = new Map<string, Promise<EnabledModelsSnapshot>>();

/** mtime+size hash of one file, or "missing" if absent. */
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
  // Both reads start together; project still takes precedence over global.
  const [projectPatterns, globalPatterns] = await Promise.all([
    readField(project),
    readField(global),
  ]);
  const snapshot: EnabledModelsSnapshot = { patterns: projectPatterns ?? globalPatterns, hash };
  snapshots.set(cwd, snapshot);
  return snapshot;
}

/**
 * Load (or revalidate) `enabledModels` for `cwd` — project-local overrides
 * global. Mirrors pi's SettingsManager deep-merge for the `enabledModels`
 * field (and matches our own loadSettings precedence in src/settings.ts).
 * Never rejects: unreadable or corrupt files read as absent.
 */
export function loadEnabledModels(cwd: string): Promise<EnabledModelsSnapshot> {
  const pending = inFlight.get(cwd);
  if (pending !== undefined) return pending;
  const next = revalidate(cwd).finally(() => {
    if (inFlight.get(cwd) === next) inFlight.delete(cwd);
  });
  inFlight.set(cwd, next);
  return next;
}

/** The cached snapshot when one exists (no I/O), otherwise the first load. */
export function ensureEnabledModels(cwd: string): Promise<EnabledModelsSnapshot> {
  const cached = snapshots.get(cwd);
  return cached === undefined ? loadEnabledModels(cwd) : Promise.resolve(cached);
}

/** Last loaded snapshot for `cwd`, or undefined when no load for it has completed. */
export function peekEnabledModels(cwd: string): EnabledModelsSnapshot | undefined {
  return snapshots.get(cwd);
}

/** Start a background revalidation for `cwd`; the next peek sees an edited file. */
export function refreshEnabledModels(cwd: string): void {
  void loadEnabledModels(cwd);
}

/**
 * Resolve a snapshot's patterns → Set<"provider/modelId"> (lowercase keys).
 *
 * Only exact `provider/modelId` patterns are matched (case-insensitive).
 * Patterns without a slash, with glob characters, or with a `:thinking`
 * suffix are silently dropped. See module-level docstring for rationale.
 *
 * Cache: keyed on JSON.stringify(patterns) + the snapshot's mtime/size hash
 * of *both* project and global settings.json files. Re-resolves when either
 * file changed (a new snapshot) or the patterns differ.
 *
 * Returns undefined when no patterns are provided or no patterns match
 * (scope check becomes a no-op at the call site).
 */

// Module-level cache — invalidated when either settings.json changes or patterns differ.
let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

export function resolveEnabledModels(
  snapshot: EnabledModelsSnapshot | undefined,
  registry: ModelRegistryRef,
): Set<string> | undefined {
  const patterns = snapshot?.patterns;
  // Fast path: same patterns from the same file state
  const patternsKey = JSON.stringify(patterns);
  const fileHash = snapshot?.hash ?? "";

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  // Cache miss — resolve
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
    if (!trimmed) continue; // skip empty/whitespace
    resolveExact(trimmed, available, allowed);
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}

/**
 * True when `model` is in the allowed set. Centralizes the key format
 * (`provider/id` lowercase) so callers don't have to reproduce it —
 * both set-building (resolveExact) and lookup go through `modelKey`.
 */
export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

/**
 * Resolve exact model pattern. Example: "google/gemma-4-31b-it".
 */
function resolveExact(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  // "provider/modelId" — exact (colon is part of id, not split)
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return; // bare modelId not supported

  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find(
    (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
  if (exact) {
    allowed.add(modelKey(exact));
  }
}
