import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { obj, unknown } from "@earendil-works/pi-schema";
import type { RuntimeValue } from "../../../profile/extensions/lib/runtime-values.ts";
import { matches } from "./schema-check.ts";
import { WORKTREE, loadExtensionProfile } from "./profile.ts";

interface WorktreeFactory {
  path: string;
  factory: ExtensionFactory;
}

export interface WorktreeProfilePlan {
  factories: WorktreeFactory[];
  hostExtensionPaths: string[];
}

interface ProfileEntry {
  path: string;
  key: string;
}

const NATIVE_ENTRIES: ReadonlySet<string> = new Set<string>([
  "profile/extensions/anthropic-error-tool-results.ts",
  "profile/extensions/apex-provider.ts",
  "profile/extensions/autocomplete-anywhere.ts",
  "profile/extensions/cache-probe.ts",
  "profile/extensions/clipboard-osc52.ts",
  "profile/extensions/cache-retention.ts",
  "profile/extensions/choco-pi-lsp-visibility.ts",
  "profile/extensions/command-filter.ts",
  "profile/extensions/context-status.ts",
  "profile/extensions/diagram-policy.ts",
  "profile/extensions/diff/index.ts",
  "profile/extensions/exec-session-guidance.ts",
  "profile/extensions/file-checkpoints.ts",
  "profile/extensions/harness-check.ts",
  "profile/extensions/host-bridge.ts",
  "profile/extensions/mermaid-fallback.ts",
  "profile/extensions/model-context-cap.ts",
  "profile/extensions/model-controls.ts",
  "profile/extensions/multiplexer-images.ts",
  "profile/extensions/prompt-editor.ts",
  "profile/extensions/provider-usage.ts",
  "profile/extensions/review/index.ts",
  "profile/extensions/runtime-agent-preferences.ts",
  "profile/extensions/runtime-model-prompt.ts",
  "profile/extensions/runtime-writing-prompt.ts",
  "profile/extensions/scratch-env.ts",
  "profile/extensions/session-aliases.ts",
  "profile/extensions/session-auto-name.ts",
  "profile/extensions/session-bridge.ts",
  "profile/extensions/session-status.ts",
  "profile/extensions/stable-system-prompt.ts",
  "profile/extensions/stats.ts",
  "profile/extensions/status-commands.ts",
  "profile/extensions/stop-control.ts",
  "profile/extensions/task-lineage.ts",
  "profile/extensions/tool-search.ts",
  "profile/extensions/usage-limit-policy.ts",
  "profile/extensions/verdict-block-render.ts",
  "profile/extensions/xai-search.ts",
  "packages/choco-pi-web-search/extension.ts",
  "packages/choco-pi-shells/src/index.ts",
  "packages/choco-pi-hooks/src/extension.ts",
  "packages/choco-pi-subagents/src/index.ts",
  "packages/choco-pi-advisor/src/index.ts",
  "packages/choco-pi-goal/src/index.ts",
  "packages/choco-pi-mcp/figma/index.ts",
  "packages/choco-pi-lsp/index.ts",
  "packages/choco-pi-compaction/src/index.ts",
  "packages/choco-pi-codex/src/index.ts",
  "packages/choco-pi-code-mode/src/extension.ts",
  "packages/choco-pi-agents-md/index.ts",
  "packages/choco-pi-agent-browser/extensions/agent-browser/index.ts",
  "packages/choco-pi-computer-use/extensions/computer-use.ts",
  "packages/choco-pi-editor-context/src/context-extension.ts",
]);

const BUNDLER_RESOLUTION =
  "package uses Bundler-style extensionless relative imports: native ESM cannot resolve them and the root NodeNext typecheck rejects the package sources";

const HOST_LOADED_ENTRIES: ReadonlyMap<string, string> = new Map<string, string>([
  ["packages/choco-pi-provider-synthetic/extensions/provider/index.ts", BUNDLER_RESOLUTION],
  ["packages/choco-pi-provider-synthetic/extensions/web-search/index.ts", BUNDLER_RESOLUTION],
  ["packages/choco-pi-provider-synthetic/extensions/command-quotas/index.ts", BUNDLER_RESOLUTION],
  [
    "packages/choco-pi-provider-synthetic/extensions/sub-bar-integration/index.ts",
    BUNDLER_RESOLUTION,
  ],
  ["packages/choco-pi-provider-synthetic/extensions/quota-warnings/index.ts", BUNDLER_RESOLUTION],
  ["packages/choco-pi-provider-synthetic/extensions/usage-status/index.ts", BUNDLER_RESOLUTION],
  ["packages/choco-pi-ui/extensions/zentui/index.ts", BUNDLER_RESOLUTION],
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

const extensionModuleSchema = obj({ default: unknown() }, { open: true });

function isExtensionFactory(value: RuntimeValue): value is ExtensionFactory {
  return value instanceof Function;
}

async function loadEntry(entry: ProfileEntry): Promise<WorktreeFactory> {
  if (!NATIVE_ENTRIES.has(entry.key)) {
    throw new Error(`No native loader for extension entry: ${entry.key}`);
  }
  const namespace: unknown = await import(pathToFileURL(join(WORKTREE, entry.key)).href);
  if (!matches(extensionModuleSchema, namespace) || !isExtensionFactory(namespace.default)) {
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
