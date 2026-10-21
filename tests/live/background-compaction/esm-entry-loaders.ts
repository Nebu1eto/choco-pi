import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WORKTREE, loadExtensionProfile } from "./profile.ts";

interface WorktreeFactory {
  path: string;
  factory: ExtensionFactory;
}

export interface WorktreeProfilePlan {
  /** Natively imported, runtime-validated default factories in profile order. */
  factories: WorktreeFactory[];
  /** Canonical entries the SDK host loader must load from disk, in profile order. */
  hostExtensionPaths: string[];
}

interface ProfileEntry {
  path: string;
  key: string;
}

/**
 * Entries natively imported through a computed file URL, keyed by
 * worktree-relative POSIX path. The specifier is not a literal, so the root
 * typecheck does not pull package sources into its program; each module shape
 * is validated at runtime instead. A profile entry absent from both this set
 * and HOST_LOADED_ENTRIES fails closed before any module is imported.
 */
const NATIVE_ENTRIES: ReadonlySet<string> = new Set<string>([
  ".pi/extensions/anthropic-error-tool-results.ts",
  ".pi/extensions/apex-provider.ts",
  ".pi/extensions/autocomplete-anywhere.ts",
  ".pi/extensions/cache-probe.ts",
  ".pi/extensions/cache-retention.ts",
  ".pi/extensions/choco-pi-lsp-visibility.ts",
  ".pi/extensions/command-filter.ts",
  ".pi/extensions/context-status.ts",
  ".pi/extensions/diagram-policy.ts",
  ".pi/extensions/exec-session-guidance.ts",
  ".pi/extensions/file-checkpoints.ts",
  ".pi/extensions/harness-check.ts",
  ".pi/extensions/host-bridge.ts",
  ".pi/extensions/mermaid-fallback.ts",
  ".pi/extensions/model-context-cap.ts",
  ".pi/extensions/model-controls.ts",
  ".pi/extensions/multiplexer-images.ts",
  ".pi/extensions/prompt-editor.ts",
  ".pi/extensions/provider-usage.ts",
  ".pi/extensions/review/index.ts",
  ".pi/extensions/runtime-agent-preferences.ts",
  ".pi/extensions/runtime-model-prompt.ts",
  ".pi/extensions/runtime-writing-prompt.ts",
  ".pi/extensions/session-aliases.ts",
  ".pi/extensions/session-auto-name.ts",
  ".pi/extensions/session-bridge.ts",
  ".pi/extensions/session-status.ts",
  ".pi/extensions/stable-system-prompt.ts",
  ".pi/extensions/status-commands.ts",
  ".pi/extensions/task-lineage.ts",
  ".pi/extensions/tool-search.ts",
  ".pi/extensions/usage-limit-policy.ts",
  ".pi/extensions/xai-search.ts",
  ".pi/packages/choco-pi-web-search/extension.ts",
  ".pi/packages/choco-pi-web-access/index.ts",
  ".pi/packages/choco-pi-shells/src/index.ts",
  ".pi/packages/choco-pi-hooks/src/extension.ts",
  ".pi/packages/choco-pi-subagents/src/index.ts",
  ".pi/packages/choco-pi-advisor/src/index.ts",
  ".pi/packages/choco-pi-goal/src/index.ts",
  ".pi/packages/choco-pi-mcp/figma/index.ts",
  ".pi/packages/choco-pi-lsp/index.ts",
  ".pi/packages/choco-pi-compaction/src/index.ts",
  ".pi/packages/choco-pi-codex/src/index.ts",
  ".pi/packages/choco-pi-agents-md/index.ts",
  ".pi/packages/choco-pi-agent-browser/extensions/agent-browser/index.ts",
  ".pi/packages/choco-pi-computer-use/extensions/computer-use.ts",
  ".pi/packages/choco-pi-editor-context/src/context-extension.ts",
]);

const BUNDLER_RESOLUTION =
  "package uses Bundler-style extensionless relative imports: native ESM cannot resolve them and the root NodeNext typecheck rejects the package sources";

/**
 * Entries that cannot be natively imported with static types without editing
 * their packages; they stay on the SDK host loader path instead.
 */
