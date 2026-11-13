/**
 * Installs this checkout as the user's Pi profile.
 *
 * An installed agent directory must always match the profile layout at HEAD.
 * Every profile-owned file under `<agentDir>` is therefore handled here in one
 * of two ways:
 *
 * - Linked: listed in `PROFILE_LINKS`, so the installed path is a symlink to
 *   the tracked source and always has its current shape.
 * - Migrated: user-owned state whose profile-derived keys change with the
 *   layout, listed in `MIGRATED_SIDECARS` and rewritten by a migration step
 *   below that keeps the user's own keys.
 *
 * A new `profile/extensions/*.json` sidecar must join one of the two lists; a test
 * fails until it does.
 *
 * A file an earlier profile installed and HEAD no longer ships is listed in
 * `RETIRED_PROFILE_FILES` and removed on install.
 */
import { constants, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isJsonRecord, type JsonRecord } from "../profile/extensions/lib/runtime-values.ts";
import { resolvePiLauncher, writeProfileMarker } from "../profile/extensions/lib/profile-marker.ts";
import { PI_SDK_REQUIREMENT, isSupportedPiVersion } from "../profile/extensions/lib/pi-target.ts";
import { readAnthropicCompactionMode } from "../packages/choco-pi-compaction/src/anthropic/mode.ts";
import {
  deriveBackgroundLanes,
  globalBackgroundSettingsPath,
  SidecarRefusedError,
  writeGlobalBackgroundSettings,
} from "../packages/choco-pi-compaction/src/background/settings.ts";
import { arr, compile, map, obj, opt, str, unknown, type Static } from "@earendil-works/pi-schema";

const SettingsSchema = obj(
  {
    packages: opt(arr(str())),
    extensions: opt(arr(str())),
    skills: opt(arr(str())),
    prompts: opt(arr(str())),
    modelThinkingLevels: opt(map(str())),
    enabledModels: opt(arr(str())),
  },
  { open: true },
);
const isSettings = compile(SettingsSchema).check;
type Settings = Static<typeof SettingsSchema> & JsonRecord;
type ProjectSettings = Settings & { packages: string[] };
export type InstallLinkResult = {
  target: string;
  action: "unchanged" | "linked" | "backed-up";
  backup?: string;
};
export type InstallProfileOptions = {
  root?: string;
  agentDir?: string;
  backup?: boolean;
  piLauncher?: string;
};
export type SidecarMigrationResult = {
  target: string;
  action: "migrated" | "unchanged" | "absent" | "skipped";
};

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROFILE_LINKS: readonly (readonly [string, string])[] = [
  ["profile/SYSTEM.md", "SYSTEM.md"],
  ["profile/writing-policy.md", "writing-policy.md"],
  ["profile/review-policy.md", "review-policy.md"],
  ["profile/choco-pi-codex.json", "choco-pi-codex.json"],
  ["profile/subagents.json", "subagents.json"],
  ["profile/zentui.json", "choco-pi-ui.json"],
  ["profile/models.json", "models.json"],
  ["profile/keybindings.json", "keybindings.json"],
  ["profile/agents/advisor.md", "agents/advisor.md"],
  ["profile/agents/general.md", "agents/general.md"],
  ["profile/agents/planner.md", "agents/planner.md"],
  ["profile/agents/implementer.md", "agents/implementer.md"],
  ["profile/agents/reviewer.md", "agents/reviewer.md"],
  ["profile/agents/verifier.md", "agents/verifier.md"],
  ["profile/agents/handoff.md", "agents/handoff.md"],
  ["profile/agents/explore.md", "agents/explore.md"],
  ["profile/extensions/apex-provider.json", "extensions/apex-provider.json"],
  ["profile/extensions/review.json", "extensions/review.json"],
];

/**
 * Agent-directory sidecars the installer migrates in place instead of linking,
 * relative to the agent directory. They hold user choices (such as the
 * background-compaction master switch), so they cannot be links.
 */
export const MIGRATED_SIDECARS: readonly string[] = ["extensions/background-compaction.json"];

