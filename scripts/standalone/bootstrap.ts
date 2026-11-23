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

const PNPM_DIRECTORIES = ["pnpm-store", "pnpm-cache", "pnpm-state", "pnpm-home"] as const;

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