const HOST_LOADED_ENTRIES: ReadonlyMap<string, string> = new Map<string, string>([
  [".pi/packages/choco-pi-provider-synthetic/extensions/provider/index.ts", BUNDLER_RESOLUTION],
  [".pi/packages/choco-pi-provider-synthetic/extensions/web-search/index.ts", BUNDLER_RESOLUTION],
  [
    ".pi/packages/choco-pi-provider-synthetic/extensions/command-quotas/index.ts",
    BUNDLER_RESOLUTION,
  ],
  [
    ".pi/packages/choco-pi-provider-synthetic/extensions/sub-bar-integration/index.ts",
    BUNDLER_RESOLUTION,
  ],
  [
    ".pi/packages/choco-pi-provider-synthetic/extensions/quota-warnings/index.ts",
    BUNDLER_RESOLUTION,
  ],
  [".pi/packages/choco-pi-provider-synthetic/extensions/usage-status/index.ts", BUNDLER_RESOLUTION],
  [".pi/packages/choco-pi-ui/extensions/zentui/index.ts", BUNDLER_RESOLUTION],
]);

function toKey(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function duplicates(keys: string[]): string[] {
  return keys.filter((key, index) => keys.indexOf(key) !== index);
}

function setDifference(left: Iterable<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((key) => !right.has(key));
}

function describeList(items: string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

/**
 * Throws unless the profile keys equal NATIVE_ENTRIES ∪ HOST_LOADED_ENTRIES,
 * the two maps are disjoint, and the profile has no duplicates.
 */
function assertLoaderCoverage(profileKeys: string[]): void {
  const profileSet = new Set(profileKeys);
  const covered = new Set([...NATIVE_ENTRIES, ...HOST_LOADED_ENTRIES.keys()]);
  const repeated = duplicates(profileKeys);
  const overlap = [...HOST_LOADED_ENTRIES.keys()].filter((key) => NATIVE_ENTRIES.has(key));
  const unmapped = setDifference(profileSet, covered);
  const unexpected = setDifference(covered, profileSet);
  const problems = [repeated, overlap, unmapped, unexpected];
  if (problems.every((list) => list.length === 0)) return;
  throw new Error(
    [
      "Worktree extension loaders do not match the resolved profile",
      `duplicate: ${describeList(repeated)}`,
      `both native and host: ${describeList(overlap)}`,
      `unmapped profile entries: ${describeList(unmapped)}`,
      `loaders outside profile: ${describeList(unexpected)}`,
    ].join("; "),
  );
}

function assertPlanMatchesProfile(profile: string[], plan: WorktreeProfilePlan): void {
  const planned = new Set([
    ...plan.factories.map((entry) => entry.path),
    ...plan.hostExtensionPaths,
  ]);
  const count = plan.factories.length + plan.hostExtensionPaths.length;
  const same =
    count === profile.length &&
    planned.size === count &&
    profile.every((path) => planned.has(path));
  if (!same) throw new Error("Worktree extension plan diverged from the resolved profile");
}

/** Runtime shape of a native entry module: a callable default export. */
const extensionModuleSchema = Type.Object({
  default: Type.Function([Type.Unknown()], Type.Void()),
});

async function loadEntry(entry: ProfileEntry): Promise<WorktreeFactory> {
  if (!NATIVE_ENTRIES.has(entry.key)) {
    throw new Error(`No native loader for extension entry: ${entry.key}`);
  }
  const namespace: unknown = await import(pathToFileURL(join(WORKTREE, entry.key)).href);
  if (!Value.Check(extensionModuleSchema, namespace)) {
    throw new Error(`Extension entry has no default factory function: ${entry.key}`);
  }
  const factory: ExtensionFactory = namespace.default;
  return { path: entry.path, factory };
}

async function loadSequentially(entries: ProfileEntry[]): Promise<WorktreeFactory[]> {
  const loaded: WorktreeFactory[] = [];
  for (const entry of entries) loaded.push(await loadEntry(entry));
  return loaded;
}

async function resolveProfileEntries(): Promise<{ profile: string[]; entries: ProfileEntry[] }> {
  const profile = await loadExtensionProfile();
  const root = await realpath(WORKTREE);
  return { profile, entries: profile.map((path) => ({ path, key: toKey(root, path) })) };
}

/**
 * Resolves the full worktree profile and natively imports every typed entry in
 * profile order. Coverage is asserted before any module is imported, so no
 * module outside the resolved profile is loaded; the returned factories and
 * host paths together are exactly the resolved profile.
 */
export async function loadWorktreeProfilePlan(): Promise<WorktreeProfilePlan> {
  const { profile, entries } = await resolveProfileEntries();
  assertLoaderCoverage(entries.map((entry) => entry.key));
  const hostExtensionPaths = entries
    .filter((entry) => HOST_LOADED_ENTRIES.has(entry.key))
    .map((entry) => entry.path);
  const factories = await loadSequentially(
    entries.filter((entry) => NATIVE_ENTRIES.has(entry.key)),
  );
  const plan = { factories, hostExtensionPaths };
  assertPlanMatchesProfile(profile, plan);
  return plan;
}
