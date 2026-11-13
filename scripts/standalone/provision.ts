/**
 * Checksum-verified downloads for the standalone installer.
 *
 * Only Node built-ins are imported: stage 1 runs this before the app's
 * dependencies are installed. An archive is always verified in full before
 * `tar` sees it, so a mismatched download never reaches the file system as
 * extracted content.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export const NODE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type NodePlatform = (typeof NODE_PLATFORMS)[number];

/** Bun release asset platforms (`bun-<platform>.zip`; glibc builds on Linux). */
export const BUN_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x64",
  "linux-x64",
  "linux-aarch64",
] as const;
export type BunPlatform = (typeof BUN_PLATFORMS)[number];

export type RuntimePins = {
  nodeVersion: string;
  nodeSha256: ReadonlyMap<NodePlatform, string>;
  pnpmVersion: string;
  pnpmIntegrity: string;
  bunVersion: string;
  bunMinimumVersion: string;
  bunSha256: ReadonlyMap<BunPlatform, string>;
};

export type DigestAlgorithm = "sha256" | "sha512";
export type ExpectedDigest = { algorithm: DigestAlgorithm; digest: Buffer };

export class ChecksumMismatchError extends Error {
  constructor(archive: string, expected: ExpectedDigest, actual: Buffer) {
    super(
      `checksum mismatch for ${archive}: expected ${expected.algorithm} ${expected.digest.toString("hex")}, got ${actual.toString("hex")}; nothing was extracted`,
    );
    this.name = "ChecksumMismatchError";
  }
}

export const PINS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "runtime-pins.txt",
);

function isNodePlatform(value: string): value is NodePlatform {
  return NODE_PLATFORMS.some((platform) => platform === value);
}

function isBunPlatform(value: string): value is BunPlatform {
  return BUN_PLATFORMS.some((platform) => platform === value);
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export function parseRuntimePins(text: string): RuntimePins {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(\S+)$/.exec(line);
    if (match === null) throw new Error(`malformed runtime pin line: ${line}`);
    if (values.has(match[1])) throw new Error(`duplicate runtime pin: ${match[1]}`);
    values.set(match[1], match[2]);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`missing runtime pin: ${key}`);
    return value;
  };
  const nodeVersion = required("node_version");
  if (!/^24\.\d+\.\d+$/.test(nodeVersion))
    throw new Error(`node_version must be 24.x.y: ${nodeVersion}`);
  const nodeSha256 = new Map<NodePlatform, string>();
  for (const [key, value] of values) {
    if (!key.startsWith("node_sha256_")) continue;
    const platform = key.slice("node_sha256_".length);
    if (!isNodePlatform(platform)) throw new Error(`unsupported Node platform pin: ${key}`);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} is not a sha256 hex digest`);
    nodeSha256.set(platform, value);
  }
  for (const platform of NODE_PLATFORMS) {
    if (!nodeSha256.has(platform)) throw new Error(`missing runtime pin: node_sha256_${platform}`);
  }
  const pnpmVersion = required("pnpm_version");
  if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion))
    throw new Error(`pnpm_version is not exact: ${pnpmVersion}`);
  const pnpmIntegrity = required("pnpm_integrity");
  parseIntegrity(pnpmIntegrity);
  const bunVersion = required("bun_version");
  const bunMinimumVersion = required("bun_minimum_version");
  for (const [key, value] of [
    ["bun_version", bunVersion],
    ["bun_minimum_version", bunMinimumVersion],
  ]) {
    if (!EXACT_VERSION.test(value)) throw new Error(`${key} is not exact: ${value}`);
  }
  if (compareVersions(bunVersion, bunMinimumVersion) < 0)
    throw new Error("bun_version is older than bun_minimum_version");
  const bunSha256 = new Map<BunPlatform, string>();
  for (const [key, value] of values) {
    if (!key.startsWith("bun_sha256_")) continue;
    const platform = key.slice("bun_sha256_".length);
    if (!isBunPlatform(platform)) throw new Error(`unsupported Bun platform pin: ${key}`);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} is not a sha256 hex digest`);
    bunSha256.set(platform, value);
  }
  for (const platform of BUN_PLATFORMS) {
    if (!bunSha256.has(platform)) throw new Error(`missing runtime pin: bun_sha256_${platform}`);
  }
  return {
    nodeVersion,
    nodeSha256,
    pnpmVersion,
    pnpmIntegrity,
    bunVersion,
    bunMinimumVersion,
    bunSha256,
  };
}

