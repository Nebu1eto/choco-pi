/**
 * Management commands of the standalone `choco-pi` install.
 *
 * - `install`: stage 1 of install.sh; runs with the qualifying Node, from
 *   `<home>/app`, before the app's dependencies exist. Only Node built-ins and
 *   provision.ts are imported statically; pi-schema and the profile installer
 *   are imported after `pnpm install`.
 * - `self setup|update|uninstall|env|help`: reached through bin/choco-pi, so
 *   the launcher's environment contract is already in place.
 * - `self runtime [node|bun]`: shows or persists the runtime Pi runs on;
 *   choosing bun finds a qualifying bun or provisions the pinned one.
 *
 * Local development: populate `<home>/app` with any app tree (for example a
 * tar copy of a working checkout) and run
 * `node <home>/app/scripts/standalone/manage.ts install --home <home> --bin-dir <dir> --local-app`.
 * A local-app install records no source and cannot `self update`.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertPiBinEntry,
  CONTRACT_VARIABLES,
  DEFAULT_RUNTIME,
  installedPiVersion,
  isRuntime,
  RUNTIME_REPORT_VARIABLES,
  RUNTIMES,
  type Runtime,
  UNSET_PI_VARIABLES,
} from "./contract.ts";
import type { InstallManifest } from "./install-manifest.ts";
import {
  clearProvenance,
  PROVENANCE_NAME,
  provenancePath,
  readProvenance,
  recordCreated,
} from "./provenance.ts";
import {
  bunVersionQualifies,
  DEFAULT_BUN_MIRROR,
  DEFAULT_NPM_REGISTRY,
  findSystemBun,
  findSystemPnpm,
  PINS_FILE,
  probeBun,
  provisionPrivateBun,
  provisionPrivatePnpm,
  readRuntimePins,
  type BunCommand,
  type OnCreated,
  type PnpmCommand,
  type RuntimePins,
} from "./provision.ts";

const runFile = promisify(execFile);

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Flags = { values: Map<string, string>; switches: Set<string>; rest: string[] };

function parseFlags(
  args: readonly string[],
  valued: readonly string[],
  switches: readonly string[],
): Flags {
  const flags: Flags = { values: new Map(), switches: new Set(), rest: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (valued.includes(name)) {
      const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      flags.values.set(name, value);
    } else if (switches.includes(argument)) {
      flags.switches.add(argument);
    } else {
      throw new UsageError(`unknown argument: ${argument}`);
    }
  }
  return flags;
}

async function git(app: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile("git", ["-C", app, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(command)} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`,
          ),
        );
    });
  });
}

/** Git-managed apps: refuse a dirty tree, fetch `ref`, move HEAD forward. */
export async function syncCheckout(
  app: string,
  ref: string,
  allowNonFastForward: boolean,
): Promise<string> {
  const dirty = await git(app, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty !== "") throw new Error(`${app} has local changes; refusing to move it:\n${dirty}`);
  await git(app, ["fetch", "--quiet", "--no-auto-gc", "origin", ref]);
  const target = await git(app, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  const head = await git(app, ["rev-parse", "--verify", "HEAD"]);
  if (target === head) return head;
  if (!allowNonFastForward) {
    try {
      await git(app, ["merge-base", "--is-ancestor", head, target]);
    } catch {
      throw new Error(
        `origin ${ref} (${target.slice(0, 12)}) is not a fast-forward of ${head.slice(0, 12)}`,
      );
    }
  }
  await git(app, ["checkout", "--quiet", "--detach", target]);
  return target;
}

/**
 * The pnpm to run and the runtime directories selecting it created;
 * `onCreated` hears of a downloaded pnpm as soon as it is in place.
 */
export async function selectPnpm(
  runtime: string,
  pins: RuntimePins,
  onCreated?: OnCreated,
): Promise<{ pnpm: PnpmCommand; created: readonly string[] }> {
  await mkdir(runtime, { recursive: true });
  const system = await findSystemPnpm(process.env.PATH ?? "", pins.pnpmVersion, runtime);
  if (system !== null)
    return { pnpm: { command: system, prefixArgs: [], source: "system" }, created: [] };
  const registry = process.env.CHOCO_PI_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY;
  const provisioned = await provisionPrivatePnpm(runtime, pins, registry, onCreated);
  return {
    pnpm: { command: process.execPath, prefixArgs: [provisioned.path], source: "private" },
    created: provisioned.created,
  };
}

const PNPM_DIRECTORIES = ["pnpm-store", "pnpm-cache", "pnpm-state"] as const;

export function pnpmInstallArgs(runtime: string): string[] {
  return [
    "install",
    "--frozen-lockfile",
    "--prod",
    `--config.store-dir=${path.join(runtime, PNPM_DIRECTORIES[0])}`,
    `--config.cache-dir=${path.join(runtime, PNPM_DIRECTORIES[1])}`,
    `--config.state-dir=${path.join(runtime, PNPM_DIRECTORIES[2])}`,
    "--config.confirm-modules-purge=false",
    "--config.manage-package-manager-versions=false",
    "--config.update-notifier=false",
  ];
}

async function assertPackageManagerPin(app: string, pins: RuntimePins): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  const declared =
    parsed instanceof Object && "packageManager" in parsed ? parsed.packageManager : undefined;
  if (declared !== `pnpm@${pins.pnpmVersion}`) {
    throw new Error(
      `package.json packageManager is ${JSON.stringify(declared)}; runtime-pins.txt pins pnpm ${pins.pnpmVersion}`,
    );
  }
}