/**
 * Agent-directory files earlier profiles installed that HEAD no longer ships,
 * relative to the agent directory. `extensions/context-cap.json` was replaced
 * by the `contextSoftCap` and `autoCompactionPoint` preferences; a stale copy
 * or link would otherwise suggest it still configures the cap.
 */
export const RETIRED_PROFILE_FILES: readonly string[] = ["extensions/context-cap.json"];

/**
 * Bundled packages Pi loads, in load order, named relative to the checkout root. Order is
 * load-bearing: `choco-pi-web-search` must precede `choco-pi-web-access`.
 * `choco-pi-acp` is absent because Pi never loads it. A test fails until a new
 * bundled Pi package joins this list.
 */
export const DEFAULT_PROFILE_PACKAGES: readonly string[] = [
  "./packages/choco-pi-web-search",
  "./packages/choco-pi-web-access",
  "./packages/choco-pi-provider-synthetic",
  "./packages/choco-pi-ui",
  "./packages/choco-pi-shells",
  "./packages/choco-pi-hooks",
  "./packages/choco-pi-subagents",
  "./packages/choco-pi-advisor",
  "./packages/choco-pi-goal",
  "./packages/choco-pi-mcp",
  "./packages/choco-pi-lsp",
  "./packages/choco-pi-compaction",
  "./packages/choco-pi-codex",
  "./packages/choco-pi-agents-md",
  "./packages/choco-pi-agent-browser",
  "./packages/choco-pi-computer-use",
  "./packages/choco-pi-editor-context",
];

/**
 * Built-in extension policy every install carries. choco-pi keeps its own
 * `exec` code-mode bridge and registers its own `tool_search`, so Pi's
 * built-in `codemode` and `tool-search` stay off; with `tool-search` left on,
 * Pi would omit it anyway but report the replacement at every startup.
 */
export const DEFAULT_PROFILE_EXTENSIONS: readonly string[] = [
  "-builtin:codemode",
  "-builtin:tool-search",
];

/**
 * `extensions` with the profile's built-in policy enforced: entries for the
 * same built-ins are replaced, everything else keeps its place.
 */
function withProfileExtensionPolicy(extensions: readonly string[] | undefined): string[] {
  const policyNames = new Set(DEFAULT_PROFILE_EXTENSIONS.map(builtinOverrideName));
  return [
    ...(extensions ?? []).filter((entry) => !policyNames.has(builtinOverrideName(entry))),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ];
}

/**
 * Model scope (`/scoped-models`) a clean install starts from: the
 * maintainer's current `enabledModels`. Pi warns about a pattern whose
 * provider has no credentials, and the subagent scope check uses this list.
 */
export const DEFAULT_PROFILE_ENABLED_MODELS: readonly string[] = [
  "anthropic/claude-mythos-5-2",
  "anthropic/claude-fable-5-2",
  "anthropic/claude-mythos-5-1",
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6.1-sol",
  "openai-codex/gpt-6.1-terra",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-6-luna",
  "synthetic/hf:moonshotai/Kimi-K3.1-Pro",
  "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "synthetic/hf:zai-org/GLM-5.3",
  "synthetic/hf:zai-org/GLM-5.3-Flash",
  "xai/grok-4.6",
  "xai/grok-4.7",
];

/**
 * Per-model default thinking levels a clean install starts from: the
 * maintainer's current `modelThinkingLevels`, including models outside the
 * scope that usage-limit fallback can switch to. The user's entries win.
 */
