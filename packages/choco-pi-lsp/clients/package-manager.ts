import { isString } from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AvailabilityLatch,
  classifyProbeFailure,
  createAvailabilityLatch,
  isTransientDecision,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./dispatch/runners/utils/availability-policy.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";

type ExecArgsResultContract = { command: string; args: string[] };

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

const PREFERENCE: readonly NodePackageManager[] = ["npm", "pnpm", "yarn", "bun"];

function onWindows(): boolean {
  return process.platform === "win32";
}

function isNodePackageManager(value: string): value is NodePackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

export function detectNodePackageManager(targetPath: string): NodePackageManager | undefined {
  if (
    fs.existsSync(path.join(targetPath, "bun.lockb")) ||
    fs.existsSync(path.join(targetPath, "bun.lock"))
  ) {
    return "bun";
  }
  if (fs.existsSync(path.join(targetPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(targetPath, "yarn.lock"))) {
    return "yarn";
  }
  if (fs.existsSync(path.join(targetPath, "package-lock.json"))) {
    return "npm";
  }
  return readPackageManagerField(targetPath);
}

function readPackageManagerField(targetPath: string): NodePackageManager | undefined {
  try {
    const pkgPath = path.join(targetPath, "package.json");
    if (!fs.existsSync(pkgPath)) return undefined;

    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      packageManager?: unknown;
    };

    if (!isString(pkg.packageManager)) return undefined;
    const name = pkg.packageManager.split("@")[0].trim().toLowerCase();
    return isNodePackageManager(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

const PROBE_TIMEOUT_MS = 5_000;

const availabilityLatches = new Map<NodePackageManager, AvailabilityLatch>();
const inFlightProbes = new Map<NodePackageManager, Promise<boolean>>();

function getLatch(pm: NodePackageManager): AvailabilityLatch {
  let latch = availabilityLatches.get(pm);
  if (!latch) {
    latch = createAvailabilityLatch();
    availabilityLatches.set(pm, latch);
  }
  return latch;
}

async function probeAvailability(pm: NodePackageManager): Promise<boolean> {
  const latch = getLatch(pm);
  const startedAt = Date.now();
  const finder = onWindows() ? "where" : "which";
  const sampler = startHostStallSampler();
  let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
  let hostStallMs: number;
  try {
    result = await safeSpawnAsync(finder, [pm], { timeout: PROBE_TIMEOUT_MS });
  } finally {
    hostStallMs = sampler.stop();
  }
  const elapsedMs = Date.now() - startedAt;

  if (result.status === 0 && !result.error) {
    latch.noteAvailable();
    logAvailabilityDecision({
      tool: pm,
      verdict: "available",
      outcome: "success",
      cause: "ok",
      elapsedMs,
      latched: true,
      hostStallMs,
      budgetMs: PROBE_TIMEOUT_MS,
    });
    return true;
  }

  const { outcome, cause, evidence } = classifyProbeFailure(result, {
    hostStallMs,
    unclassifiedFailureOutcome: "missing",
  });
  const retryAfterMs = latch.noteUnavailable(outcome, cause);
  logAvailabilityDecision({
    tool: pm,
    verdict: "unavailable",
    outcome,
    cause,
    elapsedMs,
    latched: outcome !== "transient",
    hostStallMs,
    ...(retryAfterMs > 0 && { retryAfterMs }),
    budgetMs: PROBE_TIMEOUT_MS,
    classifiedBy: "probe",
    evidence,
  });
  return false;
}

function isAvailable(pm: NodePackageManager, onTransient?: () => void): Promise<boolean> {
  const latch = getLatch(pm);

  const reportIfTransient = (result: boolean): boolean => {
    if (!result && isTransientDecision({ outcome: latch.getOutcome() })) {
      onTransient?.();
    }
    return result;
  };

  const memo = latch.read();
  if (memo !== null) return Promise.resolve(reportIfTransient(memo));

  const inFlight = inFlightProbes.get(pm);
  if (inFlight) return inFlight.then(reportIfTransient);

  const probe: Promise<boolean> = probeAvailability(pm).finally(() => {
    if (inFlightProbes.get(pm) === probe) inFlightProbes.delete(pm);
  });
  inFlightProbes.set(pm, probe);
  return probe.then(reportIfTransient);
}

export function _resetPackageManagerCache(): void {
  availabilityLatches.clear();
  inFlightProbes.clear();
}

export async function resolveNodePackageManager(
  cwd: string = process.cwd(),
): Promise<NodePackageManager> {
  const declared = detectNodePackageManager(cwd);
  if (declared && (await isAvailable(declared))) {
    return declared;
  }
  for (const pm of PREFERENCE) {
    if (await isAvailable(pm)) return pm;
  }
  return "npm";
}

export function pmBinary(pm: NodePackageManager): string {
  if (!onWindows()) return pm;
  return pm === "bun" ? "bun.exe" : `${pm}.cmd`;
}

export function runScriptArgs(script: string): string[] {
  return ["run", script];
}

export function formatRunScript(pm: NodePackageManager, script: string): string {
  return `${pm} run ${script}`;
}

export interface InstallOptions {
  ignoreScripts?: boolean;
  legacyPeerDeps?: boolean;
}

export function installArgs(
  pm: NodePackageManager,
  pkg: string,
  options: InstallOptions = {},
): string[] {
  const args = [pm === "npm" ? "install" : "add"];
  if (options.ignoreScripts) args.push("--ignore-scripts");
  if (options.legacyPeerDeps && pm === "npm") args.push("--legacy-peer-deps");
  args.push(pkg);
  return args;
}

export function updateArgs(
  pm: NodePackageManager,
  pkg: string,
  options: Pick<InstallOptions, "ignoreScripts"> = {},
): string[] {
  const args = [pm === "yarn" ? "upgrade" : "update"];
  if (options.ignoreScripts) args.push("--ignore-scripts");
  args.push(pkg);
  return args;
}

export function globalInstallArgs(pm: NodePackageManager, pkg: string): string[] {
  switch (pm) {
    case "yarn":
      return ["global", "add", pkg];
    case "npm":
      return ["install", "-g", pkg];
    default:
      return ["add", "-g", pkg];
  }
}

export function execArgs(
  pm: NodePackageManager,
  pkg: string,
  args: string[] = [],
): ExecArgsResultContract {
  switch (pm) {
    case "bun":
      return { command: pmBinary("bun"), args: ["x", pkg, ...args] };
    case "pnpm":
      return { command: pmBinary("pnpm"), args: ["dlx", pkg, ...args] };
    case "yarn":
      return { command: pmBinary("yarn"), args: ["dlx", pkg, ...args] };
    default:
      return {
        command: onWindows() ? "npx.cmd" : "npx",
        args: ["--no", pkg, ...args],
      };
  }
}

async function globalBinDirsFor(pm: NodePackageManager): Promise<string[]> {
  if (pm === "bun") {
    const base = process.env.BUN_INSTALL || path.join(os.homedir(), ".bun");
    return [path.join(base, "bin")];
  }

  const query =
    pm === "npm" ? ["config", "get", "prefix"] : pm === "pnpm" ? ["bin", "-g"] : ["global", "bin"];
  const res = await safeSpawnAsync(pmBinary(pm), query, { timeout: 5000 });
  if (res.status !== 0 || res.error) return [];
  const out = res.stdout.trim();
  if (!out) return [];

  if (pm === "npm") {
    return [onWindows() ? out : path.join(out, "bin")];
  }
  return [out];
}

export async function allAvailableGlobalBinDirs(onTransient?: () => void): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const pm of PREFERENCE) {
    if (!(await isAvailable(pm, onTransient))) continue;
    for (const dir of await globalBinDirsFor(pm)) {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      dirs.push(normalized);
    }
  }
  return dirs;
}

export async function findGlobalBinary(
  command: string,
  windowsExt = ".cmd",
): Promise<string | undefined> {
  const candidates = onWindows()
    ? [`${command}${windowsExt}`, `${command}.exe`, command]
    : [command];
  try {
    for (const binDir of await allAvailableGlobalBinDirs()) {
      for (const name of candidates) {
        const full = path.join(binDir, name);
        if (fs.existsSync(full)) return full;
      }
    }
  } catch {}
  return undefined;
}

export function findLocalBinUpwards(
  tool: string,
  startDir: string,
  windowsExt = ".cmd",
): string | undefined {
  const names = onWindows() ? [`${tool}${windowsExt}`, tool] : [tool];
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    for (const name of names) {
      const full = path.join(dir, "node_modules", ".bin", name);
      if (fs.existsSync(full)) return full;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function findNodeToolBinary(
  tool: string,
  cwd: string,
  windowsExt = ".cmd",
): Promise<string | undefined> {
  return findLocalBinUpwards(tool, cwd, windowsExt) ?? (await findGlobalBinary(tool, windowsExt));
}