/**
 * Installs the app's dependencies. Every runtime directory this call creates
 * (pnpm directories that did not exist, a downloaded pnpm) goes to `record`
 * before `pnpm install` runs, so a failed install still owns it.
 */
async function installDependencies(app: string, runtime: string, record: OnCreated): Promise<void> {
  const pins = await readRuntimePins(path.join(app, path.relative(APP_ROOT, PINS_FILE)));
  await assertPackageManagerPin(app, pins);
  await mkdir(runtime, { recursive: true });
  for (const entry of PNPM_DIRECTORIES) {
    const directory = path.join(runtime, entry);
    if (await exists(directory)) continue;
    // Journaled before it exists: from here on only this install creates it.
    await record(directory);
    await mkdir(directory);
  }
  const { pnpm } = await selectPnpm(runtime, pins, record);
  console.log(`pnpm: ${pnpm.source} ${pnpm.prefixArgs[0] ?? pnpm.command}`);
  await run(pnpm.command, [...pnpm.prefixArgs, ...pnpmInstallArgs(runtime)], app, {
    ...process.env,
    COREPACK_ENABLE_NETWORK: "0",
  });
}

function launcherOf(app: string): string {
  return path.join(app, "bin", "choco-pi");
}

/**
 * Environment for a nested launcher run. The launcher exports the resolved
 * runtime to management verbs; that must not turn into a per-invocation
 * override for the child unless the user set it. `runtime` forces one.
 */
export function launcherEnvironment(
  home: string,
  runtime: Runtime | null,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...environment, CHOCO_PI_HOME: home };
  const fromUser =
    environment.CHOCO_PI_RUNTIME_SOURCE === undefined ||
    environment.CHOCO_PI_RUNTIME_SOURCE === "env";
  for (const name of RUNTIME_REPORT_VARIABLES) {
    if (name !== "CHOCO_PI_RUNTIME" || !fromUser) delete child[name];
  }
  if (runtime !== null) child.CHOCO_PI_RUNTIME = runtime;
  return child;
}

async function runLauncher(home: string, app: string, args: readonly string[]): Promise<void> {
  await run(launcherOf(app), args, app, launcherEnvironment(home, null));
}

async function launcherVersionMatches(
  home: string,
  app: string,
  runtime: Runtime | null,
): Promise<void> {
  const expected = await installedPiVersion(app);
  const { stdout } = await runFile(launcherOf(app), ["--version"], {
    env: launcherEnvironment(home, runtime),
    timeout: 30_000,
  });
  if (stdout.trim() !== expected) {
    throw new Error(
      `launcher${runtime === null ? "" : ` (runtime ${runtime})`} reports Pi ${JSON.stringify(stdout.trim())}; the app pins Pi ${expected}`,
    );
  }
}