export async function readRuntimePins(file = PINS_FILE): Promise<RuntimePins> {
  return parseRuntimePins(await readFile(file, "utf8"));
}

/** Parses an npm `dist.integrity` value; only sha512 is accepted. */
export function parseIntegrity(integrity: string): ExpectedDigest {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (match === null) throw new Error(`unsupported integrity value: ${integrity}`);
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64) throw new Error(`sha512 integrity has the wrong length: ${integrity}`);
  return { algorithm: "sha512", digest };
}

export function sha256Expected(hex: string): ExpectedDigest {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`not a sha256 hex digest: ${hex}`);
  return { algorithm: "sha256", digest: Buffer.from(hex, "hex") };
}

export async function fileDigest(file: string, algorithm: DigestAlgorithm): Promise<Buffer> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest();
}

export async function verifyArchive(archive: string, expected: ExpectedDigest): Promise<void> {
  const actual = await fileDigest(archive, expected.algorithm);
  if (!actual.equals(expected.digest)) throw new ChecksumMismatchError(archive, expected, actual);
}

export type ArchiveFormat =
  | { kind: "tar.gz" }
  /** `unzip` is an absolute path: the caller located it before downloading. */
  | { kind: "zip"; unzip: string };

/**
 * Verifies `archive`, then extracts its single top-level directory to
 * `destination` (replacing it). Extraction happens in a sibling staging
 * directory so a failed extraction leaves the previous destination intact.
 * The extractor never runs before the digest matched.
 */
export async function extractVerifiedArchive(
  archive: string,
  expected: ExpectedDigest,
  destination: string,
  format: ArchiveFormat = { kind: "tar.gz" },
): Promise<void> {
  await verifyArchive(archive, expected);
  const staging = `${destination}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    if (format.kind === "zip") {
      await runFile(format.unzip, ["-q", archive, "-d", staging], { maxBuffer: 1024 * 1024 });
    } else {
      await runFile("tar", ["-xzf", archive, "-C", staging], { maxBuffer: 1024 * 1024 });
    }
    const entries = await readdir(staging);
    if (entries.length !== 1) {
      throw new Error(
        `${archive} must contain exactly one top-level directory, found ${entries.length}`,
      );
    }
    await rm(destination, { recursive: true, force: true });
    await rename(path.join(staging, entries[0]), destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Downloads `url` (https: or file:) to `destination`. */
export async function download(url: string, destination: string): Promise<void> {
  const parsed = new URL(url);
  await mkdir(path.dirname(destination), { recursive: true });
  if (parsed.protocol === "file:") {
    await copyFile(fileURLToPath(parsed), destination);
    return;
  }
  if (parsed.protocol !== "https:") throw new Error(`refusing a non-https download: ${url}`);
  const response = await fetch(parsed, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${url} (HTTP ${response.status})`);
  }
  // Registry tarballs are a few MB; buffering avoids web/Node stream type friction.
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
}

/** pnpm qualifies only at the exact pinned version, so pnpm never self-manages its version. */
export function pnpmVersionQualifies(versionOutput: string, pinned: string): boolean {
  return versionOutput.trim() === pinned;
}

export type PnpmCommand = {
  command: string;
  prefixArgs: readonly string[];
  source: "system" | "private";
};

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment for probing a foreign pnpm: never let corepack or pnpm download
 * another version into the user's home while answering `--version`.
 */
export function probeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    pnpm_config_manage_package_manager_versions: "false",
    npm_config_manage_package_manager_versions: "false",
  };
}

