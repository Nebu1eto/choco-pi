#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperAppPath = resolveMacosHelperAppPath();
const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
const helperBundleId = "com.injaneity.pi-computer-use";
const helperSourcePaths = ["agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"].map(
  (file) => path.join(rootDir, "native", "macos", file),
);
const packageJsonPath = path.join(rootDir, "package.json");
const localCodeSignCommonName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const localSigningLockPath = path.join(
  os.tmpdir(),
  `pi-computer-use-local-signing-${process.getuid !== undefined ? process.getuid() : "user"}.lock`,
);

const args = new Set(process.argv.slice(2));
const allowBuildFallback =
  args.has("--allow-build") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowAdhocUpdate =
  args.has("--allow-adhoc-update") || process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1";
const archTriples = {
  arm64: "arm64-apple-macosx",
  x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

function normalizeArch(arch) {
  if (arch === "arm64" || arch === "x64") return arch;
  throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

function prebuiltPathForArch(arch) {
  return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
}

function prebuiltAppPathForArch(arch) {
  return path.join(rootDir, "prebuilt", "macos", arch, "pi-computer-use.app");
}

function isPrimitiveString(value) {
  return (
    value !== null && value !== undefined && Object(value) !== value && value.constructor === String
  );
}

async function packageVersion() {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  if (!isPrimitiveString(packageJson.version) || packageJson.version.length === 0) {
    throw new Error(`Could not read package version from ${packageJsonPath}.`);
  }
  return packageJson.version;
}

async function exists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command, commandArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
    });
  });
}

