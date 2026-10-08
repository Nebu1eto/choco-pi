import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isJsonRecord, type JsonRecord } from "../.pi/extensions/lib/runtime-values.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const SettingsSchema = Type.Object(
  {
    packages: Type.Optional(Type.Array(Type.String())),
    extensions: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    prompts: Type.Optional(Type.Array(Type.String())),
    modelThinkingLevels: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: Type.Unknown() },
);
type Settings = Static<typeof SettingsSchema> & JsonRecord;
type ProjectSettings = Settings & { packages: string[] };
export type InstallLinkResult = {
  target: string;
  action: "unchanged" | "linked" | "backed-up";
  backup?: string;
};
export type InstallProfileOptions = { root?: string; agentDir?: string; backup?: boolean };

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROFILE_LINKS: readonly (readonly [string, string])[] = [
  [".pi/SYSTEM.md", "SYSTEM.md"],
  [".pi/writing-policy.md", "writing-policy.md"],
  [".pi/review-policy.md", "review-policy.md"],
  [".pi/choco-pi-codex.json", "choco-pi-codex.json"],
  [".pi/subagents.json", "subagents.json"],
  [".pi/zentui.json", "choco-pi-ui.json"],
  [".pi/models.json", "models.json"],
  [".pi/keybindings.json", "keybindings.json"],
  [".pi/agents/advisor.md", "agents/advisor.md"],
  [".pi/agents/general.md", "agents/general.md"],
  [".pi/agents/planner.md", "agents/planner.md"],
  [".pi/agents/implementer.md", "agents/implementer.md"],
  [".pi/agents/reviewer.md", "agents/reviewer.md"],
  [".pi/agents/handoff.md", "agents/handoff.md"],
  [".pi/agents/explore.md", "agents/explore.md"],
  [".pi/extensions/apex-provider.json", "extensions/apex-provider.json"],
  [".pi/extensions/context-cap.json", "extensions/context-cap.json"],
  [".pi/extensions/review.json", "extensions/review.json"],
];

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
    if (!isJsonRecord(parsed) || !Value.Check(SettingsSchema, parsed))
      throw new Error("invalid settings shape");
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