export const DEFAULT_PROFILE_MODEL_THINKING_LEVELS = {
  "anthropic/claude-fable-5": "high",
  "anthropic/claude-opus-5": "medium",
  "anthropic/claude-opus-4-6": "high",
  "anthropic/claude-sonnet-5": "xhigh",
  "openai/gpt-6-astra": "low",
  "openai-codex/gpt-6-astra": "low",
  "openai/gpt-5.6-sol": "low",
  "openai-codex/gpt-5.6-sol": "low",
  "openai/gpt-daybreak-blue-latest": "high",
  "openai/gpt-5.6-terra": "high",
  "openai-codex/gpt-5.6-terra": "high",
  "openai/gpt-5.6-luna": "xhigh",
  "openai-codex/gpt-5.6-luna": "xhigh",
  "synthetic/hf:moonshotai/Kimi-K3": "high",
  "anthropic/claude-fable-5-1": "low",
  "anthropic/claude-opus-5-5": "medium",
  "anthropic/claude-sonnet-5-5": "medium",
  "anthropic/claude-haiku-5-5": "medium",
  "openai/gpt-6-sol": "low",
  "openai-codex/gpt-6-sol": "low",
  "openai/gpt-6.1-sol": "low",
  "openai-codex/gpt-6.1-sol": "low",
  "openai/gpt-6.1-terra": "high",
  "openai-codex/gpt-6.1-terra": "high",
  "openai/gpt-6-luna": "high",
  "openai-codex/gpt-6-luna": "high",
  "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash": "low",
  "synthetic/hf:zai-org/GLM-5.3": "high",
  "synthetic/hf:zai-org/GLM-5.3-Flash": "high",
  "anthropic/claude-mythos-5-1": "low",
  "anthropic/claude-fable-5-2": "high",
  "anthropic/claude-mythos-5-2": "high",
  "synthetic/hf:moonshotai/Kimi-K3.1-Pro": "high",
  "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017": "high",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Remove each retired file that is still a symlink (dangling or not) or a
 * regular file. Anything else at that path is left in place with a warning.
 * Returns the removed paths.
 */
async function removeRetiredProfileFiles(agentDir: string, warnings: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const relative of RETIRED_PROFILE_FILES) {
    const target = path.resolve(agentDir, relative);
    let isRemovable: boolean;
    try {
      const status = await lstat(target);
      isRemovable = status.isSymbolicLink() || status.isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!isRemovable) {
      warnings.push(`${target} is retired but is not a file or symlink; left in place.`);
      continue;
    }
    await rm(target);
    removed.push(target);
  }
  return removed;
}

const CodexCompactionSchema = obj(
  {
    compaction: opt(obj({ responsesCompaction: opt(unknown()) }, { open: true })),
  },
  { open: true },
);
const isCodexCompaction = compile(CodexCompactionSchema).check;
const ManifestSupersedesSchema = obj(
  { chocoPi: opt(obj({ supersedes: opt(arr(str())) }, { open: true })) },
  { open: true },
);
const hasValidSupersedes = compile(ManifestSupersedesSchema).check;

/**
 * Whether the installed codex config compacts server-side. Mirrors the codex
 * adapter: `compaction.responsesCompaction` must be a boolean, and anything
 * else (including a missing file or key) is the default `false`. Throws when
 * the file exists but is not a JSON object, so the caller can skip migration
 * instead of deriving lanes from a file it could not read.
 */
