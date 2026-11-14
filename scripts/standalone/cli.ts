/**
 * The standalone `choco-pi` management commands, run through manage.ts once
 * the app's dependencies exist: Optique parses the command line and LogTape
 * carries progress and warnings (data such as `self env` goes to stdout as is).
 *
 * - `install`: stage 1 of install.sh, after it moved the checkout to the
 *   revision it installs and bootstrap.ts installed the dependencies.
 * - `self setup|update|uninstall|env|runtime|help`: reached through
 *   bin/choco-pi, so the launcher's environment contract is already in place.
 *   `self update` hands the update to the target revision's own install.sh.
 *
 * Local development: populate `<home>/app` with any app tree (for example a
 * tar copy of a working checkout), then run
 * `node <home>/app/scripts/standalone/bootstrap.ts` and
 * `node <home>/app/scripts/standalone/manage.ts install --home <home> --bin-dir <dir> --local-app`.
 * A local-app install records no source and cannot `self update`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { configureSync, getLogger, type LogRecord } from "@logtape/logtape";
import {
  argument,
  choice,
  command,
  constant,
  type InferValue,
  multiple,
  object,
  option,
  optional,
  or,
  runParserSync,
  string,
} from "@optique/core";

import { APP_ROOT, run } from "./bootstrap.ts";
import {
  assertPiBinEntry,
  CONTRACT_VARIABLES,
  DEFAULT_RUNTIME,
  installedPiVersion,
  requireContract,
  RUNTIME_REPORT_VARIABLES,
  RUNTIMES,
  type Runtime,
  UNSET_PI_VARIABLES,
  UsageError,
} from "./contract.ts";
import {
  type InstallManifest,
  isLauncherReadablePath,
  readInstallManifest,
  writeInstallManifest,
} from "./install-manifest.ts";
import { clearProvenance, PROVENANCE_NAME, readProvenance, recordCreated } from "./provenance.ts";
import {
  bunVersionQualifies,
  DEFAULT_BUN_MIRROR,
  exists,
  findSystemBun,
  PINS_FILE,
  probeBun,
  provisionPrivateBun,
  readPin,
  readRuntimePins,
  samePath,
  type BunCommand,
  type OnCreated,
} from "./provision.ts";
import { isOurLink, uninstall } from "./uninstall.ts";

const runFile = promisify(execFile);

/** Progress and warnings of the management commands. */
const log = getLogger(["choco-pi", "standalone"]);

/** A record's text: the message template with each property rendered as text. */
function recordText(record: LogRecord): string {
  return record.message.map((part) => String(part)).join("");
}

/**
 * The terminal sink: info lines on stdout, warnings and errors on stderr,
 * written synchronously in call order like console.log, so they interleave
 * correctly with the output of the commands run with inherited stdio.
 */
function writeRecord(record: LogRecord): void {
  const text = recordText(record);
  if (record.level === "warning") process.stderr.write(`warning: ${text}\n`);
  else if (record.level === "error" || record.level === "fatal")
    process.stderr.write(`choco-pi: ${text}\n`);
  else if (record.level === "info") process.stdout.write(`${text}\n`);
}

/** Routes the standalone loggers, and LogTape's own warnings, to the terminal. */
export function configureLogging(): void {
  configureSync({
    reset: true,
    sinks: { terminal: writeRecord },
    loggers: [
      { category: ["choco-pi"], sinks: ["terminal"], lowestLevel: "info" },
      { category: ["logtape", "meta"], sinks: ["terminal"], lowestLevel: "warning" },
    ],
  });
}

const runtimeValue = choice(RUNTIMES, { metavar: "RUNTIME" });

const installParser = command(
  "install",
  object({
    verb: constant("install"),
    home: optional(option("--home", string({ metavar: "DIR" }))),
    binDir: optional(option("--bin-dir", string({ metavar: "DIR" }))),
    source: optional(option("--source", string({ metavar: "SOURCE" }))),
    ref: optional(option("--ref", string({ metavar: "REF" }))),
    runtime: optional(option("--runtime", runtimeValue)),
    localApp: option("--local-app"),
  }),
  { hidden: true },
);

const setupParser = command(
  "setup",
  object({
    verb: constant("setup"),
    importPiSettings: option("--import-pi-settings"),
    from: optional(option("--from", string({ metavar: "FILE" }))),
    force: option("--force"),
  }),
);

const updateParser = command(
  "update",
  object({ verb: constant("update"), ref: optional(option("--ref", string({ metavar: "REF" }))) }),
);

const uninstallParser = command(
  "uninstall",
  object({ verb: constant("uninstall"), purge: option("--purge") }),
);

