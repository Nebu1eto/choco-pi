/**
 * Installs the app's dependencies: the step install.sh runs after it moved the
 * checkout and before stage 1 (manage.ts install). It runs before
 * `node_modules` exists, so it imports only Node built-ins and the
 * dependency-free installer modules. It takes no arguments: the app is this
 * checkout and the install home is the checkout's parent (`<home>/app`).
 * Every runtime directory it creates is journaled (provenance.ts) at once.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordCreated } from "./provenance.ts";
import {
  DEFAULT_NPM_REGISTRY,
  exists,
  findSystemPnpm,
  PINS_FILE,
  provisionPrivatePnpm,
  readRuntimePins,
  samePath,
  type OnCreated,
  type PnpmCommand,
  type RuntimePins,
} from "./provision.ts";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Runs `command` with inherited stdio; rejects unless it exits 0. */
export function run(
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
  if (system !== null) return { pnpm: { command: system, source: "system" }, created: [] };
  const registry = process.env.CHOCO_PI_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY;
  const provisioned = await provisionPrivatePnpm(runtime, pins, { registry, onCreated });
  return {
    pnpm: { command: provisioned.path, source: "private" },
    created: provisioned.created,
  };
}

/**
 * pnpm's writable locations, all under `runtime`: the store, metadata cache
 * and state (flags below) and PNPM_HOME (environment only), which pnpm 12
 * otherwise creates as ~/Library/pnpm or $XDG_DATA_HOME/pnpm even for a
 * project install.
 */
const PNPM_DIRECTORIES = ["pnpm-store", "pnpm-cache", "pnpm-state", "pnpm-home"] as const;

/**
 * pnpm 12 accepts any `--config.<key>` silently, so each of these was checked
 * against its effect: store-dir, cache-dir and state-dir each keep their
 * files out of the user's home, and an explicit store-dir is used as given
 * instead of a default or volume-root store. `pm-on-fail=error` makes a
 * packageManager mismatch an error instead of a download of another pnpm
 * (`manage-package-manager-versions` no longer does);
 * assertPackageManagerPin already rules that mismatch out.
 */
export function pnpmInstallArgs(runtime: string): string[] {
  return [
    "install",
    "--frozen-lockfile",
    "--prod",
    `--config.store-dir=${path.join(runtime, PNPM_DIRECTORIES[0])}`,
    `--config.cache-dir=${path.join(runtime, PNPM_DIRECTORIES[1])}`,
    `--config.state-dir=${path.join(runtime, PNPM_DIRECTORIES[2])}`,
    "--config.confirm-modules-purge=false",
    "--config.pm-on-fail=error",
    "--config.update-notifier=false",
  ];
}

/** The environment of `pnpm install`: PNPM_HOME has no command-line form. */
export function pnpmInstallEnvironment(
  runtime: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    COREPACK_ENABLE_NETWORK: "0",
    PNPM_HOME: path.join(runtime, PNPM_DIRECTORIES[3]),
  };
}

export async function assertPackageManagerPin(app: string, pins: RuntimePins): Promise<void> {
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
export async function installDependencies(
  app: string,
  runtime: string,
  record: OnCreated,
): Promise<void> {
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
  process.stdout.write(`pnpm: ${pnpm.source} ${pnpm.command}\n`);
  await run(pnpm.command, pnpmInstallArgs(runtime), app, pnpmInstallEnvironment(runtime));
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("usage: node <home>/app/scripts/standalone/bootstrap.ts (no arguments)\n");
    return 2;
  }
  if (path.basename(APP_ROOT) !== "app") {
    process.stderr.write(`choco-pi bootstrap: error: ${APP_ROOT} is not <home>/app\n`);
    return 1;
  }
  const home = path.dirname(APP_ROOT);
  try {
    await installDependencies(APP_ROOT, path.join(home, "runtime"), (created) =>
      recordCreated(home, created),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`choco-pi bootstrap: error: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && (await samePath(process.argv[1], fileURLToPath(import.meta.url)))) {
  process.exitCode = await main(process.argv.slice(2));
}