async function readCodexResponsesCompaction(agentDir: string): Promise<boolean> {
  const target = path.join(agentDir, "choco-pi-codex.json");
  let contents: string;
  try {
    contents = await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${target} does not contain valid JSON`, { cause: error });
  }
  if (!isCodexCompaction(parsed)) {
    throw new Error(`${target} is not a codex config object`);
  }
  // Only a literal `true` turns it on; any non-boolean is the default `false`.
  return parsed.compaction?.responsesCompaction === true;
}

/**
 * Bring the global background-compaction sidecar's backend switches in line
 * with the vendor compaction modes: text always on, codex-native from
 * `compaction.responsesCompaction` in the installed codex config,
 * anthropic-native when `compactionAnthropic` is server-side (the default).
 * The master switch and every other key are kept; a missing sidecar stays
 * missing (background compaction stays off). A malformed sidecar is left
 * untouched and reported as a warning.
 */
export async function migrateBackgroundCompactionSidecar(
  agentDir: string,
  warnings: string[],
): Promise<SidecarMigrationResult> {
  const target = globalBackgroundSettingsPath(agentDir);
  let openaiServerSide: boolean;
  try {
    openaiServerSide = await readCodexResponsesCompaction(agentDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`${target} was not migrated: ${reason}`);
    return { target, action: "skipped" };
  }
  const anthropicServerSide = (await readAnthropicCompactionMode(agentDir)) === "server-side";
  const lanes = deriveBackgroundLanes({
    openaiServerSide,
    anthropicServerSide,
  });
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { target, action: "absent" };
    }
    throw error;
  }
  try {
    const changed = await writeGlobalBackgroundSettings(agentDir, {
      lanes,
      onlyIfExists: true,
    });
    return { target, action: changed ? "migrated" : "unchanged" };
  } catch (error) {
    if (!(error instanceof SidecarRefusedError)) throw error;
    warnings.push(error.message);
    return { target, action: "skipped" };
  }
}

async function exists(target: string) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target: string, fallback?: Settings): Promise<Settings> {
  if (!(await exists(target))) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${target} does not exist`);
  }
  const contents = await readFile(target, "utf8");
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isJsonRecord(parsed) || !isSettings(parsed)) throw new Error("invalid settings shape");
    return parsed;
  } catch (error) {
    // The CLI prints only `error.message`, so a bare SyntaxError would report a
    // parse position with no file. Returning the fallback instead would be
    // worse: the installer would silently write settings derived from a file it
    // could not read.
    throw new Error(`${target} does not contain valid JSON`, { cause: error });
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

/**
 * Identity of a package spec. A bundled package is `local:<name>` whether it
 * is named relatively, by this checkout's `packages/<name>` path, by the
 * `packages/<name>` path inside the `.pi` directory of an old-layout checkout,
 * or by another checkout's `packages/<name>` path when `<name>` is one of
 * `bundledNames`. The last shape is generic, so only bundled names qualify.
 */
function packageIdentity(
  spec: string,
  root: string,
  bundledNames: ReadonlySet<string> = new Set(),
) {
  const relativeMatch = spec.match(/^\.\/packages\/([^/]+)$/);
  if (relativeMatch) return `local:${relativeMatch[1]}`;
  if (path.isAbsolute(spec)) {
    const resolved = path.resolve(spec);
    const packageDir = path.dirname(resolved);
    const name = path.basename(resolved);
    if (packageDir === path.resolve(root, "packages")) return `local:${name}`;
    if (path.basename(packageDir) === "packages") {
      if (path.basename(path.dirname(packageDir)) === ".pi") return `local:${name}`;
      if (bundledNames.has(name)) return `local:${name}`;
    }
  }
  if (spec.startsWith("npm:")) return `npm:${npmPackageName(spec.slice(4))}`;
  return spec;
}

function npmPackageName(raw: string) {
  if (raw.startsWith("@")) {
    const slash = raw.indexOf("/");
    const versionAt = slash === -1 ? -1 : raw.indexOf("@", slash);
    return versionAt === -1 ? raw : raw.slice(0, versionAt);
  }
  const versionAt = raw.indexOf("@");
  return versionAt === -1 ? raw : raw.slice(0, versionAt);
}

function specVersion(spec: string) {
  if (!spec.startsWith("npm:")) return undefined;
  const match = spec.slice(4).match(/@(\d[^@/]*)$/);
  return match?.[1];
}

function compareSpecVersions(left: string, right: string) {
  const leftVersion = specVersion(left);
  const rightVersion = specVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) return 0;
  const leftParts = leftVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = rightVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function mergePackages(canonical: string[], existing: string[], root: string) {
  const bundledDir = path.resolve(root, "packages");
  const bundledNames = new Set(
    canonical
      .filter((spec) => path.isAbsolute(spec) && path.dirname(path.resolve(spec)) === bundledDir)
      .map((spec) => path.basename(path.resolve(spec))),
  );
  const canonicalIds = new Set(canonical.map((spec) => packageIdentity(spec, root, bundledNames)));
  const extras = new Map<string, string>();
  for (const spec of existing) {
    const identity = packageIdentity(spec, root, bundledNames);
    if (canonicalIds.has(identity)) continue;
    const current = extras.get(identity);
    if (current === undefined || compareSpecVersions(spec, current) > 0) extras.set(identity, spec);
  }
  return unique([...canonical, ...extras.values()]);
}

/**
 * Bare package name behind an identity, without its `npm:` or `local:` prefix.
 * A predecessor can be installed either way — pi-zentui and pi-synthetic are
 * listed as checkout paths, pi-lens as an npm spec — so supersession has to
 * match on the name alone.
 */
function identityName(identity: string) {
  const separator = identity.indexOf(":");
  return separator === -1 ? identity : identity.slice(separator + 1);
}

/**
 * True when the entry is a profile resource directory (`extensions`, `skills`
 * or `prompts`) other than this checkout's `profile/<name>`: the `.pi/<name>`
 * directory of any old-layout checkout, this one included, or the
 * `profile/<name>` directory of another checkout that `foreignCheckouts` lists.
 * `profile` is a generic directory name, so a `<x>/profile/<name>` entry is
 * dropped only when `<x>` was confirmed as a choco-pi checkout (see
 * `confirmedForeignCheckouts`); otherwise it is the user's.
 *
 * Such a directory is a previous install of this same profile. Keeping it
 * alongside the new root makes pi load two copies of every extension, and it
 * refuses to start when both register the same tool ("Tool session_create
 * conflicts with ..."). Directories outside that shape belong to the user and
 * are preserved.
 */
function isForeignProfileDirectory(
  entry: string,
  root: string,
  name: string,
  foreignCheckouts: ReadonlySet<string>,
) {
  if (!path.isAbsolute(entry)) return false;
  const resolved = path.resolve(entry);
  if (path.basename(resolved) !== name) return false;
  if (resolved === path.resolve(root, "profile", name)) return false;
  const parent = path.basename(path.dirname(resolved));
  if (parent === ".pi") return true;
  return parent === "profile" && foreignCheckouts.has(path.dirname(path.dirname(resolved)));
}

const PROFILE_DIRECTORY_NAMES = ["extensions", "skills", "prompts"] as const;
const RootManifestSchema = obj({ name: opt(str()) }, { open: true });
const isRootManifest = compile(RootManifestSchema).check;

/**
 * Whether `checkout` is a choco-pi checkout in the new layout: it ships
 * `profile/SYSTEM.md` and the bundled `packages/choco-pi-ui`, or its root
 * `package.json` is the `choco-pi-harness` workspace.
 */
async function isChocoPiCheckout(checkout: string) {
  if (
    (await exists(path.join(checkout, "profile", "SYSTEM.md"))) &&
    (await exists(path.join(checkout, "packages", "choco-pi-ui", "package.json")))
  ) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
    return isRootManifest(parsed) && parsed.name === "choco-pi-harness";
  } catch {
    return false;
  }
}