const envParser = command(
  "env",
  object({
    verb: constant("env"),
    json: option("--json"),
    names: multiple(argument(string({ metavar: "NAME", pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ }))),
  }),
);

const runtimeParser = command(
  "runtime",
  object({ verb: constant("runtime"), runtime: optional(argument(runtimeValue)) }),
);

const helpParser = command("help", object({ verb: constant("help") }));

/** `install` (stage 1, hidden) or `self <command>`, as manage.ts receives them. */
export const commandLine = or(
  installParser,
  command(
    "self",
    or(setupParser, updateParser, uninstallParser, envParser, runtimeParser, helpParser),
  ),
);

export type InstallArguments = InferValue<typeof installParser>;
export type SetupArguments = InferValue<typeof setupParser>;

async function git(app: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile("git", ["-C", app, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
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
  log.info("no Bun >= {minimum} found; provisioning Bun {version} into {runtime}/bun", {
    minimum: pins.bunMinimumVersion,
    version: pins.bunVersion,
    runtime,
  });
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
    log.warn("ignoring {journal} entry {entry}: {problem}", {
      journal: PROVENANCE_NAME,
      entry: JSON.stringify(entry),
      problem,
    });
  for (const entry of journal.accepted) owned.add(entry);
  for (const entry of createdNow) owned.add(entry);
  owned.add(path.join(home, "install.json"));
  return [...owned];
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

export async function installCommand(options: InstallArguments): Promise<void> {
  const requestedRuntime = options.runtime ?? null;
  const home = await canonicalDirectory(options.home ?? process.env.CHOCO_PI_HOME ?? defaultHome());
  const binDir = await canonicalDirectory(options.binDir ?? path.join(homedir(), ".local", "bin"));
  const app = path.join(home, "app");
  if (!(await samePath(APP_ROOT, app))) {
    throw new Error(
      `install must run from ${app}/scripts/standalone/manage.ts (this is ${APP_ROOT})`,
    );
  }
  const previous = await readInstallManifest(home);
  const local = options.localApp || (previous !== null && previous.source === null);
  let source: string | null = null;
  let ref: string | null = null;
  let rev: string | null = null;
  if (!local) {
    if (!(await exists(path.join(app, ".git"))))
      throw new Error(`${app} is not a git checkout; use install.sh or --local-app`);
    source = options.source ?? previous?.source ?? null;
    if (source === null) throw new UsageError("--source is required for a first install");
    ref = options.ref ?? previous?.ref ?? null;
    if (ref === null) {
      try {
        ref = await git(app, ["symbolic-ref", "--short", "HEAD"]);
      } catch {
        throw new UsageError("cannot tell which ref to install; pass --ref");
      }
    }
    // install.sh moved the checkout to the revision it installs before this
    // revision's code ran; stage 1 never moves it.
    rev = await git(app, ["rev-parse", "--verify", "HEAD"]);
  }
  const createdNow: string[] = [];
  const record = recorder(home, createdNow);
  await assertPiBinEntry(app);
  const piRuntime = requestedRuntime ?? previous?.runtime ?? DEFAULT_RUNTIME;
  const bun =
    piRuntime === "bun"
      ? await ensureBun(home, app, previous?.bun_path, process.env.PATH ?? "", record)
      : null;
  if (bun !== null) log.info("bun: {source} {path} ({version})", bun);
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
    log.info("removed old link: {link}", { link: previous.bin_link });
  }
  if (!created.includes(linked.link)) created.push(linked.link);
  await writeInstallManifest({ ...manifest, bin_link: linked.link, created });
  await clearProvenance(home);
  log.info("{action}: {link} -> {launcher}", { ...linked, launcher: launcherOf(app) });
  const where = rev === null ? " (local app)" : ` at ${rev.slice(0, 12)} (${ref})`;
  log.info("installed choco-pi in {home}{where}; Pi runs on {runtime}", {
    home,
    where,
    runtime: piRuntime,
  });
  const hint = pathHint(binDir);
  if (hint !== null) log.info("{hint}", { hint });
}

export async function setupCommand(options: SetupArguments): Promise<void> {
  const importing = options.importPiSettings;
  if (!importing && (options.from !== undefined || options.force))
    throw new UsageError("--from and --force apply only with --import-pi-settings");
  const { home, launcher } = requireContract();
  const agentDir = path.join(home, "agent");
  // The only standalone step that reads ~/.pi, and only when asked for. A
  // repeated import is refused before setup changes anything.
  const settingsImport = importing ? await import("./settings-import.ts") : null;
  const importSource = settingsImport?.importSourcePath(options.from) ?? null;
  if (settingsImport !== null) await settingsImport.assertImportAllowed(agentDir, options.force);
  await assertPiBinEntry(APP_ROOT);
  const { installProfile } = await import("../install-profile.ts");
  const result = await installProfile({
    root: APP_ROOT,
    agentDir,
    piLauncher: launcher,
    // No model scope until the user logs in: each scoped pattern without
    // credentials is a startup warning.
    defaultEnabledModels: [],
  });
  for (const link of result.links) log.info("{action}: {target}", link);
  log.info("updated: {path}", { path: result.settingsPath });
  log.info("updated: {path}", { path: result.markerPath });
  for (const target of result.removed) log.info("removed: {target}", { target });
  for (const warning of result.warnings) log.warn("{warning}", { warning });
  const { applySettingsSeed, readSettingsSeed } = await import("./settings-seed.ts");
  const seed = await applySettingsSeed(agentDir, await readSettingsSeed());
  if (seed.added.length > 0) log.info("seeded: {keys}", { keys: seed.added.join(", ") });
  if (settingsImport !== null && importSource !== null) {
    const imported = await settingsImport.importPiSettings(agentDir, importSource, {
      force: options.force,
    });
    for (const line of settingsImport.importReport(imported)) log.info("{line}", { line });
  }
  await launcherVersionMatches(home, APP_ROOT, null);
  if (seed.firstSeed) process.stdout.write(nextStepsHint(home));
}

/** Printed after the first standalone setup of an agent directory. */
export function nextStepsHint(home: string): string {
  const step = (command: string, purpose: string) => `  ${command.padEnd(14)} ${purpose}`;
  return [
    "",
    "Next steps:",
    step("choco-pi", "start choco-pi"),
    step(
      "/login",
      `sign in to a provider (stored only in ${path.join(home, "agent", "auth.json")})`,
    ),
    step("/preferences", "change language, style, persona and other preferences"),
    "",
    "Optional: choco-pi self setup --import-pi-settings copies your preferences once from",
    "~/.pi/agent/settings.json (only that file; never login, sessions, trust, MCP or packages).",
    "",
  ].join("\n");
}

/** The oldest installer_protocol whose install.sh takes over an update (--rev). */
const HANDOFF_PROTOCOL = 3;

/**
 * Fetches `ref` into `app` and returns the commit to install, without moving
 * HEAD. Refuses a dirty tree and, unless allowed, a target that is not a
 * fast-forward of HEAD.
 */
async function fetchTarget(
  app: string,
  ref: string,
  allowNonFastForward: boolean,
): Promise<string> {
  const dirty = await git(app, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty !== "") throw new Error(`${app} has local changes; refusing to move it:\n${dirty}`);
  await git(app, ["fetch", "--quiet", "--no-auto-gc", "origin", ref]);
  const target = await git(app, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  const head = await git(app, ["rev-parse", "--verify", "HEAD"]);
  if (target === head || allowNonFastForward) return target;
  try {
    await git(app, ["merge-base", "--is-ancestor", head, target]);
  } catch {
    throw new Error(
      `origin ${ref} (${target.slice(0, 12)}) is not a fast-forward of ${head.slice(0, 12)}`,
    );
  }
  return target;
}

/**
 * The installer_protocol `rev` declares, read the way install.sh reads it,
 * so pins of any format work; null when `rev` has no runtime-pins.txt, 1 when
 * the pin is absent (the protocol before the key existed) or not a number.
 */
async function protocolAt(app: string, rev: string): Promise<number | null> {
  const pins = path.relative(APP_ROOT, PINS_FILE).split(path.sep).join("/");
  const text = await git(app, ["show", `${rev}:${pins}`]).catch(() => null);
  if (text === null) return null;
  const value = readPin(text, "installer_protocol");
  return value !== null && /^[1-9]\d{0,8}$/.test(value) ? Number.parseInt(value, 10) : 1;
}

/** The environment of a handed-off install.sh: the caller's, without the launcher contract. */
function installerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...environment };
  for (const name of [...CONTRACT_VARIABLES, ...RUNTIME_REPORT_VARIABLES]) delete child[name];
  return child;
}

/**
 * Runs the install.sh of the revision checked out in the app, which installs
 * exactly `rev` with that revision's own code and pins. The arguments are
 * the installer_protocol 3 hand-off; every later install.sh accepts them.
 */
async function runInstaller(manifest: InstallManifest, ref: string, rev: string): Promise<void> {
  if (manifest.source === null || manifest.bin_link === null)
    throw new Error(
      `${manifest.home}/install.json records no source or launcher link; re-run install.sh`,
    );
  const args = [
    path.join(manifest.app, "install.sh"),
    "--home",
    manifest.home,
    "--bin-dir",
    path.dirname(manifest.bin_link),
    "--source",
    manifest.source,
    "--ref",
    ref,
    "--rev",
    rev,
  ];
  if (manifest.runtime !== undefined) args.push("--runtime", manifest.runtime);
  await run("/bin/sh", args, manifest.app, installerEnvironment());
}

/**
 * Fetches the target, checks that its install.sh takes over updates, then
 * runs it. The running code only moves the checkout: the target's own
 * install.sh and stage 1 read its pins and install it, so an update can
 * cross any change of the toolchain or the pins format. On failure the
 * current revision is checked out again and reinstalled by its own install.sh.
 */
export async function updateCommand(options: { ref?: string | undefined }): Promise<void> {
  const { home } = requireContract();
  const app = path.join(home, "app");
  if (!(await samePath(APP_ROOT, app)))
    throw new Error(`self update only manages ${app}; this launcher runs from ${APP_ROOT}`);
  const manifest = await readInstallManifest(home);
  if (manifest === null) throw new Error(`${home}/install.json is missing; re-run install.sh`);
  if (manifest.source === null)
    throw new Error("this is a local-app install; it has no source to update from");
  const ref = options.ref ?? manifest.ref;
  if (ref === null) throw new UsageError("no recorded ref; pass --ref");
  const oldRev = await git(app, ["rev-parse", "--verify", "HEAD"]);
  const target = await fetchTarget(app, ref, ref !== manifest.ref);
  const protocol = await protocolAt(app, target);
  if (protocol === null) {
    throw new Error(
      `origin ${ref} (${target.slice(0, 12)}) has no runtime pins; it is not a standalone-capable choco-pi`,
    );
  }
  if (protocol < HANDOFF_PROTOCOL) {
    throw new Error(
      `origin ${ref} (${target.slice(0, 12)}) declares installer_protocol ${protocol}, older than ${HANDOFF_PROTOCOL}, so self update cannot install it; run that revision's own install.sh instead`,
    );
  }
  try {
    await git(app, ["checkout", "--quiet", "--detach", target]);
    await runInstaller(manifest, ref, target);
  } catch (error) {
    log.error("update to {target} failed: {reason}", {
      target: target.slice(0, 12),
      reason: error instanceof Error ? error.message : String(error),
    });
    log.warn("returning to {revision}", { revision: oldRev.slice(0, 12) });
    await git(app, ["checkout", "--quiet", "--force", "--detach", oldRev]);
    // The failed stage 1 may have rewritten install.json in a format this
    // revision does not read; what that run created is still in the journal,
    // which the reinstall merges.
    try {
      await writeInstallManifest(manifest);
      await runInstaller(manifest, manifest.ref ?? ref, oldRev);
    } catch (restoreError) {
      throw new Error(
        `update to ${target.slice(0, 12)} failed, and reinstalling ${oldRev.slice(0, 12)} failed too (${restoreError instanceof Error ? restoreError.message : String(restoreError)}); re-run install.sh with the same --home, --bin-dir and --source`,
        { cause: error },
      );
    }
    throw new Error(`update failed; restored ${oldRev.slice(0, 12)}`, { cause: error });
  }
  if (target === oldRev)
    log.info("already at {target} ({ref})", { target: target.slice(0, 12), ref });
  else
    log.info("updated {from} -> {target} ({ref})", {
      from: oldRev.slice(0, 12),
      target: target.slice(0, 12),
      ref,
    });
}

export async function uninstallCommand(options: { purge: boolean }): Promise<void> {
  const { home, launcher } = requireContract();
  await uninstall({
    home,
    launcher,
    manifest: await readInstallManifest(home),
    purge: options.purge,
    log: {
      info: (line) => log.info("{line}", { line }),
      warn: (line) => log.warn("{line}", { line }),
    },
  });
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

export async function runtimeCommand(options: { runtime?: Runtime | undefined }): Promise<void> {
  const { home } = requireContract();
  const manifest = await readInstallManifest(home);
  const current = runtimeReport();
  const runtime = options.runtime;
  if (runtime === undefined) {
    const source =
      current.source === "env"
        ? "env CHOCO_PI_RUNTIME"
        : current.source === "install.json"
          ? manifestPathOf(home)
          : "default";
    const lines = [
      `runtime=${current.name}`,
      `source=${source}`,
      `binary=${current.binary ?? "(no usable bun found)"}`,
      `node=${process.env.CHOCO_PI_NODE ?? process.execPath}`,
    ];
    if (manifest !== null)
      lines.push(`persisted=${manifest.runtime ?? `${DEFAULT_RUNTIME} (default)`}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
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
    log.info("bun: {source} {path} ({version})", bun);
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
      { cause: error },
    );
  }
  log.info("runtime={runtime} (persisted in {file})", { runtime, file: manifestPathOf(home) });
  if (current.source === "env" && current.name !== runtime) {
    log.info("note: CHOCO_PI_RUNTIME={name} in this environment still overrides it", current);
  }
}

function manifestPathOf(home: string): string {
  return path.join(home, "install.json");
}

export function envCommand(options: { json: boolean; names: readonly string[] }): void {
  requireContract();
  const pick = (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
  const report = {
    contract: pick(CONTRACT_VARIABLES),
    unset: pick(UNSET_PI_VARIABLES),
    requested: pick(options.names),
    runtime: runtimeReport(),
    node: process.execPath,
    app: APP_ROOT,
    path: process.env.PATH ?? null,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(report.contract)) lines.push(`${key}=${value ?? ""}`);
  for (const [key, value] of [...Object.entries(report.unset), ...Object.entries(report.requested)])
    lines.push(value === null ? `unset ${key}` : `${key}=${value}`);
  lines.push(`CHOCO_PI_RUNTIME=${report.runtime.name} (${report.runtime.source})`);
  lines.push(`runtime_binary=${report.runtime.binary ?? ""}`);
  lines.push(`node=${report.node}`);
  lines.push(`app=${report.app}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export const USAGE = `Usage: choco-pi [pi arguments...]
       choco-pi self <command>

Management commands:
  self setup                 Install the choco-pi profile into $CHOCO_PI_HOME/agent (idempotent)
  self setup --import-pi-settings [--from FILE] [--force]
                             Also copy preferences once from ~/.pi/agent/settings.json
                             (or FILE); the only command that reads ~/.pi
  self update [--ref REF]    Install the newest REF (default: the recorded one) with that
                             revision's own install.sh; on failure, restore this one
  self uninstall [--purge]   Remove what install.json records; keeps agent/ and lsp/ unless --purge
  self env [--json] [NAME...] Print the launcher environment contract (and the named variables)
  self runtime [node|bun]    Show the runtime Pi runs on and its source, or persist one
                             (bun: uses a bun >= the pinned minimum or downloads the pinned Bun)
  self exec <cmd> [args...]  Run a command under the launcher environment
  self acp [args...]         Run the choco-pi ACP adapter under the launcher environment
  self help                  Show this help; add --help after a command for its options

Everything else is passed to Pi unchanged, e.g. choco-pi --version, choco-pi --mode rpc.
CHOCO_PI_RUNTIME=node|bun overrides the persisted runtime for one invocation.
`;

/**
 * Ends parsing after Optique printed help (exit 0) or a usage error (exit 2).
 * Its callbacks throw this because runParserSync returns their result typed
 * as a parsed value.
 */
class ParseExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`command-line parsing ended with exit status ${exitCode}`);
    this.name = "ParseExit";
    this.exitCode = exitCode;
  }
}

/** The parsed command line, or the exit status when Optique already answered it. */
function parseCommandLine(argv: readonly string[]): InferValue<typeof commandLine> | ParseExit {
  try {
    return runParserSync(commandLine, "choco-pi", argv, {
      help: {
        option: true,
        onShow: () => {
          throw new ParseExit(0);
        },
      },
      onError: () => {
        throw new ParseExit(2);
      },
      stdout: (text) => process.stdout.write(`${text}\n`),
      stderr: (text) => process.stderr.write(`${text}\n`),
    });
  } catch (error) {
    if (error instanceof ParseExit) return error;
    throw error;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  configureLogging();
  const parsed = parseCommandLine(argv);
  if (parsed instanceof ParseExit) return parsed.exitCode;
  try {
    if (parsed.verb === "install") await installCommand(parsed);
    else if (parsed.verb === "setup") await setupCommand(parsed);
    else if (parsed.verb === "update") await updateCommand(parsed);
    else if (parsed.verb === "uninstall") await uninstallCommand(parsed);
    else if (parsed.verb === "env") envCommand(parsed);
    else if (parsed.verb === "runtime") await runtimeCommand(parsed);
    else process.stdout.write(USAGE);
    return 0;
  } catch (error) {
    log.error("{reason}", { reason: error instanceof Error ? error.message : String(error) });
    if (error instanceof UsageError) process.stderr.write(USAGE);
    return error instanceof UsageError ? 2 : 1;
  }
}