/** Returns the first `pnpm` on `searchPath` that reports exactly `pinned`. */
export async function findSystemPnpm(
  searchPath: string,
  pinned: string,
  probeDirectory: string,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "" || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "pnpm");
    if (seen.has(candidate) || !(await isExecutable(candidate))) continue;
    seen.add(candidate);
    try {
      const { stdout } = await runFile(candidate, ["--version"], {
        cwd: probeDirectory,
        env: probeEnvironment(process.env),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
      if (pnpmVersionQualifies(stdout, pinned)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export const PRIVATE_PNPM_ENTRY = path.join("bin", "pnpm.mjs");

async function privatePnpmVersion(pnpmDirectory: string): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(path.join(pnpmDirectory, "package.json"), "utf8"),
    );
    const version = manifest instanceof Object && "version" in manifest ? manifest.version : null;
    return version === null || version === undefined ? null : String(version);
  } catch {
    return null;
  }
}

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Numeric x.y.z comparison; anything after "-" or "+" is ignored, like bin/choco-pi. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) =>
    (value.trim().split(/[-+]/)[0] ?? "").split(".").map((part) => Number.parseInt(part, 10));
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `version` (from `bun --version`) is at least `minimum`. */
export function bunVersionQualifies(version: string, minimum: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version.trim()) && compareVersions(version, minimum) >= 0;
}

