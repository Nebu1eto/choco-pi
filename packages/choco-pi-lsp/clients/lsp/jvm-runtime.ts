import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyProbeFailure,
  createAvailabilityLatch,
  logAvailabilityDecision,
  startHostStallSampler,
} from "../dispatch/runners/utils/availability-policy.ts";
import { getGlobalPiLensDir } from "../file-utils.ts";
import { safeSpawnAsync } from "../safe-spawn.ts";

const JAVA_EXE = process.platform === "win32" ? "java.exe" : "java";
const JAVA_PROBE_TIMEOUT_MS = 5_000;

const MIN_JAVA_MAJOR = 17;

function jdkHomeFrom(dir: string): string | undefined {
  if (existsSync(path.join(dir, "bin", JAVA_EXE))) return dir;
  const macHome = path.join(dir, "Contents", "Home");
  if (existsSync(path.join(macHome, "bin", JAVA_EXE))) return macHome;
  return undefined;
}

function parseMajorVersion(name: string): number {
  const legacy = name.match(/(?<!\d)1\.(\d+)/);
  if (legacy) return Number.parseInt(legacy[1], 10);
  const modern = name.match(/(?<!\d)(\d{1,2})/);
  return modern ? Number.parseInt(modern[1], 10) : 0;
}

function childDirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(base, e.name));
  } catch {
    return [];
  }
}

function candidateRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  roots.push(path.join(home, ".jdks"));
  roots.push(path.join(getGlobalPiLensDir(), "tools"));

  if (process.platform === "win32") {
    const progFiles = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramW6432,
      path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs"),
    ].filter((p): p is string => Boolean(p));
    for (const base of progFiles) {
      roots.push(path.join(base, "Eclipse Adoptium"));
      roots.push(path.join(base, "Java"));
      roots.push(path.join(base, "Microsoft"));
      roots.push(path.join(base, "Zulu"));
      roots.push(path.join(base, "Amazon Corretto"));
      roots.push(path.join(base, "BellSoft"));
    }
  } else if (process.platform === "darwin") {
    roots.push("/Library/Java/JavaVirtualMachines");
    roots.push(path.join(home, "Library", "Java", "JavaVirtualMachines"));
    roots.push("/opt/homebrew/opt");
    roots.push("/usr/local/opt");
  } else {
    roots.push("/usr/lib/jvm");
    roots.push("/usr/java");
    roots.push("/opt/java");
  }
  return roots;
}

interface JdkCandidate {
  home: string;
  major: number;
}

export function discoverJdkHome(
  roots: string[] = candidateRoots(),
  javaHome: string | undefined = process.env.JAVA_HOME,
): string | undefined {
  const found: JdkCandidate[] = [];

  if (javaHome) {
    const resolved = jdkHomeFrom(javaHome);
    if (resolved) found.push({ home: resolved, major: Number.MAX_SAFE_INTEGER });
  }

  for (const root of roots) {
    for (const dir of childDirs(root)) {
      const resolved = jdkHomeFrom(dir);
      if (!resolved) continue;
      found.push({ home: resolved, major: parseMajorVersion(path.basename(dir)) });
    }
  }

  const usable = found.filter((c) => c.major >= MIN_JAVA_MAJOR);
  if (usable.length === 0) return undefined;
  usable.sort((a, b) => b.major - a.major);
  return usable[0].home;
}

let _cachedEnv: { value: NodeJS.ProcessEnv | undefined } | undefined;

const javaAvailabilityLatch = createAvailabilityLatch();

let inFlightJavaProbe: Promise<boolean | undefined> | null = null;

export function _resetJvmRuntimeCacheForTests(): void {
  _cachedEnv = undefined;
  javaAvailabilityLatch.reset();
  inFlightJavaProbe = null;
}

function probeJavaOnPath(): Promise<boolean | undefined> {
  const memo = javaAvailabilityLatch.read();
  if (memo !== null) {
    if (javaAvailabilityLatch.getOutcome() === "transient") {
      logAvailabilityDecision({
        tool: "java",
        verdict: "unavailable",
        outcome: "transient",
        cause: javaAvailabilityLatch.getCause() ?? "probe-timeout",
        elapsedMs: 0,
        latched: false,
        retryAfterMs: Math.max(0, javaAvailabilityLatch.getRetryAtMs() - Date.now()),
        budgetMs: JAVA_PROBE_TIMEOUT_MS,
      });
      return Promise.resolve(undefined);
    }
    return Promise.resolve(memo);
  }

  if (inFlightJavaProbe) return inFlightJavaProbe;
  inFlightJavaProbe = runJavaProbe().finally(() => {
    inFlightJavaProbe = null;
  });
  return inFlightJavaProbe;
}

async function runJavaProbe(): Promise<boolean | undefined> {
  const finder = process.platform === "win32" ? "where" : "which";
  const startedAt = Date.now();
  const sampler = startHostStallSampler();
  let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
  let hostStallMs: number;
  try {
    result = await safeSpawnAsync(finder, ["java"], {
      timeout: JAVA_PROBE_TIMEOUT_MS,
    });
  } finally {
    hostStallMs = sampler.stop();
  }
  const elapsedMs = Date.now() - startedAt;

  if (result.status === 0 && !result.error) {
    javaAvailabilityLatch.noteAvailable();
    logAvailabilityDecision({
      tool: "java",
      verdict: "available",
      outcome: "success",
      cause: "ok",
      elapsedMs,
      latched: true,
      hostStallMs,
      budgetMs: JAVA_PROBE_TIMEOUT_MS,
    });
    return true;
  }

  const { outcome, cause } = classifyProbeFailure(result, {
    hostStallMs,
    unclassifiedFailureOutcome: "missing",
  });
  const retryAfterMs = javaAvailabilityLatch.noteUnavailable(outcome, cause);
  logAvailabilityDecision({
    tool: "java",
    verdict: "unavailable",
    outcome,
    cause,
    elapsedMs,
    latched: outcome !== "transient",
    hostStallMs,
    ...(retryAfterMs > 0 && { retryAfterMs }),
    budgetMs: JAVA_PROBE_TIMEOUT_MS,
  });
  return outcome === "transient" ? undefined : false;
}

export async function resolveJavaRuntimeEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  if (_cachedEnv) return _cachedEnv.value;

  const javaOnPath = await probeJavaOnPath();
  if (javaOnPath === true) {
    _cachedEnv = { value: undefined };
    return undefined;
  }

  const home = discoverJdkHome();
  if (home) {
    const binDir = path.join(home, "bin");
    const currentPath = process.env.PATH ?? process.env.Path ?? "";
    _cachedEnv = {
      value: {
        JAVA_HOME: home,
        PATH: binDir + path.delimiter + currentPath,
      },
    };
    return _cachedEnv.value;
  }

  if (javaOnPath === false) {
    _cachedEnv = { value: undefined };
  }
  return undefined;
}