/**
 * Other checkouts whose `profile/<name>` directories the existing settings
 * list and that are confirmed choco-pi checkouts, by absolute root path.
 */
async function confirmedForeignCheckouts(existingSettings: Settings, root: string) {
  const candidates = new Set<string>();
  for (const name of PROFILE_DIRECTORY_NAMES) {
    for (const entry of existingSettings[name] ?? []) {
      if (!path.isAbsolute(entry)) continue;
      const resolved = path.resolve(entry);
      if (path.basename(resolved) !== name) continue;
      if (path.basename(path.dirname(resolved)) !== "profile") continue;
      const checkout = path.dirname(path.dirname(resolved));
      if (checkout !== path.resolve(root)) candidates.add(checkout);
    }
  }
  const confirmed = new Set<string>();
  for (const checkout of candidates) {
    if (await isChocoPiCheckout(checkout)) confirmed.add(checkout);
  }
  return confirmed;
}

/**
 * Name of the Pi built-in extension an `extensions` override entry targets,
 * such as `codemode` for `-builtin:codemode`, or undefined for any other entry.
 */
function builtinOverrideName(entry: string) {
  // Settings entries are user-edited JSON; a non-string never stringifies to a match.
  return /^[+\-!]builtin:(.+)$/.exec(String(entry))?.[1];
}