/** `created` lists what provisioning wrote; it is empty unless `source` is "provisioned". */
export type BunChoice = BunCommand & {
  source: "recorded" | "private" | "system" | "provisioned";
  created: readonly string[];
};

/**
 * A Bun for runtime bun: the recorded `bun_path`, the private
 * `runtime/bun`, a PATH bun at least the pinned minimum, else the pinned
 * release downloaded into `runtime/bun` (sha256-verified before unzip).
 * `onCreated` hears of a downloaded `runtime/bun` as soon as it is in place.
 */
export async function ensureBun(
  home: string,
  app: string,
  recorded: string | null | undefined,
  searchPath: string = process.env.PATH ?? "",
  onCreated?: OnCreated,
): Promise<BunChoice> {
  const pins = await readRuntimePins(path.join(app, path.relative(APP_ROOT, PINS_FILE)));
  const runtime = path.join(home, "runtime");
  await mkdir(runtime, { recursive: true });
  const qualifying = async (candidate: string): Promise<BunCommand | null> => {
    if (!(await exists(candidate))) return null;
    const probed = await probeBun(candidate, runtime);
    return probed !== null && bunVersionQualifies(probed.version, pins.bunMinimumVersion)
      ? probed
      : null;
  };
  if (recorded !== undefined && recorded !== null) {
    const found = await qualifying(recorded);
    if (found !== null)
      return { path: recorded, version: found.version, source: "recorded", created: [] };
  }
  const privateBinary = path.join(runtime, "bun", "bin", "bun");
  const existing = await qualifying(privateBinary);
  if (existing !== null)
    return { path: privateBinary, version: existing.version, source: "private", created: [] };
  const system = await findSystemBun(searchPath, pins.bunMinimumVersion, runtime);
  if (system !== null) return { ...system, source: "system", created: [] };
  console.log(
    `no Bun >= ${pins.bunMinimumVersion} found; provisioning Bun ${pins.bunVersion} into ${runtime}/bun`,
  );
  const provisioned = await provisionPrivateBun(runtime, pins, {
    mirror: process.env.CHOCO_PI_BUN_MIRROR ?? DEFAULT_BUN_MIRROR,
    searchPath,
    onCreated,
  });
  return {
    path: provisioned.path,
    version: pins.bunVersion,
    source: "provisioned",
    created: provisioned.created,
  };
}

function runtimeArgument(value: string, origin: string): Runtime {
  if (!isRuntime(value))
    throw new UsageError(
      `${origin} must be one of ${RUNTIMES.join(", ")}, got ${JSON.stringify(value)}`,
    );
  return value;
}

export type LinkResult = { link: string; action: "created" | "replaced" | "unchanged" };

/**
 * Links `<binDir>/choco-pi` to `launcher`. Replaces only a symlink that
 * already points at `launcher` or that an earlier install recorded; any other
 * file is foreign and is never touched.
 */
export async function linkLauncher(
  binDir: string,
  launcher: string,
  recordedLink: string | null,
): Promise<LinkResult> {
  const link = path.join(binDir, "choco-pi");
  await mkdir(binDir, { recursive: true });
  let action: LinkResult["action"] = "created";
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink())
      throw new Error(`${link} exists and is not a symlink; refusing to replace it`);
    const target = path.resolve(binDir, await readlink(link));
    if (target === launcher) return { link, action: "unchanged" };
    if (link !== recordedLink) {
      throw new Error(`${link} links to ${target}, not to this install; refusing to replace it`);
    }
    action = "replaced";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = path.join(binDir, `.choco-pi.${randomUUID()}.tmp`);
  try {
    await symlink(launcher, temporary);
    await rename(temporary, link);
  } finally {
    await rm(temporary, { force: true });
  }
  return { link, action };
}

