import { VERSION, getPackageDir } from "@earendil-works/pi-coding-agent";

export type RuntimeVersionSource = "active-host" | "imported-sdk" | "launcher";

export type RuntimeVersionObservation = {
  source: RuntimeVersionSource;
  version?: string;
  path?: string;
  authoritative: boolean;
  error?: string;
};

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type RunCommand = (
  executable: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<CommandResult>;

export type HostIdentityOwner = {
  sessionId: string;
  generation: number;
};

export type CapturedHostIdentity = {
  runtime: RuntimeVersionObservation;
  nodeVersion: string;
  owner: HostIdentityOwner;
};

export function captureHostIdentity(input: {
  version: string;
  packageDir: string;
  nodeVersion: string;
  owner: HostIdentityOwner;
}): CapturedHostIdentity {
  return {
    runtime: {
      source: "active-host",
      version: input.version,
      path: input.packageDir,
      authoritative: true,
    },
    nodeVersion: input.nodeVersion,
    owner: { ...input.owner },
  };
}

export async function readImportedSdkVersion(): Promise<RuntimeVersionObservation> {
  return {
    source: "imported-sdk",
    version: VERSION,
    path: getPackageDir(),
    authoritative: true,
  };
}

export async function probeLauncherVersion(options: {
  runCommand: RunCommand;
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<RuntimeVersionObservation> {
  const executable = options.executable ?? "pi";
  try {
    const result = await options.runCommand(executable, ["--version"], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    if (result.status !== 0) {
      return {
        source: "launcher",
        path: executable,
        authoritative: false,
        error: result.stderr.trim() || `launcher exited with status ${result.status}`,
      };
    }
    const version = result.stdout.trim();
    return version.length > 0
      ? { source: "launcher", version, path: executable, authoritative: false }
      : {
          source: "launcher",
          path: executable,
          authoritative: false,
          error: "launcher returned an empty version",
        };
  } catch (error: unknown) {
    return {
      source: "launcher",
      path: executable,
      authoritative: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type Semver = { major: string; minor: string; patch: string; prerelease: readonly string[] };

function parseVersion(value: string): Semver | undefined {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    return undefined;
  }
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (a.length !== b.length) return a.length < b.length ? -1 : 1;
      return a < b ? -1 : 1;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersion(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] === right[key]) continue;
    if (left[key].length !== right[key].length) {
      return left[key].length < right[key].length ? -1 : 1;
    }
    return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}