export function buildGlobalSettings(
  projectSettings: ProjectSettings,
  existingSettings: Settings,
  root: string,
  supersededNames: string[] = [],
  foreignCheckouts: ReadonlySet<string> = new Set(),
): Settings & {
  packages: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
} {
  const canonicalPackages = projectSettings.packages.map((spec) =>
    spec.startsWith("./") ? path.resolve(root, spec) : spec,
  );
  const rooted = (name: string) => path.resolve(root, "profile", name);
  const superseded = new Set(supersededNames);
  const retainedPackages = (existingSettings.packages ?? []).filter(
    (spec) => !superseded.has(identityName(packageIdentity(spec, root))),
  );
  const profileDirectories = (name: "extensions" | "skills" | "prompts") => [
    rooted(name),
    ...(existingSettings[name] ?? []).filter(
      (entry) => !isForeignProfileDirectory(entry, root, name, foreignCheckouts),
    ),
  ];
  const thinkingLevels = {
    ...projectSettings.modelThinkingLevels,
    ...existingSettings.modelThinkingLevels,
  };
  // The profile's built-in extension policy (`-builtin:<name>`) has to reach the
  // global settings, because Pi only reads the project file from this checkout.
  // Built-in exclusions exactly match the project policy. Preserve unrelated
  // extension paths and explicit enable overrides for other built-ins.
  const builtinPolicy = (projectSettings.extensions ?? []).filter(
    (entry) => builtinOverrideName(entry) !== undefined,
  );
  const policyNames = new Set(builtinPolicy.map(builtinOverrideName));
  const extensions = profileDirectories("extensions").filter(
    (entry) =>
      !policyNames.has(builtinOverrideName(entry)) &&
      !entry.startsWith("-builtin:") &&
      !entry.startsWith("!builtin:"),
  );
  return {
    ...existingSettings,
    ...projectSettings,
    // Per-model thinking levels are tuned by the user as models change: the
    // profile only fills in models the user has not set.
    ...(Object.keys(thinkingLevels).length > 0 && {
      modelThinkingLevels: thinkingLevels,
    }),
    packages: mergePackages(canonicalPackages, retainedPackages, root),
    extensions: unique([...extensions, ...builtinPolicy]),
    skills: unique(profileDirectories("skills")),
    prompts: unique(profileDirectories("prompts")),
  };
}

function backupPath(target: string) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return `${target}.backup-${stamp}`;
}

async function sameFileContents(left: string, right: string) {
  try {
    return (await readFile(left)).equals(await readFile(right));
  } catch {
    return false;
  }
}

