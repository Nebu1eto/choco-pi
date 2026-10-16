#!/usr/bin/env node

import { spawn, execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { parseArgs, promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";
import { helperSourceHash, helperSourcePaths } from "../src/platform/macos/helper-source.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperAppPath = resolveMacosHelperAppPath();
const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
const helperBundleId = "com.injaneity.pi-computer-use";
const packageJsonPath = path.join(rootDir, "package.json");
const localCodeSignCommonName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const localSigningLockPath = path.join(
  os.tmpdir(),
  `pi-computer-use-local-signing-${process.getuid !== undefined ? process.getuid() : "user"}.lock`,
);

// --runtime marks the call from src/platform/macos/helper.ts; it changes nothing.
// --arch overrides the host architecture (cross-compilation is untested).
// --build-only --out <dir> compiles <dir>/bridge and installs nothing.
function parseOptions(argv) {
  return parseArgs({
    args: argv,
    options: {
      runtime: { type: "boolean" },
      "allow-adhoc-update": { type: "boolean" },
      arch: { type: "string" },
      "build-only": { type: "boolean" },
      out: { type: "string" },
    },
    strict: true,
  }).values;
}
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

async function helperInfoPlist() {
  const version = await packageVersion();
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

const infoPlistPath = path.join(helperAppPath, "Contents", "Info.plist");

/**
 * Short-circuit before compiling: an installed helper whose source hash and
 * Info.plist match is current. It is only re-signed when a real identity can
 * replace an older ad-hoc signature. Returns undefined when a build is needed.
 */
async function refreshCurrentHelperApp(sourceHash, infoPlist) {
  const existingSourceHash = await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined);
  const existingInfoPlist = await fs.readFile(infoPlistPath, "utf8").catch(() => undefined);
  if (existingSourceHash?.trim() !== sourceHash || existingInfoPlist !== infoPlist)
    return undefined;
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

async function assertReplaceAllowed(allowAdhocUpdate) {
  const signingIdentity =
    process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
  if (signingIdentity === "-" && (await exists(helperSourceHashPath)) && !allowAdhocUpdate) {
    throw new Error(
      "Refusing to replace an installed helper with an ad-hoc signed rebuild because macOS may reset Accessibility/Screen Recording grants. Install a Developer ID identity, set PI_COMPUTER_USE_CODESIGN_IDENTITY, or set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 for local development.",
    );
  }
}

async function installHelperApp(sourcePath, sourceHash, infoPlist) {
  await fs.mkdir(path.dirname(helperAppExecutablePath), { recursive: true });
  await fs.mkdir(path.dirname(helperSourceHashPath), { recursive: true });
  await fs.copyFile(sourcePath, helperAppExecutablePath);
  await fs.chmod(helperAppExecutablePath, 0o755);
  await fs.writeFile(infoPlistPath, infoPlist);
  await fs.writeFile(helperSourceHashPath, `${sourceHash}\n`);
  await signHelper(helperAppPath, helperBundleId);
  await registerHelperApp();
}

async function assertSwiftcAvailable() {
  const swiftcPath = await commandOutput("xcrun", ["--find", "swiftc"]).catch(() => "");
  if (!swiftcPath.trim()) {
    throw new Error(
      "Building the pi-computer-use helper requires `xcrun swiftc`, which was not found. Install the Xcode Command Line Tools with `xcode-select --install` (or Xcode), then run this script again.",
    );
  }
}

/**
 * Compile the helper into `outputPath` with a module cache under
 * `scratchDir`. Compiler warnings are printed and do not fail the build.
 * The loose binary is not signed here; the installed app bundle is.
 */
async function buildHelper(arch, outputPath, scratchDir) {
  const sourcePaths = helperSourcePaths(rootDir);
  for (const sourcePath of sourcePaths) {
    if (!(await exists(sourcePath)))
      throw new Error(`Native helper source not found at ${sourcePath}`);
  }
  await assertSwiftcAvailable();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const swiftArgs = [
    "swiftc",
    "-target",
    `${archTriples[arch]}${deploymentTarget}`,
    "-module-cache-path",
    path.join(scratchDir, "module-cache"),
    "-O",
  ];
  for (const framework of frameworks) swiftArgs.push("-framework", framework);
  swiftArgs.push(...sourcePaths, "-o", outputPath);

  const startedAt = Date.now();
  console.log(`[pi-computer-use] compiling helper (${arch}) with xcrun swiftc...`);
  await run("xcrun", swiftArgs);
  await fs.chmod(outputPath, 0o755);
  console.log(
    `[pi-computer-use] compiled ${outputPath} in ${Math.round((Date.now() - startedAt) / 1000)} s`,
  );
}

async function setup() {
  if (process.platform !== "darwin") {
    throw new Error("This choco-pi fork supports helper installation on macOS only.");
  }

  const options = parseOptions(process.argv.slice(2));
  const arch = normalizeArch(options.arch ?? process.arch);
  if (options.arch !== undefined && arch !== normalizeArch(process.arch)) {
    console.warn(
      `[pi-computer-use] warning: cross-compiling the helper for ${arch} on ${process.arch} is untested.`,
    );
  }

  if (options["build-only"] === true) {
    if (options.out === undefined) throw new Error("--build-only requires --out <dir>.");
    const outDir = path.resolve(options.out);
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-build-"));
    try {
      await buildHelper(arch, path.join(outDir, "bridge"), scratchDir);
    } finally {
      await fs.rm(scratchDir, { force: true, recursive: true }).catch(() => {});
    }
    console.log(
      `[pi-computer-use] built ${path.join(outDir, "bridge")} (source.sha256 ${await helperSourceHash(arch, rootDir)}); nothing installed`,
    );
    return;
  }
  if (options.out !== undefined) throw new Error("--out is only valid with --build-only.");

  await ensureHelperParentDirectory();
  const sourceHash = await helperSourceHash(arch, rootDir);
  const infoPlist = await helperInfoPlist();
  const refreshed = await refreshCurrentHelperApp(sourceHash, infoPlist);
  if (refreshed !== undefined) {
    console.log(
      refreshed
        ? `[pi-computer-use] re-signed current helper app (${arch}) at ${helperAppPath}`
        : `[pi-computer-use] helper app (${arch}) already current at ${helperAppPath}`,
    );
    return;
  }
  await assertReplaceAllowed(
    options["allow-adhoc-update"] === true ||
      process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1",
  );

  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-build-"));
  try {
    const builtPath = path.join(scratchDir, "bridge");
    await buildHelper(arch, builtPath, scratchDir);
    await installHelperApp(builtPath, sourceHash, infoPlist);
  } finally {
    await fs.rm(scratchDir, { force: true, recursive: true }).catch(() => {});
  }
  console.log(`[pi-computer-use] built and installed helper app (${arch}) at ${helperAppPath}`);
}

const isMain =
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain)
  setup().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