async function isMuslLinux(): Promise<boolean> {
  try {
    return (await readdir("/lib")).some((entry) => entry.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}

/** The pinned Bun asset for this machine; null when none is pinned (musl, Windows, ...). */
export async function currentBunPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<BunPlatform | null> {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x64" : null;
  if (cpu === null) return null;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "linux" && !(await isMuslLinux())) return `linux-${cpu}`;
  return null;
}

export type BunCommand = { path: string; version: string };

/**
 * Runs `candidate` as Bun from `probeDirectory` (no project bunfig or .env)
 * and returns its real binary (a version-manager shim resolves to the
 * binary it runs) and version; null when it does not run.
 */
export async function probeBun(
  candidate: string,
  probeDirectory: string,
): Promise<BunCommand | null> {
  try {
    const { stdout } = await runFile(
      candidate,
      [
        "--no-env-file",
        "-e",
        'process.stdout.write((process.versions.bun ?? "") + "\\n" + process.execPath)',
      ],
      { cwd: probeDirectory, timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    // A path with a newline is not a usable binary path anyway.
    const lines = stdout.split("\n");
    if (lines.length !== 2) return null;
    const [version = "", executable = ""] = lines;
    if (!/^\d+\.\d+\.\d+/.test(version) || !path.isAbsolute(executable)) return null;
    return { path: executable, version };
  } catch {
    return null;
  }
}

/** The first `bun` on `searchPath` at least `minimum`, as its real binary. */
export async function findSystemBun(
  searchPath: string,
  minimum: string,
  probeDirectory: string,
): Promise<BunCommand | null> {
  const seen = new Set<string>();
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "" || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "bun");
    if (seen.has(candidate) || !(await isExecutable(candidate))) continue;
    seen.add(candidate);
    const probed = await probeBun(candidate, probeDirectory);
    if (probed !== null && bunVersionQualifies(probed.version, minimum)) return probed;
  }
  return null;
}

/** An executable named `command` on `searchPath`, or null. */
export async function findOnPath(command: string, searchPath: string): Promise<string | null> {
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "" || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export const DEFAULT_BUN_MIRROR = "https://github.com/oven-sh/bun/releases/download";
export const PRIVATE_BUN_ENTRY = path.join("bin", "bun");

export const UNZIP_GUIDANCE =
  "unzip is required to unpack Bun but was not found on PATH. Install it with your system's package manager (for example apt-get install unzip, dnf install unzip), then retry; choco-pi does not elevate privileges.";

export type BunProvisionOptions = {
  /** Base URL holding `bun-v<version>/bun-<platform>.zip` (https: or file:). */
  mirror: string;
  /** PATH used to find `unzip`. */
  searchPath: string;
  /** Overrides the detected platform (tests). */
  platform?: BunPlatform | null;
};

/**
 * Ensures `<runtimeDir>/bun/bin/bun` is the pinned Bun: downloads the release
 * zip, verifies the pinned sha256 before `unzip` sees it, and installs the
 * binary. Returns the binary path.
 */
export async function provisionPrivateBun(
  runtimeDirectory: string,
  pins: RuntimePins,
  options: BunProvisionOptions,
): Promise<string> {
  const bunDirectory = path.join(runtimeDirectory, "bun");
  const binary = path.join(bunDirectory, PRIVATE_BUN_ENTRY);
  await mkdir(runtimeDirectory, { recursive: true });
  if (
    (await isExecutable(binary)) &&
    (await probeBun(binary, runtimeDirectory))?.version === pins.bunVersion
  )
    return binary;
  const platform = options.platform === undefined ? await currentBunPlatform() : options.platform;
  if (platform === null) {
    throw new Error(
      `no pinned Bun build for ${process.platform} ${process.arch} (glibc Linux and macOS only); install Bun ${pins.bunMinimumVersion}+ yourself or keep runtime node`,
    );
  }
  const expected = pins.bunSha256.get(platform);
  if (expected === undefined) throw new Error(`missing runtime pin: bun_sha256_${platform}`);
  const unzip = await findOnPath("unzip", options.searchPath);
  if (unzip === null) throw new Error(UNZIP_GUIDANCE);
  const base = options.mirror.replace(/\/+$/, "");
  const url = `${base}/bun-v${pins.bunVersion}/bun-${platform}.zip`;
  const id = randomUUID();
  const archive = path.join(runtimeDirectory, `.bun-${pins.bunVersion}-${id}.zip`);
  const unpacked = path.join(runtimeDirectory, `.bun-unpacked-${id}`);
  const staged = path.join(runtimeDirectory, `.bun-staged-${id}`);
  try {
    await download(url, archive);
    await extractVerifiedArchive(archive, sha256Expected(expected), unpacked, {
      kind: "zip",
      unzip,
    });
    await mkdir(path.join(staged, "bin"), { recursive: true });
    await rename(path.join(unpacked, "bun"), path.join(staged, PRIVATE_BUN_ENTRY));
    await chmod(path.join(staged, PRIVATE_BUN_ENTRY), 0o755);
    await rm(bunDirectory, { recursive: true, force: true });
    await rename(staged, bunDirectory);
  } finally {
    await rm(archive, { force: true });
    await rm(unpacked, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
  const installed = await probeBun(binary, runtimeDirectory);
  if (installed?.version !== pins.bunVersion) {
    throw new Error(
      `${url} did not install a working Bun ${pins.bunVersion} (got ${installed?.version ?? "nothing runnable"})`,
    );
  }
  return binary;
}

/**
 * Ensures `<runtimeDir>/pnpm` holds the pinned pnpm, downloading the registry
 * tarball and verifying its sha512 integrity before extraction when needed.
 */
export async function provisionPrivatePnpm(
  runtimeDirectory: string,
  pins: RuntimePins,
  registry: string,
): Promise<string> {
  const pnpmDirectory = path.join(runtimeDirectory, "pnpm");
  const entry = path.join(pnpmDirectory, PRIVATE_PNPM_ENTRY);
  if (
    (await privatePnpmVersion(pnpmDirectory)) === pins.pnpmVersion &&
    (await isExecutable(entry))
  ) {
    return entry;
  }
  const base = registry.replace(/\/+$/, "");
  const url = `${base}/pnpm/-/pnpm-${pins.pnpmVersion}.tgz`;
  const archive = path.join(runtimeDirectory, `.pnpm-${pins.pnpmVersion}-${randomUUID()}.tgz`);
  try {
    await download(url, archive);
    await extractVerifiedArchive(archive, parseIntegrity(pins.pnpmIntegrity), pnpmDirectory);
  } finally {
    await rm(archive, { force: true });
  }
  if ((await privatePnpmVersion(pnpmDirectory)) !== pins.pnpmVersion) {
    throw new Error(`${url} did not contain pnpm ${pins.pnpmVersion}`);
  }
  return entry;
}