function isMissingPathError(error: Error) {
  return "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Where an old-layout install linked a profile file from: the tracked source
 * path before `.pi/` became `profile/`, such as `.pi/SYSTEM.md`.
 */
function legacySourceRelative(sourceRelative: string) {
  const prefix = "profile/";
  return sourceRelative.startsWith(prefix)
    ? `.pi/${sourceRelative.slice(prefix.length)}`
    : undefined;
}

/**
 * State of an installed profile link target:
 * - `absent`: nothing there yet;
 * - `current`: a symlink to the tracked source;
 * - `same-file`: a regular file with the source's contents;
 * - `legacy`: a symlink an old-layout install wrote, either to this checkout's
 *   old source path (`<root>/.pi/...`) or a dangling one whose target ends with
 *   that old relative path (a moved or deleted old-layout checkout);
 * - `conflict`: anything else, which only `--backup` may replace.
 */
type LinkState = "absent" | "current" | "same-file" | "legacy" | "conflict";

async function classifyLink(
  root: string,
  sourceRelative: string,
  target: string,
): Promise<LinkState> {
  const source = path.resolve(root, sourceRelative);
  let status: Stats;
  try {
    status = await lstat(target);
  } catch (error) {
    if (error instanceof Error && isMissingPathError(error)) return "absent";
    throw error;
  }
  if (!status.isSymbolicLink()) {
    return status.isFile() && (await sameFileContents(source, target)) ? "same-file" : "conflict";
  }
  const current = path.resolve(path.dirname(target), await readlink(target));
  if (current === source) return "current";
  const legacy = legacySourceRelative(sourceRelative);
  if (legacy === undefined) return "conflict";
  if (current === path.resolve(root, legacy)) return "legacy";
  try {
    await stat(target);
    return "conflict";
  } catch (error) {
    if (!(error instanceof Error && isMissingPathError(error))) throw error;
  }
  // Dangling: the old checkout moved or its `.pi` sources are gone.
  return current.endsWith(`${path.sep}${path.normalize(legacy)}`) ? "legacy" : "conflict";
}

/** Replace the symlink at `target` with one to `source` in a single rename. */
async function replaceSymlink(source: string, target: string) {
  const temporary = `${target}.${process.pid}.link.tmp`;
  await rm(temporary, { force: true });
  await symlink(source, temporary);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function installLink(
  root: string,
  sourceRelative: string,
  target: string,
  backup: boolean,
): Promise<InstallLinkResult> {
  const source = path.resolve(root, sourceRelative);
  await mkdir(path.dirname(target), { recursive: true });
  const state = await classifyLink(root, sourceRelative, target);
  if (state === "absent") {
    await symlink(source, target);
    return { target, action: "linked" };
  }
  if (state === "current") return { target, action: "unchanged" };
  if (state === "same-file") {
    await rm(target);
    await symlink(source, target);
    return { target, action: "linked" };
  }
  if (state === "legacy") {
    await replaceSymlink(source, target);
    return { target, action: "linked" };
  }
  if (!backup) {
    throw new Error(`${target} already exists; rerun with --backup to preserve and replace it`);
  }
  const saved = backupPath(target);
  await rename(target, saved);
  try {
    await symlink(source, target);
  } catch (error) {
    await rename(saved, target);
    throw error;
  }
  return { target, action: "backed-up", backup: saved };
}

async function writeSettings(target: string, settings: Settings) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

/**
 * Package names each bundled fork replaces, declared as `chocoPi.supersedes`
 * in the fork's own package.json and documented in its VENDORED.md. Installing
 * this profile must remove the predecessors: a fork and the package it forked
 * register the same tools and commands, and pi refuses to start on a conflict.
 */
async function supersededPackageNames(root: string, projectSettings: ProjectSettings) {
  const names = [];
  const bundled = path.join(root, "packages");
  for (const spec of projectSettings.packages) {
    // The defaults name bundled packages as `./packages/<name>`; project and
    // global settings name them by absolute path (see readProfileSettings).
    const packageDir = spec.startsWith("./") ? path.resolve(root, spec) : spec;
    if (!path.isAbsolute(packageDir) || path.dirname(packageDir) !== bundled) continue;
    const manifest = await readJson(path.join(packageDir, "package.json"), {});
    if (!hasValidSupersedes(manifest)) throw new Error(`invalid chocoPi.supersedes in ${spec}`);
    for (const name of manifest.chocoPi?.supersedes ?? []) names.push(name);
  }
  return names;
}

/**
 * The profile policy: the checkout's `.pi/settings.json` when present,
 * otherwise the global settings an earlier install wrote, which carry the same
 * packages and built-in extension policy. A clean machine has neither, so it
 * starts from the tracked defaults.
 */
async function readProfileSettings(
  root: string,
  existingSettings: Settings,
): Promise<ProjectSettings> {
  const projectPath = path.join(root, ".pi", "settings.json");
  if (await exists(projectPath)) {
    const project = await readJson(projectPath);
    if (project.packages === undefined) throw new Error(`${projectPath} must declare packages`);
    // Pi resolves a relative package path in project settings against the
    // project's `.pi` directory; resolve it here so later steps see the same
    // absolute path whichever source the policy came from.
    const projectDir = path.dirname(projectPath);
    return {
      ...project,
      packages: project.packages.map((spec) =>
        spec.startsWith("./") || spec.startsWith("../") ? path.resolve(projectDir, spec) : spec,
      ),
    };
  }
  // Global settings also hold the user's own packages. Only the bundled ones
  // are profile-owned; the rest merge back as retained packages, where
  // superseded predecessors are dropped.
  const bundled = path.join(root, "packages");
  // An install from before the move of `.pi/packages` to `packages` named this
  // checkout's bundled packages under `.pi/packages`. Those count as this
  // profile's packages at their new path, in the same order, so the upgrade is
  // a reinstall that keeps the user's choices rather than a first install.
  const legacyBundled = path.join(root, ".pi", "packages");
  const packages: string[] = [];
  for (const spec of existingSettings.packages ?? []) {
    if (!path.isAbsolute(spec)) continue;
    if (path.dirname(spec) === bundled) {
      packages.push(spec);
    } else if (path.dirname(path.resolve(spec)) === legacyBundled) {
      const moved = path.join(bundled, path.basename(path.resolve(spec)));
      if (await exists(path.join(moved, "package.json"))) packages.push(moved);
    }
  }
  if (packages.length === 0) {
    // A first install also starts from the maintainer's model scope and
    // per-model thinking levels; buildGlobalSettings merges the levels under
    // the user's, and a scope the user already set is kept.
    return {
      packages: [...DEFAULT_PROFILE_PACKAGES],
      extensions: [...DEFAULT_PROFILE_EXTENSIONS],
      modelThinkingLevels: { ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS },
      ...(existingSettings.enabledModels === undefined && {
        enabledModels: [...DEFAULT_PROFILE_ENABLED_MODELS],
      }),
    };
  }
  // A reinstall keeps the user's settings but still fills in per-model thinking
  // levels the profile added since; buildGlobalSettings lets the user's win.
  return {
    ...existingSettings,
    packages: unique(packages),
    // A reinstall picks up built-in policy the profile added since.
    extensions: withProfileExtensionPolicy(existingSettings.extensions),
    modelThinkingLevels: { ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS },
  };
}

export async function installProfile({
  root = SCRIPT_ROOT,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
  backup = false,
  piLauncher,
}: InstallProfileOptions = {}) {
  const settingsPath = path.join(agentDir, "settings.json");
  const existingSettings = await readJson(settingsPath, {});
  const project = await readProfileSettings(root, existingSettings);
  // MCP configuration is deliberately not linked. Pi reads ~/.pi/agent/mcp.json and a
  // project .pi/mcp.json as separate sources, so linking a repo-local copy registers every
  // server twice when Pi runs from this checkout, and the ignored file disappearing leaves
  // Pi with no servers at all. Keep the real file at ~/.pi/agent/mcp.json.
  const links = [...PROFILE_LINKS];
  if (!backup) {
    for (const [sourceRelative, targetRelative] of links) {
      const target = path.resolve(agentDir, targetRelative);
      if ((await classifyLink(root, sourceRelative, target)) === "conflict") {
        throw new Error(`${target} already exists; rerun with --backup to preserve and replace it`);
      }
    }
  }

  const results = [];
  for (const [sourceRelative, targetRelative] of links) {
    results.push(
      await installLink(root, sourceRelative, path.resolve(agentDir, targetRelative), backup),
    );
  }
  const superseded = await supersededPackageNames(root, project);
  const foreignCheckouts = await confirmedForeignCheckouts(existingSettings, root);
  await writeSettings(
    settingsPath,
    buildGlobalSettings(project, existingSettings, root, superseded, foreignCheckouts),
  );
  const pi = await resolvePiLauncher(piLauncher);
  const markerPath = await writeProfileMarker(agentDir, root, pi);
  const warnings: string[] = [];
  const migrations = [await migrateBackgroundCompactionSidecar(agentDir, warnings)];
  const removed = await removeRetiredProfileFiles(agentDir, warnings);
  if (pi.launcher === null || pi.version === null || !isSupportedPiVersion(pi.version)) {
    warnings.push(
      `No compatible Pi ${PI_SDK_REQUIREMENT} launcher: ${pi.launcher ?? "none found"} (${pi.version ?? "unavailable"}). Set --pi-launcher or CHOCO_PI_LAUNCHER.`,
    );
  }
  return {
    agentDir,
    settingsPath,
    markerPath,
    warnings,
    links: results,
    migrations,
    removed,
  };
}

function parseArgs(args: string[]) {
  const options: InstallProfileOptions = { backup: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--backup") options.backup = true;
    else if (argument === "--agent-dir" && args[index + 1])
      options.agentDir = path.resolve(args[++index]);
    else if (argument === "--pi-launcher" && args[index + 1])
      options.piLauncher = path.resolve(args[++index]);
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await installProfile(parseArgs(process.argv.slice(2)));
    for (const link of result.links) {
      const suffix = link.backup ? ` (backup: ${link.backup})` : "";
      console.log(`${link.action}: ${link.target}${suffix}`);
    }
    console.log(`updated: ${result.settingsPath}`);
    console.log(`updated: ${result.markerPath}`);
    for (const migration of result.migrations) {
      console.log(`${migration.action}: ${migration.target}`);
    }
    for (const target of result.removed) console.log(`removed: ${target}`);
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