function moduleCachePath(arch) {
  return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}`);
}

async function commandOutput(command, commandArgs) {
  const { stdout } = await execFile(command, commandArgs, { encoding: "utf8" });
  return stdout;
}

async function findDeveloperIdIdentity() {
  const output = await commandOutput("security", [
    "find-identity",
    "-p",
    "codesigning",
    "-v",
  ]).catch(() => "");
  const line = output.split("\n").find((item) => item.includes("Developer ID Application"));
  return line?.trim().split(/\s+/)[1];
}

export function parseCodeSigningIdentities(output, commonName = localCodeSignCommonName) {
  return output
    .split("\n")
    .map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/i))
    .filter((match) => match?.[2] === commonName)
    .map((match) => match[1].toUpperCase());
}

async function findLocalSigningIdentity() {
  // Self-signed local identities appear as CSSMERR_TP_NOT_TRUSTED and are
  // omitted by `-v`, but remain valid inputs to codesign. Match the identity
  // list directly and return its fingerprint rather than its display name.
  const output = await commandOutput("security", ["find-identity", "-p", "codesigning"]).catch(
    () => "",
  );
  return parseCodeSigningIdentities(output)[0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDirectoryLock(
  lockPath,
  callback,
  { waitMs = 15_000, staleMs = 300_000, retryMs = 50 } = {},
) {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for local signing identity lock at ${lockPath}.`);
      await delay(retryMs);
    }
  }
  try {
    return await callback();
  } finally {
    await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function ensureIdentityOnce(findIdentity, createIdentity, withLock) {
  return (
    (await findIdentity()) ??
    (await withLock(async () => (await findIdentity()) ?? (await createIdentity())))
  );
}

async function loginKeychainPath() {
  for (const candidate of [
    path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    path.join(os.homedir(), "Library", "Keychains", "login.keychain"),
  ]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function ensureLocalSigningIdentity() {
  if (process.platform !== "darwin") return undefined;
  if (!(await commandOutput("which", ["codesign"]).catch(() => ""))) return undefined;
  const existingIdentity = await findLocalSigningIdentity();
  if (existingIdentity) return existingIdentity;
  if (!(await commandOutput("which", ["openssl"]).catch(() => ""))) return undefined;
  const keychain = await loginKeychainPath();
  if (!keychain) return undefined;

  return await ensureIdentityOnce(
    findLocalSigningIdentity,
    createLocalSigningIdentity,
    (callback) => withDirectoryLock(localSigningLockPath, callback),
  );
}

async function createLocalSigningIdentity() {
  const keychain = await loginKeychainPath();
  if (!keychain) return undefined;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-"));
  const password = `pi-computer-use-local-${process.pid}-${Date.now()}`;
  try {
    const configPath = path.join(tempDir, "req.cnf");
    await fs.writeFile(
      configPath,
      [
        "[req]",
        "distinguished_name=dn",
        "x509_extensions=ext",
        "prompt=no",
        "[dn]",
        `CN=${localCodeSignCommonName}`,
        "[ext]",
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=critical,codeSigning",
        "",
      ].join("\n"),
    );
    const keyPath = path.join(tempDir, "key.pem");
    const certPath = path.join(tempDir, "cert.pem");
    const p12Path = path.join(tempDir, "id.p12");
    await execFile("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-nodes",
      "-config",
      configPath,
    ]);
    await execFile("openssl", [
      "pkcs12",
      "-export",
      "-legacy",
      "-inkey",
      keyPath,
      "-in",
      certPath,
      "-out",
      p12Path,
      "-passout",
      `pass:${password}`,
      "-name",
      localCodeSignCommonName,
    ]).catch(async () => {
      await execFile("openssl", [
        "pkcs12",
        "-export",
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-out",
        p12Path,
        "-passout",
        `pass:${password}`,
        "-name",
        localCodeSignCommonName,
      ]);
    });
    await execFile("security", [
      "import",
      p12Path,
      "-k",
      keychain,
      "-P",
      password,
      "-A",
      "-T",
      "/usr/bin/codesign",
    ]);
    const identity = await findLocalSigningIdentity();
    if (!identity)
      throw new Error("Imported local signing certificate is not a valid code-signing identity.");
    return identity;
  } catch (error) {
    console.warn(
      `[pi-computer-use] could not create a valid local signing identity: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
  }
}

async function resolveCodeSignIdentity() {
  if (process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY)
    return process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY;
  return (await findDeveloperIdIdentity()) ?? (await ensureLocalSigningIdentity()) ?? "-";
}

async function signHelper(outputPath, identifier = defaultCodeSignIdentifier) {
  if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
    return "unsigned";
  }

  const identity = await resolveCodeSignIdentity();
  const commandArgs = [
    "--force",
    "--deep",
    "-i",
    identifier,
    "--timestamp=none",
    "--sign",
    identity,
    outputPath,
  ];
  await run("codesign", commandArgs);
  if (identity === "-") {
    console.warn(
      "[pi-computer-use] warning: signed helper ad-hoc; macOS may require permission review after native helper changes. Release installs should use a Developer ID-signed helper app.",
    );
  } else if (identity === (await findLocalSigningIdentity())) {
    console.log(
      `[pi-computer-use] signed ${outputPath} with local identity '${localCodeSignCommonName}'. macOS may still require permission review after local rebuilds.`,
    );
  }
  return identity;
}

async function helperHasAdhocSignature() {
  const output = await execFile("codesign", ["-dv", "--verbose=4", helperAppPath], {
    encoding: "utf8",
  }).then(
    (result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    (error) => `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
  );
  return /Signature=adhoc/i.test(output);
}

async function registerHelperApp() {
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (!(await exists(lsregister))) return;
  await run(lsregister, ["-f", helperAppPath]).catch(() => {});
}

async function ensureHelperParentDirectory() {
  const parentPath = path.dirname(helperAppPath);
  await fs.mkdir(parentPath, { recursive: true });
  await fs.access(parentPath, fsConstants.W_OK);
}

async function installPrebuiltHelperApp(sourceAppPath) {
  await ensureHelperParentDirectory();
  const sourceExecutablePath = path.join(sourceAppPath, "Contents", "MacOS", "bridge");
  const sourceInfoPath = path.join(sourceAppPath, "Contents", "Info.plist");
  const existingExecutable = await fs.readFile(helperAppExecutablePath).catch(() => undefined);
  const sourceExecutable = await fs.readFile(sourceExecutablePath);
  const existingInfo = await fs
    .readFile(path.join(helperAppPath, "Contents", "Info.plist"), "utf8")
    .catch(() => undefined);
  const sourceInfo = await fs.readFile(sourceInfoPath, "utf8");
  if (existingExecutable?.equals(sourceExecutable) && existingInfo === sourceInfo) {
    await registerHelperApp();
    return false;
  }
  // The sealed bundle must arrive intact — a broken signature would burn
  // the user's TCC grants on an identity that can never validate.
  await run("codesign", ["--verify", "--strict", sourceAppPath]);
  await fs.rm(helperAppPath, { force: true, recursive: true });
  // ditto preserves the bundle byte-for-byte (signature + stapled
  // notarization ticket). The sealed app is NEVER re-signed here: its
  // Developer ID designated requirement (identifier + team) is exactly
  // what gives release builds their best chance of retaining TCC grants.
  await run("/usr/bin/ditto", [sourceAppPath, helperAppPath]);
  await registerHelperApp();
  return true;
}

async function installHelperApp(sourcePath) {
  await ensureHelperParentDirectory();
  const version = await packageVersion();
  const infoPlistPath = path.join(helperAppPath, "Contents", "Info.plist");
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>pi-computer-use</string>
<key>CFBundleDisplayName</key><string>pi-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`;

  const sourceExecutable = await fs.readFile(sourcePath);
  const sourceHash = createHash("sha256").update(sourceExecutable).digest("hex");
  const existingSourceHash = await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined);
  const existingInfoPlist = await fs.readFile(infoPlistPath, "utf8").catch(() => undefined);
  if (existingSourceHash?.trim() === sourceHash && existingInfoPlist === infoPlist) {
    // If a real signing identity is available, upgrade older ad-hoc installs
    // in place so local builds have a consistent identity. macOS may still
    // require permission review after native code changes.
    const signingIdentity =
      process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
    if (signingIdentity !== "-" && (await helperHasAdhocSignature())) {
      await signHelper(helperAppPath, helperBundleId);
      await registerHelperApp();
      return true;
    }
    await registerHelperApp();
    return false;
  }

  const signingIdentity =
    process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
  if (signingIdentity === "-" && existingSourceHash !== undefined && !allowAdhocUpdate) {
    throw new Error(
      "Refusing to replace an installed helper with an ad-hoc signed rebuild because macOS may reset Accessibility/Screen Recording grants. Use a pre-signed helper app, install a Developer ID identity, or set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 for local development.",
    );
  }

  await fs.mkdir(path.dirname(helperAppExecutablePath), { recursive: true });
  await fs.mkdir(path.dirname(helperSourceHashPath), { recursive: true });
  await fs.copyFile(sourcePath, helperAppExecutablePath);
  await fs.chmod(helperAppExecutablePath, 0o755);
  await fs.writeFile(infoPlistPath, infoPlist);
  await fs.writeFile(helperSourceHashPath, `${sourceHash}\n`);
  await signHelper(helperAppPath, helperBundleId);
  await registerHelperApp();
  return true;
}

async function buildHelper(arch, outputPath) {
  for (const sourcePath of helperSourcePaths) {
    if (!(await exists(sourcePath)))
      throw new Error(`Native helper source not found at ${sourcePath}`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const swiftArgs = [
    "swiftc",
    "-target",
    `${archTriples[arch]}${deploymentTarget}`,
    "-module-cache-path",
    moduleCachePath(arch),
    "-O",
  ];
  for (const framework of frameworks) swiftArgs.push("-framework", framework);
  swiftArgs.push(...helperSourcePaths, "-o", outputPath);

  await run("xcrun", swiftArgs);
  await fs.chmod(outputPath, 0o755);
  await signHelper(outputPath);
}

async function setup() {
  if (process.platform !== "darwin") {
    throw new Error("This choco-pi fork supports helper installation on macOS only.");
  }

  const arch = normalizeArch(process.arch);
  // Prefer a pre-signed universal bundle over a per-arch bundle, then fall
  // back to wrapping the committed loose binary.
  const universalAppPath = prebuiltAppPathForArch("universal");
  const prebuiltAppPath = (await exists(universalAppPath))
    ? universalAppPath
    : prebuiltAppPathForArch(arch);
  const prebuiltPath = prebuiltPathForArch(arch);
  const prebuiltAppExists = await exists(prebuiltAppPath);
  const prebuiltExists = await exists(prebuiltPath);

  if (prebuiltAppExists) {
    const installed = await installPrebuiltHelperApp(prebuiltAppPath);
    console.log(
      installed
        ? `[pi-computer-use] installed pre-signed helper app (${arch}) at ${helperAppPath}`
        : `[pi-computer-use] pre-signed helper app (${arch}) already current at ${helperAppPath}`,
    );
    return;
  }

  if (prebuiltExists) {
    const installed = await installHelperApp(prebuiltPath);
    console.log(
      installed
        ? `[pi-computer-use] installed helper app (${arch}) at ${helperAppPath}`
        : `[pi-computer-use] helper app (${arch}) already current at ${helperAppPath}`,
    );
    return;
  }

  if (allowBuildFallback) {
    const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${process.pid}-${Date.now()}`);
    try {
      console.log(
        "[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...",
      );
      await buildHelper(arch, tempPath);
      const installed = await installHelperApp(tempPath);
      console.log(
        installed
          ? `[pi-computer-use] built helper app at ${helperAppPath}`
          : `[pi-computer-use] built helper app; installed app already current at ${helperAppPath}`,
      );
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    return;
  }

  throw new Error(
    `No prebuilt helper found for ${arch} at ${prebuiltPath}. Set PI_COMPUTER_USE_ALLOW_BUILD=1 to build from the committed Swift sources.`,
  );
}

const isMain =
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain)
  setup().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
