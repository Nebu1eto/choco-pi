/**
 * Management commands of the standalone `choco-pi` install.
 *
 * - `install`: stage 1 of install.sh; runs with the qualifying Node, from
 *   `<home>/app`, before the app's dependencies exist. Only Node built-ins and
 *   provision.ts are imported statically; pi-schema and the profile installer
 *   are imported after `pnpm install`.
 * - `self setup|update|uninstall|env|help`: reached through bin/choco-pi, so
 *   the launcher's environment contract is already in place.
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
  installedPiVersion,
  UNSET_PI_VARIABLES,
} from "./contract.ts";
import type { InstallManifest } from "./install-manifest.ts";
import {
  DEFAULT_NPM_REGISTRY,
  findSystemPnpm,
  PINS_FILE,
  provisionPrivatePnpm,
  readRuntimePins,
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

export async function selectPnpm(runtime: string, pins: RuntimePins): Promise<PnpmCommand> {
  await mkdir(runtime, { recursive: true });
  const system = await findSystemPnpm(process.env.PATH ?? "", pins.pnpmVersion, runtime);
  if (system !== null) return { command: system, prefixArgs: [], source: "system" };
  const registry = process.env.CHOCO_PI_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY;
  const entry = await provisionPrivatePnpm(runtime, pins, registry);
  return { command: process.execPath, prefixArgs: [entry], source: "private" };
}

export function pnpmInstallArgs(runtime: string): string[] {
  return [
    "install",
    "--frozen-lockfile",
    "--prod",
    `--config.store-dir=${path.join(runtime, "pnpm-store")}`,
    `--config.cache-dir=${path.join(runtime, "pnpm-cache")}`,
    `--config.state-dir=${path.join(runtime, "pnpm-state")}`,
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

async function installDependencies(app: string, runtime: string): Promise<PnpmCommand> {
  const pins = await readRuntimePins(path.join(app, path.relative(APP_ROOT, PINS_FILE)));
  await assertPackageManagerPin(app, pins);
  const pnpm = await selectPnpm(runtime, pins);
  console.log(`pnpm: ${pnpm.source} ${pnpm.prefixArgs[0] ?? pnpm.command}`);
  await run(pnpm.command, [...pnpm.prefixArgs, ...pnpmInstallArgs(runtime)], app, {
    ...process.env,
    COREPACK_ENABLE_NETWORK: "0",
  });
  return pnpm;
}

function launcherOf(app: string): string {
  return path.join(app, "bin", "choco-pi");
}

async function runLauncher(home: string, app: string, args: readonly string[]): Promise<void> {
  await run(launcherOf(app), args, app, { ...process.env, CHOCO_PI_HOME: home });
}

async function launcherVersionMatches(home: string, app: string): Promise<void> {
  const expected = await installedPiVersion(app);
  const { stdout } = await runFile(launcherOf(app), ["--version"], {
    env: { ...process.env, CHOCO_PI_HOME: home },
    timeout: 30_000,
  });
  if (stdout.trim() !== expected) {
    throw new Error(
      `launcher reports Pi ${JSON.stringify(stdout.trim())}; the app pins Pi ${expected}`,
    );
  }
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

const RUNTIME_ENTRIES = ["node", "pnpm", "pnpm-store", "pnpm-cache", "pnpm-state"] as const;

async function createdPaths(
  home: string,
  app: string,
  gitManaged: boolean,
  previous: InstallManifest | null,
): Promise<string[]> {
  const candidates = [
    ...(gitManaged ? [app] : []),
    ...RUNTIME_ENTRIES.map((entry) => path.join(home, "runtime", entry)),
    path.join(home, "install.json"),
  ];
  const created = new Set(previous?.created ?? []);
  for (const candidate of candidates) {
    if (await exists(candidate)) created.add(candidate);
  }
  created.add(path.join(home, "install.json"));
  return [...created];
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
  const flags = parseFlags(args, ["--home", "--bin-dir", "--source", "--ref"], ["--local-app"]);
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
  await installDependencies(app, runtime);
  await assertPiBinEntry(app);
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
    bin_link: previous?.bin_link ?? null,
    created: await createdPaths(home, app, !local, previous),
    installed_at: previous?.installed_at ?? now,
    updated_at: now,
  };
  await writeInstallManifest(manifest);
  await runLauncher(home, app, ["self", "setup"]);
  const linked = await linkLauncher(binDir, launcherOf(app), previous?.bin_link ?? null);
  const created = manifest.created.filter(
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
  console.log(`${linked.action}: ${linked.link} -> ${launcherOf(app)}`);
  console.log(
    `installed choco-pi in ${home}${rev === null ? " (local app)" : ` at ${rev.slice(0, 12)} (${ref})`}`,
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
  await launcherVersionMatches(home, APP_ROOT);
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
  try {
    await installDependencies(app, runtime);
    await assertPiBinEntry(app);
    await runLauncher(home, app, ["self", "setup"]);
  } catch (error) {
    console.error(
      `update to ${rev.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`returning to ${oldRev.slice(0, 12)}`);
    await git(app, ["checkout", "--quiet", "--force", "--detach", oldRev]);
    await installDependencies(app, runtime);
    await runLauncher(home, app, ["self", "setup"]);
    throw new Error(`update failed; restored ${oldRev.slice(0, 12)}`, { cause: error });
  }
  const created = await createdPaths(home, app, true, manifest);
  await writeInstallManifest({
    ...manifest,
    ref,
    rev,
    created,
    updated_at: new Date().toISOString(),
  });
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
  const { readInstallManifest } = await loadManifestModule();
  const manifest = await readInstallManifest(home);
  if (manifest === null)
    throw new Error(`${home}/install.json is missing; nothing is recorded to uninstall`);
  if (!(await samePath(manifest.home, home)))
    throw new Error(`install.json belongs to ${manifest.home}, not ${home}`);
  const piHome = path.join(homedir(), ".pi");
  const purge = flags.switches.has("--purge");
  const userState = purge ? ["agent", "lsp"].map((entry) => path.join(manifest.home, entry)) : [];
  for (const target of [...manifest.created, ...userState]) {
    if (isInsideOrSame(piHome, target))
      throw new Error(`refusing to remove ${target}: it is under ${piHome}`);
  }
  const removed: string[] = [];
  const kept: string[] = [];
  const installedLauncher = path.join(manifest.app, "bin", "choco-pi");
  if (manifest.bin_link !== null && manifest.created.includes(manifest.bin_link)) {
    if (
      (await isOurLink(manifest.bin_link, installedLauncher)) ||
      (await isOurLink(manifest.bin_link, launcher))
    ) {
      await rm(manifest.bin_link, { force: true });
      removed.push(manifest.bin_link);
    } else if (await exists(manifest.bin_link)) {
      kept.push(`${manifest.bin_link} (not a link to this launcher)`);
    }
  }
  const manifestFile = path.join(manifest.home, "install.json");
  const ordered = manifest.created
    .filter((entry) => entry !== manifest.bin_link && entry !== manifestFile)
    .toSorted((left, right) => right.length - left.length);
  for (const target of [...ordered, ...userState]) {
    if (!(await exists(target))) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  await rm(manifestFile, { force: true });
  removed.push(manifestFile);
  for (const directory of [
    path.join(manifest.home, "runtime"),
    ...(purge ? [manifest.home] : []),
  ]) {
    try {
      await rmdir(directory);
      removed.push(directory);
    } catch {
      continue;
    }
  }
  if (!purge) {
    for (const entry of ["agent", "lsp"]) {
      const target = path.join(manifest.home, entry);
      if (await exists(target)) kept.push(target);
    }
  }
  for (const target of removed) console.log(`removed: ${target}`);
  for (const target of kept) console.log(`kept: ${target}`);
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
  self exec <cmd> [args...]  Run a command under the launcher environment
  self acp [args...]         Run the choco-pi ACP adapter under the launcher environment
  self help                  Show this help

Everything else is passed to Pi unchanged, e.g. choco-pi --version, choco-pi --mode rpc.
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