/** True when `link` is a symlink whose target is `launcher`. */
export async function isOurLink(link: string, launcher: string): Promise<boolean> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) return false;
    return path.resolve(path.dirname(link), await readlink(link)) === launcher;
  } catch {
    return false;
  }
}

/**
 * Journals each path this run creates the moment it exists (provenance.ts)
 * and collects it in `createdNow`.
 */
function recorder(home: string, createdNow: string[]): OnCreated {
  return async (created) => {
    await recordCreated(home, created);
    createdNow.push(created);
  };
}

/**
 * The paths an install owns: those an earlier manifest recorded, the valid
 * entries of the creation journal, those this run created, and install.json.
 * A path that merely exists is never owned: uninstall deletes every owned
 * path recursively. `binLink` is the link the manifest being written records.
 */
async function ownedPaths(
  home: string,
  previous: InstallManifest | null,
  createdNow: readonly string[],
  binLink: string | null,
): Promise<string[]> {
  const owned = new Set(previous?.created ?? []);
  const journal = await readProvenance(home, binLink);
  for (const { entry, problem } of journal.rejected)
    console.warn(`warning: ignoring ${PROVENANCE_NAME} entry ${JSON.stringify(entry)}: ${problem}`);
  for (const entry of journal.accepted) owned.add(entry);
  for (const entry of createdNow) owned.add(entry);
  owned.add(path.join(home, "install.json"));
  return [...owned];
}

