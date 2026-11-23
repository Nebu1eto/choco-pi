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
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePiLauncher, writeProfileMarker } from "../profile/extensions/lib/profile-marker.ts";
import { PI_SDK_REQUIREMENT, isSupportedPiVersion } from "../profile/extensions/lib/pi-target.ts";
import {
  DEFAULT_PROFILE_ENABLED_MODELS,
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
  DEFAULT_PROFILE_PACKAGE_NAMES,
  DEFAULT_PROFILE_PACKAGES,
  MIGRATED_SIDECARS,
  PRE_RECORD_BUNDLED_PACKAGE_NAMES,
  PROFILE_LINKS,
  RETIRED_PROFILE_FILES,
} from "./install-profile/constants.ts";
import {
  classifyLink,
  installLink,
  removeRetiredProfileFiles,
  type InstallLinkResult,
} from "./install-profile/fs-linking.ts";
import {
  buildGlobalSettings,
  confirmedForeignCheckouts,
  previouslyOfferedPackageNames,
  readJson,
  readProfileSettings,
  supersededPackageNames,
  writeSettings,
} from "./install-profile/settings-merge.ts";
import {
  migrateBackgroundCompactionSidecar,
  type SidecarMigrationResult,
} from "./install-profile/sidecar-migration.ts";

export {
  buildGlobalSettings,
  DEFAULT_PROFILE_ENABLED_MODELS,
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
  DEFAULT_PROFILE_PACKAGE_NAMES,
  DEFAULT_PROFILE_PACKAGES,
  MIGRATED_SIDECARS,
  migrateBackgroundCompactionSidecar,
  PRE_RECORD_BUNDLED_PACKAGE_NAMES,
  PROFILE_LINKS,
  RETIRED_PROFILE_FILES,
  type InstallLinkResult,
  type SidecarMigrationResult,
};

export type InstallProfileOptions = {
  root?: string;
  agentDir?: string;
  backup?: boolean;
  piLauncher?: string;
  /**
   * The model scope a first install writes as `enabledModels`; defaults to
   * {@link DEFAULT_PROFILE_ENABLED_MODELS}. Empty writes no scope: the
   * standalone setup passes it, because Pi warns at every start about each
   * pattern whose provider has no credentials yet.
   */
  defaultEnabledModels?: readonly string[];
};

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function installProfile({
  root = SCRIPT_ROOT,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
  backup = false,
  piLauncher,
  defaultEnabledModels = DEFAULT_PROFILE_ENABLED_MODELS,
}: InstallProfileOptions = {}) {
  const settingsPath = path.join(agentDir, "settings.json");
  const existingSettings = await readJson(settingsPath, {});
  const offeredPackageNames = await previouslyOfferedPackageNames(agentDir);
  const project = await readProfileSettings(
    root,
    existingSettings,
    defaultEnabledModels,
    offeredPackageNames,
  );
  // Reported because a newly bundled package can change behavior on update:
  // the Google provider, for one, replaces Pi's built-in `google` provider.
  const bundledDir = path.join(root, "packages");
  const addedPackages = project.packages.filter(
    (spec) =>
      path.dirname(spec) === bundledDir &&
      !offeredPackageNames.has(path.basename(spec)) &&
      !(existingSettings.packages ?? []).includes(spec),
  );
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
  const markerPath = await writeProfileMarker(agentDir, root, pi, DEFAULT_PROFILE_PACKAGE_NAMES);
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
    addedPackages,
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

/**
 * True when `entry` (process.argv[1]) names this module. Node runs the real
 * path of the main module, so compare real paths: a symlinked directory in
 * `entry` (macOS /tmp -> /private/tmp) must still count as a direct run.
 */
async function isMainModule(entry: string | undefined): Promise<boolean> {
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  const resolved = path.resolve(entry);
  try {
    return (await realpath(resolved)) === (await realpath(modulePath));
  } catch {
    return resolved === modulePath;
  }
}

if (await isMainModule(process.argv[1])) {
  try {
    const result = await installProfile(parseArgs(process.argv.slice(2)));
    for (const link of result.links) {
      const suffix = link.backup ? ` (backup: ${link.backup})` : "";
      console.log(`${link.action}: ${link.target}${suffix}`);
    }
    console.log(`updated: ${result.settingsPath}`);
    for (const spec of result.addedPackages) console.log(`added package: ${spec}`);
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
