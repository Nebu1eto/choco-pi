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

export type RuntimePins = {
  nodeVersion: string;
  nodeSha256: ReadonlyMap<NodePlatform, string>;
  pnpmVersion: string;
  pnpmIntegrity: string;
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
  return { nodeVersion, nodeSha256, pnpmVersion, pnpmIntegrity };
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

/**
 * Verifies `archive`, then extracts its single top-level directory to
 * `destination` (replacing it). Extraction happens in a sibling staging
 * directory so a failed extraction leaves the previous destination intact.
 */
export async function extractVerifiedArchive(
  archive: string,
  expected: ExpectedDigest,
  destination: string,
): Promise<void> {
  await verifyArchive(archive, expected);
  const staging = `${destination}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await runFile("tar", ["-xzf", archive, "-C", staging], { maxBuffer: 1024 * 1024 });
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