async function loadManifestModule() {
  try {
    return await import("./install-manifest.ts");
  } catch (error) {
    throw new Error(
      `cannot load the install manifest module (app dependencies missing?): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function defaultHome(): string {
  return path.join(homedir(), ".choco-pi");
}

/** Creates `directory` when needed and returns its real path. */
async function canonicalDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true });
  return realpath(absolute);
}

function pathHint(binDir: string): string | null {
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => path.resolve(entry || "."));
  return entries.includes(binDir)
    ? null
    : `${binDir} is not on PATH; add it, e.g. export PATH="${binDir}:$PATH"`;
}

export async function installCommand(args: readonly string[]): Promise<void> {
  const flags = parseFlags(
    args,
    ["--home", "--bin-dir", "--source", "--ref", "--runtime"],
    // Stage 0 reports what it created in the creation journal. The two switches
    // are what an earlier install.sh passed instead; they are still honored.
    ["--local-app", "--app-cloned", "--node-provisioned"],
  );
  const runtimeFlag = flags.values.get("--runtime");
  const requestedRuntime =
    runtimeFlag === undefined ? null : runtimeArgument(runtimeFlag, "--runtime");
  const home = await canonicalDirectory(
    flags.values.get("--home") ?? process.env.CHOCO_PI_HOME ?? defaultHome(),
  );
  const binDir = await canonicalDirectory(
    flags.values.get("--bin-dir") ?? path.join(homedir(), ".local", "bin"),
  );
  const app = path.join(home, "app");
  if (!(await samePath(APP_ROOT, app))) {
    throw new Error(
      `install must run from ${app}/scripts/standalone/manage.ts (this is ${APP_ROOT})`,
    );
  }
  const manifestFile = path.join(home, "install.json");
  const manifestModule = (await exists(manifestFile)) ? await loadManifestModule() : null;
  const previous = manifestModule === null ? null : await manifestModule.readInstallManifest(home);
  const local =
    flags.switches.has("--local-app") || (previous !== null && previous.source === null);
  let source: string | null = null;
  let ref: string | null = null;
  let rev: string | null = null;
  if (!local) {
    if (!(await exists(path.join(app, ".git"))))
      throw new Error(`${app} is not a git checkout; use install.sh or --local-app`);
    source = flags.values.get("--source") ?? previous?.source ?? null;
    if (source === null) throw new UsageError("--source is required for a first install");
    if (previous?.source !== undefined && previous.source !== null && previous.source !== source) {
      await git(app, ["remote", "set-url", "origin", source]);
    }
    ref = flags.values.get("--ref") ?? previous?.ref ?? null;
    if (ref === null) {
      try {
        ref = await git(app, ["symbolic-ref", "--short", "HEAD"]);
      } catch {
        throw new UsageError("cannot tell which ref to install; pass --ref");
      }
    }
    rev = await syncCheckout(app, ref, previous === null || previous.ref !== ref);
  }
  const runtime = path.join(home, "runtime");
  const createdNow: string[] = [];
  const record = recorder(home, createdNow);
  if (!local && flags.switches.has("--app-cloned")) await record(app);
  if (flags.switches.has("--node-provisioned")) await record(path.join(runtime, "node"));
  await installDependencies(app, runtime, record);
  await assertPiBinEntry(app);
  const piRuntime = requestedRuntime ?? previous?.runtime ?? DEFAULT_RUNTIME;
  const bun =
    piRuntime === "bun"
      ? await ensureBun(home, app, previous?.bun_path, process.env.PATH ?? "", record)
      : null;
  if (bun !== null) console.log(`bun: ${bun.source} ${bun.path} (${bun.version})`);
  const { writeInstallManifest, isLauncherReadablePath } =
    manifestModule ?? (await loadManifestModule());
  const nodePath = process.execPath;
  if (!isLauncherReadablePath(nodePath))
    throw new Error(`unsupported characters in the Node path ${nodePath}`);
  const now = new Date().toISOString();
  const manifest: InstallManifest = {
    schema: 1,
    name: "choco-pi",
    home,
    app,
    source,
    ref,
    rev,
    node_path: nodePath,
    runtime: piRuntime,
    bun_path: bun?.path ?? previous?.bun_path ?? null,
    bin_link: previous?.bin_link ?? null,
    created: await ownedPaths(home, previous, createdNow, previous?.bin_link ?? null),
    installed_at: previous?.installed_at ?? now,
    updated_at: now,
  };
  await writeInstallManifest(manifest);
  await runLauncher(home, app, ["self", "setup"]);
  if (piRuntime !== DEFAULT_RUNTIME) await launcherVersionMatches(home, app, piRuntime);
  const linked = await linkLauncher(binDir, launcherOf(app), previous?.bin_link ?? null);
  if (linked.action !== "unchanged") await record(linked.link);
  const created = (await ownedPaths(home, manifest, createdNow, linked.link)).filter(
    (entry) => entry !== previous?.bin_link || entry === linked.link,
  );
  if (
    previous?.bin_link &&
    previous.bin_link !== linked.link &&
    (await isOurLink(previous.bin_link, launcherOf(app)))
  ) {
    await rm(previous.bin_link, { force: true });
    console.log(`removed old link: ${previous.bin_link}`);
  }
  if (!created.includes(linked.link)) created.push(linked.link);
  await writeInstallManifest({ ...manifest, bin_link: linked.link, created });
  await clearProvenance(home);
  console.log(`${linked.action}: ${linked.link} -> ${launcherOf(app)}`);
  console.log(
    `installed choco-pi in ${home}${rev === null ? " (local app)" : ` at ${rev.slice(0, 12)} (${ref})`}; Pi runs on ${piRuntime}`,
  );
  const hint = pathHint(binDir);
  if (hint !== null) console.log(hint);
}

type Contract = { home: string; launcher: string };

function requireContract(): Contract {
  const home = process.env.CHOCO_PI_HOME;
  const launcher = process.env.CHOCO_PI_LAUNCHER;
  if (process.env.CHOCO_PI_STANDALONE !== "1" || home === undefined || launcher === undefined) {
    throw new UsageError("run this through the choco-pi launcher (bin/choco-pi self ...)");
  }
  if (!path.isAbsolute(home) || !path.isAbsolute(launcher))
    throw new Error("launcher contract paths must be absolute");
  return { home, launcher };
}

export async function setupCommand(args: readonly string[]): Promise<void> {
  parseFlags(args, [], []);
  const { home, launcher } = requireContract();
  await assertPiBinEntry(APP_ROOT);
  const { installProfile } = await import("../install-profile.ts");
  const result = await installProfile({
    root: APP_ROOT,
    agentDir: path.join(home, "agent"),
    piLauncher: launcher,
  });
  for (const link of result.links) console.log(`${link.action}: ${link.target}`);
  console.log(`updated: ${result.settingsPath}`);
  console.log(`updated: ${result.markerPath}`);
  for (const target of result.removed) console.log(`removed: ${target}`);
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  await launcherVersionMatches(home, APP_ROOT, null);
}

export async function updateCommand(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, ["--ref"], []);
  const { home } = requireContract();
  const app = path.join(home, "app");
  if (!(await samePath(APP_ROOT, app)))
    throw new Error(`self update only manages ${app}; this launcher runs from ${APP_ROOT}`);
  const { readInstallManifest, writeInstallManifest } = await loadManifestModule();
  const manifest = await readInstallManifest(home);
  if (manifest === null) throw new Error(`${home}/install.json is missing; re-run install.sh`);
  if (manifest.source === null)
    throw new Error("this is a local-app install; it has no source to update from");
  const ref = flags.values.get("--ref") ?? manifest.ref;
  if (ref === null) throw new UsageError("no recorded ref; pass --ref");
  const oldRev = await git(app, ["rev-parse", "--verify", "HEAD"]);
  const rev = await syncCheckout(app, ref, ref !== manifest.ref);
  const runtime = path.join(home, "runtime");
  const createdNow: string[] = [];
  const record = recorder(manifest.home, createdNow);
  const owned = () => ownedPaths(manifest.home, manifest, createdNow, manifest.bin_link);
  try {
    await installDependencies(app, runtime, record);
    await assertPiBinEntry(app);
    await runLauncher(home, app, ["self", "setup"]);
  } catch (error) {
    console.error(
      `update to ${rev.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`returning to ${oldRev.slice(0, 12)}`);
    await git(app, ["checkout", "--quiet", "--force", "--detach", oldRev]);
    try {
      await installDependencies(app, runtime, record);
      await runLauncher(home, app, ["self", "setup"]);
    } finally {
      // Keep ownership of whatever the failed update created.
      await writeInstallManifest({ ...manifest, created: await owned() });
      await clearProvenance(manifest.home);
    }
    throw new Error(`update failed; restored ${oldRev.slice(0, 12)}`, { cause: error });
  }
  await writeInstallManifest({
    ...manifest,
    ref,
    rev,
    created: await owned(),
    updated_at: new Date().toISOString(),
  });
  await clearProvenance(manifest.home);
  console.log(
    rev === oldRev
      ? `already at ${rev.slice(0, 12)} (${ref})`
      : `updated ${oldRev.slice(0, 12)} -> ${rev.slice(0, 12)} (${ref})`,
  );
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function uninstallCommand(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, [], ["--purge"]);
  const { home, launcher } = requireContract();
  // An install that failed before writing install.json (and maybe before its
  // dependencies existed) is recorded only in the creation journal.
  const manifest = (await exists(path.join(home, "install.json")))
    ? await (await loadManifestModule()).readInstallManifest(home)
    : null;
  if (manifest !== null && !(await samePath(manifest.home, home)))
    throw new Error(`install.json belongs to ${manifest.home}, not ${home}`);
  const installHome = manifest?.home ?? (await realpath(home));
  const binLink = manifest?.bin_link ?? null;
  const journal = await readProvenance(installHome, binLink);
  for (const { entry, problem } of journal.rejected)
    console.warn(`warning: ignoring ${PROVENANCE_NAME} entry ${JSON.stringify(entry)}: ${problem}`);
  if (manifest === null && journal.accepted.length === 0)
    throw new Error(`${home}/install.json is missing; nothing is recorded to uninstall`);
  const owned = [...new Set([...(manifest?.created ?? []), ...journal.accepted])];
  const piHome = path.join(homedir(), ".pi");
  const purge = flags.switches.has("--purge");
  const userState = purge ? ["agent", "lsp"].map((entry) => path.join(installHome, entry)) : [];
  for (const target of [...owned, ...userState]) {
    if (isInsideOrSame(piHome, target))
      throw new Error(`refusing to remove ${target}: it is under ${piHome}`);
  }
  const removed: string[] = [];
  const kept: string[] = [];
  const installedLauncher = path.join(
    manifest?.app ?? path.join(installHome, "app"),
    "bin",
    "choco-pi",
  );
  if (binLink !== null && owned.includes(binLink)) {
    if ((await isOurLink(binLink, installedLauncher)) || (await isOurLink(binLink, launcher))) {
      await rm(binLink, { force: true });
      removed.push(binLink);
    } else if (await exists(binLink)) {
      kept.push(`${binLink} (not a link to this launcher)`);
    }
  }
  const manifestFile = path.join(installHome, "install.json");
  const ordered = owned
    .filter((entry) => entry !== binLink && entry !== manifestFile)
    .toSorted((left, right) => right.length - left.length);
  for (const target of [...ordered, ...userState]) {
    if (!(await exists(target))) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  for (const file of [manifestFile, provenancePath(installHome)]) {
    if (!(await exists(file))) continue;
    await rm(file, { force: true });
    removed.push(file);
  }
  for (const directory of [path.join(installHome, "runtime"), ...(purge ? [installHome] : [])]) {
    try {
      await rmdir(directory);
      removed.push(directory);
    } catch {
      continue;
    }
  }
  if (!purge) {
    for (const entry of ["agent", "lsp"]) {
      const target = path.join(installHome, entry);
      if (await exists(target)) kept.push(target);
    }
  }
  for (const target of removed) console.log(`removed: ${target}`);
  for (const target of kept) console.log(`kept: ${target}`);
}

/** The launcher's runtime resolution, as exported to management verbs. */
export type RuntimeReport = { name: string; source: string; binary: string | null };

export function runtimeReport(environment: NodeJS.ProcessEnv = process.env): RuntimeReport {
  const name = environment.CHOCO_PI_RUNTIME ?? DEFAULT_RUNTIME;
  const bun = environment.CHOCO_PI_BUN;
  const binary =
    name === "bun"
      ? bun === undefined || bun === ""
        ? null
        : bun
      : (environment.CHOCO_PI_NODE ?? null);
  return { name, source: environment.CHOCO_PI_RUNTIME_SOURCE ?? "default", binary };
}

export async function runtimeCommand(args: readonly string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("usage: choco-pi self runtime [node|bun]");
  const { home } = requireContract();
  const { readInstallManifest, writeInstallManifest } = await loadManifestModule();
  const manifest = await readInstallManifest(home);
  const current = runtimeReport();
  const value = args[0];
  if (value === undefined) {
    console.log(`runtime=${current.name}`);
    console.log(
      `source=${current.source === "env" ? "env CHOCO_PI_RUNTIME" : current.source === "install.json" ? manifestPathOf(home) : "default"}`,
    );
    console.log(`binary=${current.binary ?? "(no usable bun found)"}`);
    console.log(`node=${process.env.CHOCO_PI_NODE ?? process.execPath}`);
    if (manifest !== null)
      console.log(`persisted=${manifest.runtime ?? `${DEFAULT_RUNTIME} (default)`}`);
    return;
  }
  const runtime = runtimeArgument(value, "self runtime");
  if (manifest === null) {
    throw new Error(
      `${manifestPathOf(home)} is missing, so there is nothing to persist; set CHOCO_PI_RUNTIME=${runtime} per invocation instead`,
    );
  }
  let bunPath = manifest.bun_path ?? null;
  const createdNow: string[] = [];
  if (runtime === "bun") {
    const bun = await ensureBun(
      home,
      manifest.app,
      manifest.bun_path,
      process.env.PATH ?? "",
      recorder(manifest.home, createdNow),
    );
    console.log(`bun: ${bun.source} ${bun.path} (${bun.version})`);
    bunPath = bun.path;
  }
  const created = await ownedPaths(manifest.home, manifest, createdNow, manifest.bin_link);
  await writeInstallManifest({
    ...manifest,
    runtime,
    bun_path: bunPath,
    created,
    updated_at: new Date().toISOString(),
  });
  await clearProvenance(manifest.home);
  try {
    await launcherVersionMatches(home, manifest.app, runtime);
  } catch (error) {
    // Keep the old runtime but still own what provisioning just downloaded.
    await writeInstallManifest({ ...manifest, created });
    throw new Error(
      `Pi does not start on ${runtime}; kept runtime ${manifest.runtime ?? DEFAULT_RUNTIME}`,
      {
        cause: error,
      },
    );
  }
  console.log(`runtime=${runtime} (persisted in ${manifestPathOf(home)})`);
  if (current.source === "env" && current.name !== runtime) {
    console.log(`note: CHOCO_PI_RUNTIME=${current.name} in this environment still overrides it`);
  }
}

function manifestPathOf(home: string): string {
  return path.join(home, "install.json");
}

export async function envCommand(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  const names = args.filter((argument) => argument !== "--json");
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new UsageError(`not a variable name: ${name}`);
  }
  requireContract();
  const pick = (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
  const report = {
    contract: pick(CONTRACT_VARIABLES),
    unset: pick(UNSET_PI_VARIABLES),
    requested: pick(names),
    runtime: runtimeReport(),
    node: process.execPath,
    app: APP_ROOT,
    path: process.env.PATH ?? null,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(report.contract)) console.log(`${key}=${value ?? ""}`);
  for (const [key, value] of Object.entries(report.unset))
    console.log(value === null ? `unset ${key}` : `${key}=${value}`);
  for (const [key, value] of Object.entries(report.requested))
    console.log(value === null ? `unset ${key}` : `${key}=${value}`);
  console.log(`CHOCO_PI_RUNTIME=${report.runtime.name} (${report.runtime.source})`);
  console.log(`runtime_binary=${report.runtime.binary ?? ""}`);
  console.log(`node=${report.node}`);
  console.log(`app=${report.app}`);
}

export const USAGE = `Usage: choco-pi [pi arguments...]
       choco-pi self <command>

Management commands:
  self setup                 Install the choco-pi profile into $CHOCO_PI_HOME/agent (idempotent)
  self update [--ref REF]    Fast-forward the app, reinstall dependencies, run setup
  self uninstall [--purge]   Remove what install.json records; keeps agent/ and lsp/ unless --purge
  self env [--json] [NAME...] Print the launcher environment contract (and the named variables)
  self runtime [node|bun]    Show the runtime Pi runs on and its source, or persist one
                             (bun: uses a bun >= the pinned minimum or downloads the pinned Bun)
  self exec <cmd> [args...]  Run a command under the launcher environment
  self acp [args...]         Run the choco-pi ACP adapter under the launcher environment
  self help                  Show this help

Everything else is passed to Pi unchanged, e.g. choco-pi --version, choco-pi --mode rpc.
CHOCO_PI_RUNTIME=node|bun overrides the persisted runtime for one invocation.
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [first, verb, ...rest] = argv;
  try {
    if (first === "install") await installCommand(argv.slice(1));
    else if (first !== "self") throw new UsageError(`unknown command: ${first ?? "(none)"}`);
    else if (verb === "setup") await setupCommand(rest);
    else if (verb === "update") await updateCommand(rest);
    else if (verb === "uninstall") await uninstallCommand(rest);
    else if (verb === "env") await envCommand(rest);
    else if (verb === "runtime") await runtimeCommand(rest);
    else if (verb === "help") process.stdout.write(USAGE);
    else if (verb === "exec" || verb === "acp")
      throw new UsageError(`self ${verb} is handled by bin/choco-pi`);
    else throw new UsageError(`unknown self command: ${verb ?? "(none)"}`);
    return 0;
  } catch (error) {
    console.error(`choco-pi: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) console.error(USAGE);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && (await samePath(process.argv[1], fileURLToPath(import.meta.url)))) {
  process.exitCode = await main(process.argv.slice(2));
}