function packageIdentity(spec: string) {
  const relativeMatch = spec.match(/^\.\/packages\/([^/]+)$/);
  if (relativeMatch) return `local:${relativeMatch[1]}`;
  if (path.isAbsolute(spec)) {
    const packageDir = path.dirname(spec);
    if (
      path.basename(packageDir) === "packages" &&
      path.basename(path.dirname(packageDir)) === ".pi"
    ) {
      return `local:${path.basename(spec)}`;
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

function mergePackages(canonical: string[], existing: string[]) {
  const canonicalIds = new Set(canonical.map(packageIdentity));
  const extras = new Map<string, string>();
  for (const spec of existing) {
    const identity = packageIdentity(spec);
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
 * True when the entry is some other checkout's .pi/extensions, .pi/skills or
 * .pi/prompts directory.
 *
 * Such a directory is a previous install of this same profile. Keeping it
 * alongside the new root makes pi load two copies of every extension, and it
 * refuses to start when both register the same tool ("Tool session_create
 * conflicts with ..."). Directories outside that shape belong to the user and
 * are preserved.
 */
function isForeignProfileDirectory(entry: string, root: string, name: string) {
  if (!path.isAbsolute(entry)) return false;
  if (path.basename(entry) !== name) return false;
  if (path.basename(path.dirname(entry)) !== ".pi") return false;
  return path.resolve(entry) !== path.resolve(root, ".pi", name);
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
): Settings & { packages: string[]; extensions: string[]; skills: string[]; prompts: string[] } {
  const canonicalPackages = projectSettings.packages.map((spec) =>
    spec.startsWith("./") ? path.resolve(root, ".pi", spec) : spec,
  );
  const rooted = (name: string) => path.resolve(root, ".pi", name);
  const superseded = new Set(supersededNames);
  const retainedPackages = (existingSettings.packages ?? []).filter(
    (spec) => !superseded.has(identityName(packageIdentity(spec))),
  );
  const profileDirectories = (name: "extensions" | "skills" | "prompts") => [
    rooted(name),
    ...(existingSettings[name] ?? []).filter(
      (entry) => !isForeignProfileDirectory(entry, root, name),
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
    ...(Object.keys(thinkingLevels).length > 0 && { modelThinkingLevels: thinkingLevels }),
    packages: mergePackages(canonicalPackages, retainedPackages),
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

async function linkConflict(source: string, target: string) {
  try {
    const status = await lstat(target);
    if (status.isSymbolicLink()) {
      const current = path.resolve(path.dirname(target), await readlink(target));
      return current === source ? undefined : target;
    }
    if (status.isFile() && (await sameFileContents(source, target))) return undefined;
    return target;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function installLink(
  source: string,
  target: string,
  backup: boolean,
): Promise<InstallLinkResult> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const status = await lstat(target);
    if (status.isSymbolicLink()) {
      const current = path.resolve(path.dirname(target), await readlink(target));
      if (current === source) return { target, action: "unchanged" };
    } else if (status.isFile() && (await sameFileContents(source, target))) {
      await rm(target);
      await symlink(source, target);
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
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await symlink(source, target);
    return { target, action: "linked" };
  }
}

async function writeSettings(target: string, settings: Settings) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
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
  for (const spec of projectSettings.packages) {
    if (!spec.startsWith("./")) continue;
    const manifest = await readJson(path.resolve(root, ".pi", spec, "package.json"), {});
    const schema = Type.Object({
      chocoPi: Type.Optional(Type.Object({ supersedes: Type.Optional(Type.Array(Type.String())) })),
    });
    if (!Value.Check(schema, manifest)) throw new Error(`invalid chocoPi.supersedes in ${spec}`);
    for (const name of manifest.chocoPi?.supersedes ?? []) names.push(name);
  }
  return names;
}

export async function installProfile({
  root = SCRIPT_ROOT,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
  backup = false,
}: InstallProfileOptions = {}) {
  const projectSettings = await readJson(path.join(root, ".pi", "settings.json"));
  if (projectSettings.packages === undefined)
    throw new Error("project settings must declare packages");
  const project: ProjectSettings = { ...projectSettings, packages: projectSettings.packages };
  const settingsPath = path.join(agentDir, "settings.json");
  const existingSettings = await readJson(settingsPath, {});
  // MCP configuration is deliberately not linked. Pi reads ~/.pi/agent/mcp.json and a
  // project .pi/mcp.json as separate sources, so linking a repo-local copy registers every
  // server twice when Pi runs from this checkout, and the ignored file disappearing leaves
  // Pi with no servers at all. Keep the real file at ~/.pi/agent/mcp.json.
  const links = [...PROFILE_LINKS];
  if (!backup) {
    for (const [sourceRelative, targetRelative] of links) {
      const target = path.resolve(agentDir, targetRelative);
      if (await linkConflict(path.resolve(root, sourceRelative), target)) {
        throw new Error(`${target} already exists; rerun with --backup to preserve and replace it`);
      }
    }
  }

  const results = [];
  for (const [sourceRelative, targetRelative] of links) {
    results.push(
      await installLink(
        path.resolve(root, sourceRelative),
        path.resolve(agentDir, targetRelative),
        backup,
      ),
    );
  }
  const superseded = await supersededPackageNames(root, project);
  await writeSettings(
    settingsPath,
    buildGlobalSettings(project, existingSettings, root, superseded),
  );
  return { agentDir, settingsPath, links: results };
}

function parseArgs(args: string[]) {
  const options: InstallProfileOptions = { backup: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--backup") options.backup = true;
    else if (argument === "--agent-dir" && args[index + 1])
      options.agentDir = path.resolve(args[++index]);
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
