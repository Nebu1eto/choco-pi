import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PI_CLI_RELATIVE } from "../scripts/standalone/contract.ts";
import { pruneOrphanedPackageDirs } from "../scripts/standalone/bootstrap.ts";
import {
  manifestProblems,
  parseInstallManifest,
  type InstallManifest,
} from "../scripts/standalone/install-manifest.ts";
import { linkLauncher } from "../scripts/standalone/cli.ts";
import { isOurLink } from "../scripts/standalone/uninstall.ts";
import {
  PROVENANCE_NAME,
  provenanceEntryProblem,
  readProvenance,
  resolveOwnedEntry,
} from "../scripts/standalone/provenance.ts";
import {
  BUN_PLATFORMS,
  ChecksumMismatchError,
  currentBunPlatform,
  currentPnpmPlatform,
  extractVerifiedArchive,
  findSystemPnpm,
  INSTALLER_PROTOCOL,
  parseIntegrity,
  parseRuntimePins,
  PNPM_PLATFORMS,
  pnpmTarballUrl,
  pnpmVersionQualifies,
  provisionPrivateBun,
  provisionPrivatePnpm,
  readRuntimePins,
  readPin,
  sha256Expected,
  UNZIP_GUIDANCE,
  type PnpmPlatform,
  type RuntimePins,
} from "../scripts/standalone/provision.ts";
import { readSettingsSeed } from "../scripts/standalone/settings-seed.ts";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SH = path.join(ROOT, "install.sh");
const NODE_DIR = path.dirname(process.execPath);
const GIT_IDENTITY = [
  "-c",
  "user.name=fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

type Failure = Error & { code?: number; stdout?: string; stderr?: string };

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "choco-pi-installer-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

async function sha(file: string, algorithm: "sha256" | "sha512"): Promise<Buffer> {
  return createHash(algorithm)
    .update(await readFile(file))
    .digest();
}

async function fixtureTarball(
  directory: string,
  top: string,
  files: ReadonlyMap<string, string>,
  archive: string,
): Promise<void> {
  const staging = await mkdtemp(path.join(directory, "pack-"));
  for (const [relative, contents] of files) {
    const target = path.join(staging, top, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    if (relative.startsWith("bin/")) await chmod(target, 0o755);
  }
  await mkdir(path.dirname(archive), { recursive: true });
  await runFile("tar", ["-czf", archive, "-C", staging, top]);
  await rm(staging, { recursive: true, force: true });
}

const ZERO_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;

const FIXTURE_PNPM = "12.21.0";

function pinsText(
  nodeVersion: string,
  nodeSha256: string,
  pnpmIntegrity: string,
  bunSha256 = "0".repeat(64),
): string {
  const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
  return [
    `node_version ${nodeVersion}`,
    ...platforms.map((platform) => `node_sha256_${platform} ${nodeSha256}`),
    `pnpm_version ${FIXTURE_PNPM}`,
    ...PNPM_PLATFORMS.map((platform) => `pnpm_integrity_${platform} ${pnpmIntegrity}`),
    "bun_version 1.4.4",
    "bun_minimum_version 1.4.4",
    ...BUN_PLATFORMS.map((platform) => `bun_sha256_${platform} ${bunSha256}`),
    "",
  ].join("\n");
}

function pnpmPins(integrities: Partial<Record<PnpmPlatform, string>>): RuntimePins {
  let text = pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY);
  for (const platform of PNPM_PLATFORMS) {
    const integrity = integrities[platform];
    if (integrity === undefined) continue;
    text = text.replace(
      new RegExp(`^pnpm_integrity_${platform} .*$`, "m"),
      `pnpm_integrity_${platform} ${integrity}`,
    );
  }
  return parseRuntimePins(text);
}

test("the shipped pins parse and match package.json's pnpm", async () => {
  const pins = await readRuntimePins();
  assert.match(pins.nodeVersion, /^24\.\d+\.\d+$/);
  assert.equal(pins.nodeSha256.size, 4);
  const manifest: unknown = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const declared =
    manifest instanceof Object && "packageManager" in manifest ? manifest.packageManager : null;
  assert.equal(declared, `pnpm@${pins.pnpmVersion}`);
  assert.match(pins.pnpmVersion, /^12\.\d+\.\d+$/, "pnpm 12: the native-binary layout");
  assert.deepEqual([...pins.pnpmIntegrity.keys()].toSorted(), [...PNPM_PLATFORMS].toSorted());
  assert.match(pins.bunVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...pins.bunSha256.keys()].toSorted(), [...BUN_PLATFORMS].toSorted());
  assert.throws(() => parseRuntimePins("node_version 22.1.0\n"), /24\.x\.y/);
  assert.throws(
    () => parseRuntimePins(pinsText("24.0.0", "0".repeat(64), "sha1-abc")),
    /unsupported integrity/,
  );
  const valid = pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY);
  assert.throws(
    () => parseRuntimePins(valid.replace(/^bun_sha256_linux-aarch64 .*$/m, "")),
    /missing runtime pin: bun_sha256_linux-aarch64/,
  );
  assert.throws(
    () => parseRuntimePins(valid.replace("bun_minimum_version 1.4.4", "bun_minimum_version 1.5.0")),
    /older than bun_minimum_version/,
  );
  assert.equal(parseRuntimePins(valid).installerProtocol, 1, "an absent key means protocol 1");
  assert.equal(parseRuntimePins(`installer_protocol 7\n${valid}`).installerProtocol, 7);
  assert.throws(() => parseRuntimePins(`installer_protocol 02\n${valid}`), /installer_protocol/);
  assert.equal(pins.installerProtocol, INSTALLER_PROTOCOL, "the app declares what stage 1 speaks");
  const script = await readFile(INSTALL_SH, "utf8");
  assert.match(script, new RegExp(`^SUPPORTED_INSTALLER_PROTOCOL=${INSTALLER_PROTOCOL}$`, "m"));
});

test("pnpm pins name one integrity per platform; the old single pin is not enough", async () => {
  const valid = pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY);
  const parsed = parseRuntimePins(valid);
  assert.equal(parsed.pnpmVersion, FIXTURE_PNPM);
  assert.equal(parsed.pnpmIntegrity.size, PNPM_PLATFORMS.length);
  assert.throws(
    () => parseRuntimePins(valid.replace(/^pnpm_integrity_linux-arm64 .*$/m, "")),
    /missing runtime pin: pnpm_integrity_linux-arm64/,
  );
  const legacy = valid
    .split("\n")
    .filter((line) => !line.startsWith("pnpm_integrity_"))
    .concat(`pnpm_integrity ${ZERO_INTEGRITY}`)
    .join("\n");
  assert.throws(() => parseRuntimePins(legacy), /missing runtime pin: pnpm_integrity_darwin-arm64/);
  assert.throws(
    () => parseRuntimePins(`${valid}pnpm_integrity_linux-x64-musl ${ZERO_INTEGRITY}\n`),
    /unsupported pnpm platform pin: pnpm_integrity_linux-x64-musl/,
  );
  assert.throws(
    () => parseRuntimePins(valid.replace(/^(pnpm_integrity_darwin-x64) .*$/m, "$1 sha1-abc")),
    /unsupported integrity/,
  );
});

test("readPin reads one pin from pins of a format this revision does not know", () => {
  const future = [
    "# comment installer_protocol 9",
    "installer_protocol 4",
    "node_version 26.1.0",
    "free_text line with many words",
    "installer_protocol 5",
    "",
  ].join("\n");
  assert.throws(() => parseRuntimePins(future), /malformed runtime pin line/);
  assert.equal(readPin(future, "installer_protocol"), "4", "the first line naming the key wins");
  assert.equal(readPin(future, "free_text"), "line");
  assert.equal(readPin(future, "bun_version"), null);
  assert.equal(
    readPin("installer_protocol\n", "installer_protocol"),
    null,
    "a key without a value",
  );
});

test("a checksum mismatch aborts before extraction; a match extracts", async (t) => {
  const directory = await scratch(t);
  const archive = path.join(directory, "fixture.tar.gz");
  await fixtureTarball(directory, "pkg", new Map([["bin/tool", "#!/bin/sh\necho ok\n"]]), archive);
  const destination = path.join(directory, "runtime", "tool");
  await mkdir(path.dirname(destination), { recursive: true });
  const wrong = sha256Expected("0".repeat(64));
  await assert.rejects(extractVerifiedArchive(archive, wrong, destination), ChecksumMismatchError);
  assert.deepEqual(
    await readdir(path.dirname(destination)),
    [],
    "nothing extracted, no staging left",
  );
  await extractVerifiedArchive(
    archive,
    { algorithm: "sha256", digest: await sha(archive, "sha256") },
    destination,
  );
  assert.equal(
    await readFile(path.join(destination, "bin", "tool"), "utf8"),
    "#!/bin/sh\necho ok\n",
  );
  assert.deepEqual(await readdir(path.dirname(destination)), ["tool"]);
});

function nodePlatform(): string | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (arch === null || (process.platform !== "darwin" && process.platform !== "linux")) return null;
  return `${process.platform}-${arch}`;
}

async function onPath(command: string, searchPath: string): Promise<boolean> {
  return runFile("/bin/sh", ["-c", `command -v ${command}`], { env: { PATH: searchPath } }).then(
    () => true,
    () => false,
  );
}

async function pinsOnlySource(directory: string, pins: string): Promise<string> {
  const source = path.join(directory, "source");
  await mkdir(path.join(source, "scripts", "standalone"), { recursive: true });
  await writeFile(path.join(source, "scripts", "standalone", "runtime-pins.txt"), pins);
  await runFile("git", ["init", "--quiet", "--initial-branch=main", source]);
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", "fixture"]);
  return source;
}

test("install.sh verifies the Node tarball before extracting it", async (t) => {
  const platform = nodePlatform();
  const basePath = "/usr/bin:/bin";
  if (platform === null || (await onPath("node", basePath)) || !(await onPath("git", basePath))) {
    t.skip("needs darwin/linux with git but no node in /usr/bin:/bin");
    return;
  }
  const directory = await scratch(t);
  const mirror = path.join(directory, "mirror");
  const name = `node-v24.0.0-${platform}`;
  const archive = path.join(mirror, "v24.0.0", `${name}.tar.gz`);
  const stubNode = [
    "#!/bin/sh",
    'case "$1" in',
    '  -e) case "$2" in *execPath*) printf %s "$0" ;; *) printf 24 ;; esac ;;',
    "  --version) echo v24.0.0 ;;",
    '  *) echo "STAGE1 $*" ;;',
    "esac",
    "",
  ].join("\n");
  await fixtureTarball(directory, name, new Map([["bin/node", stubNode]]), archive);
  const environment = {
    HOME: path.join(directory, "user-home"),
    PATH: basePath,
    CHOCO_PI_NODE_MIRROR: pathToFileURL(mirror).href,
  };
  const run = async (pins: string, label: string) => {
    const home = path.join(directory, `home-${label}`);
    const source = await pinsOnlySource(
      path.join(directory, label),
      `installer_protocol ${INSTALLER_PROTOCOL}\n${pins}`,
    );
    const args = [
      INSTALL_SH,
      "--home",
      home,
      "--bin-dir",
      path.join(directory, "bin"),
      "--source",
      source,
    ];
    const result = await runFile("/bin/sh", args, { env: environment }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error: Failure) => ({
        code: error.code ?? -1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );
    return { ...result, home };
  };
  const mismatch = await run(pinsText("24.0.0", "f".repeat(64), ZERO_INTEGRITY), "mismatch");
  assert.equal(mismatch.code, 1, mismatch.output);
  assert.match(mismatch.output, /checksum mismatch .* nothing was extracted/);
  assert.deepEqual(
    await readdir(path.join(mismatch.home, "runtime")),
    [],
    "no node, staging or archive left",
  );

  const digest = (await sha(archive, "sha256")).toString("hex");
  const match = await run(pinsText("24.0.0", digest, ZERO_INTEGRITY), "match");
  assert.equal(match.code, 0, match.output);
  assert.match(
    match.output,
    new RegExp(
      `STAGE1 ${path.join(match.home, "app", "scripts", "standalone", "manage.ts").replaceAll(".", "\\.")} install --home `,
    ),
  );
  assert.deepEqual(await readdir(path.join(match.home, "runtime")), ["node"]);
});

test("install.sh without git prints guidance and never elevates", async (t) => {
  const directory = await scratch(t);
  const tools = path.join(directory, "tools");
  await mkdir(tools);
  for (const tool of ["uname", "sed", "tr"]) {
    const found = await runFile("/bin/sh", ["-c", `command -v ${tool}`], {
      env: { PATH: "/usr/bin:/bin" },
    });
    await symlink(found.stdout.trim(), path.join(tools, tool));
  }
  const failure = await runFile("/bin/sh", [INSTALL_SH, "--home", path.join(directory, "home")], {
    env: { HOME: directory, PATH: tools },
  }).then(
    () => null,
    (error: Failure) => error,
  );
  assert.ok(failure !== null);
  assert.equal(failure.code, 1);
  assert.match(String(failure.stderr), /git is required/);
  assert.doesNotMatch(`${failure.stdout ?? ""}${failure.stderr ?? ""}`, /\bsudo\b/);
  assert.equal(await exists(path.join(directory, "home")), false);
});

test("pnpm qualifies only at exactly the pinned version", async (t) => {
  assert.equal(pnpmVersionQualifies("11.11.0\n", "11.11.0"), true);
  for (const other of ["11.11.1", "11.11.0-rc.1", "v11.11.0", "11.11", ""]) {
    assert.equal(pnpmVersionQualifies(other, "11.11.0"), false, other);
  }
  const directory = await scratch(t);
  const stub = async (name: string, version: string) => {
    const dir = path.join(directory, name);
    await mkdir(dir);
    await writeFile(path.join(dir, "pnpm"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    return dir;
  };
  const newer = await stub("newer", "11.11.1");
  const exact = await stub("exact", "11.11.0");
  const prerelease = await stub("pre", "11.11.0-rc.1");
  assert.equal(
    await findSystemPnpm([newer, exact].join(path.delimiter), "11.11.0", directory),
    path.join(exact, "pnpm"),
  );
  assert.equal(
    await findSystemPnpm([newer, prerelease].join(path.delimiter), "11.11.0", directory),
    null,
  );
  const guarded = path.join(directory, "guarded");
  await mkdir(guarded);
  await writeFile(
    path.join(guarded, "pnpm"),
    '#!/bin/sh\nif [ "$pnpm_config_pm_on_fail" = ignore ]; then echo 11.11.0; else echo 99.0.0; fi\n',
    { mode: 0o755 },
  );
  assert.equal(await findSystemPnpm(guarded, "11.11.0", directory), path.join(guarded, "pnpm"));
});

async function fixturePnpmExe(
  directory: string,
  registry: string,
  platform: PnpmPlatform,
  version: string,
  script: string,
): Promise<string> {
  const archive = fileURLToPath(pnpmTarballUrl(pathToFileURL(registry).href, platform, version));
  await fixtureTarball(
    directory,
    "package",
    new Map([
      ["package.json", JSON.stringify({ name: `@pnpm/exe.${platform}`, version })],
      ["LICENSE", "fixture\n"],
      ["pnpm", script],
    ]),
    archive,
  );
  const digest = await sha(archive, "sha512");
  const integrity = `sha512-${digest.toString("base64")}`;
  assert.deepEqual(parseIntegrity(integrity).digest, digest);
  return integrity;
}

const versionScript = (version: string) => `#!/bin/sh\necho ${version}\n`;

test("the private pnpm is the platform's native binary, verified before extraction", async (t) => {
  const directory = await scratch(t);
  const registry = path.join(directory, "registry");
  const href = pathToFileURL(registry).href;
  const integrity = await fixturePnpmExe(
    directory,
    registry,
    "linux-arm64",
    FIXTURE_PNPM,
    versionScript(FIXTURE_PNPM),
  );
  const other = fileURLToPath(pnpmTarballUrl(href, "darwin-x64", FIXTURE_PNPM));
  await mkdir(path.dirname(other), { recursive: true });
  await cp(fileURLToPath(pnpmTarballUrl(href, "linux-arm64", FIXTURE_PNPM)), other);
  const pins = pnpmPins({ "linux-arm64": integrity });
  const runtime = path.join(directory, "runtime");
  await assert.rejects(
    provisionPrivatePnpm(runtime, pins, { registry: href, platform: "darwin-x64" }),
    ChecksumMismatchError,
  );
  assert.deepEqual(await readdir(runtime), [], "nothing extracted, no archive or staging left");
  await assert.rejects(
    provisionPrivatePnpm(runtime, pins, { registry: "https://registry.invalid", platform: null }),
    /no pinned pnpm build for .*glibc Linux and macOS only.* put pnpm 12\.21\.0 on PATH/,
  );
  assert.deepEqual(await readdir(runtime), []);
  const journaled: string[] = [];
  const onCreated = async (created: string) => {
    journaled.push(created);
  };
  const binary = path.join(runtime, "pnpm", "pnpm");
  assert.deepEqual(
    await provisionPrivatePnpm(runtime, pins, {
      registry: href,
      platform: "linux-arm64",
      onCreated,
    }),
    { path: binary, created: [path.join(runtime, "pnpm")] },
  );
  assert.deepEqual(journaled, [path.join(runtime, "pnpm")], "journaled once it is in place");
  assert.deepEqual(await readdir(runtime), ["pnpm"], "no archive or staging left");
  assert.deepEqual(await readdir(path.join(runtime, "pnpm")), ["pnpm"], "only package/pnpm");
  assert.equal((await lstat(binary)).mode & 0o777, 0o755);
  await rm(registry, { recursive: true });
  assert.deepEqual(
    await provisionPrivatePnpm(runtime, pins, { registry: href, platform: "linux-arm64" }),
    { path: binary, created: [] },
    "re-run reuses it and creates nothing",
  );
});

test("pnpm platforms: macOS and glibc Linux on arm64 and x64 only", async () => {
  assert.equal(await currentPnpmPlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(await currentPnpmPlatform("darwin", "x64"), "darwin-x64");
  assert.equal(await currentPnpmPlatform("win32", "x64"), null);
  assert.equal(await currentPnpmPlatform("freebsd", "x64"), null);
  assert.equal(await currentPnpmPlatform("linux", "ia32"), null);
  const musl = (await readdir("/lib").catch(() => [])).some((entry) =>
    entry.startsWith("ld-musl-"),
  );
  assert.equal(await currentPnpmPlatform("linux", "arm64"), musl ? null : "linux-arm64");
});

async function earlierPnpmLayout(
  pnpmDirectory: string,
  version: string,
  wrapper: boolean,
  marker: string,
): Promise<void> {
  const script = `#!/bin/sh\ntouch '${marker}'\necho ${version}\n`;
  await mkdir(path.join(pnpmDirectory, "bin"), { recursive: true });
  await writeFile(
    path.join(pnpmDirectory, "package.json"),
    JSON.stringify({ name: "pnpm", version }),
  );
  await writeFile(path.join(pnpmDirectory, "bin", "pnpm.mjs"), script, { mode: 0o755 });
  if (wrapper) await writeFile(path.join(pnpmDirectory, "pnpm"), script, { mode: 0o755 });
}

test("an earlier runtime/pnpm layout is replaced without running anything in it", async (t) => {
  const directory = await scratch(t);
  const registry = path.join(directory, "registry");
  const href = pathToFileURL(registry).href;
  const integrity = await fixturePnpmExe(
    directory,
    registry,
    "linux-x64",
    FIXTURE_PNPM,
    versionScript(FIXTURE_PNPM),
  );
  const pins = pnpmPins({ "linux-x64": integrity });
  for (const [label, version, wrapper] of [
    ["pnpm 11 package", "11.11.0", false],
    ["pnpm 12 npm wrapper", FIXTURE_PNPM, true],
  ] as const) {
    const runtime = path.join(directory, label.replaceAll(" ", "-"));
    const marker = path.join(directory, `${label.replaceAll(" ", "-")}.ran`);
    await earlierPnpmLayout(path.join(runtime, "pnpm"), version, wrapper, marker);
    const provisioned = await provisionPrivatePnpm(runtime, pins, {
      registry: href,
      platform: "linux-x64",
    });
    assert.deepEqual(provisioned.created, [path.join(runtime, "pnpm")], label);
    assert.deepEqual(await readdir(path.join(runtime, "pnpm")), ["pnpm"], label);
    assert.equal(await exists(marker), false, `${label}: nothing in it ran`);
  }
});

test("a download that does not report the pinned version leaves runtime/pnpm as it was", async (t) => {
  const directory = await scratch(t);
  const registry = path.join(directory, "registry");
  const integrity = await fixturePnpmExe(
    directory,
    registry,
    "linux-x64",
    FIXTURE_PNPM,
    versionScript("12.21.1"),
  );
  const pins = pnpmPins({ "linux-x64": integrity });
  const runtime = path.join(directory, "runtime");
  const marker = path.join(directory, "ran");
  await earlierPnpmLayout(path.join(runtime, "pnpm"), "11.11.0", false, marker);
  await assert.rejects(
    provisionPrivatePnpm(runtime, pins, {
      registry: pathToFileURL(registry).href,
      platform: "linux-x64",
    }),
    /did not contain a working pnpm 12\.21\.0 \(got "12\.21\.1"\); .* is unchanged/,
  );
  assert.deepEqual(await readdir(runtime), ["pnpm"], "no archive or staging left");
  assert.deepEqual((await readdir(path.join(runtime, "pnpm"))).toSorted(), ["bin", "package.json"]);
  assert.equal(await exists(marker), false);
});

function validManifest(home: string): InstallManifest {
  return {
    schema: 1,
    name: "choco-pi",
    home,
    app: path.join(home, "app"),
    source: "file:///src",
    ref: "main",
    rev: "0".repeat(40),
    node_path: "/usr/local/bin/node",
    bin_link: "/home/u/.local/bin/choco-pi",
    created: [
      path.join(home, "app"),
      path.join(home, "runtime", "pnpm"),
      path.join(home, "install.json"),
      "/home/u/.local/bin/choco-pi",
    ],
    installed_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

test("install.json is schema-validated and confined to installer-owned paths", () => {
  const home = "/home/u/.choco-pi";
  const valid = validManifest(home);
  assert.deepEqual(parseInstallManifest(JSON.stringify(valid), "fixture"), valid);
  assert.throws(() => parseInstallManifest("{", "fixture"), /not valid JSON/);
  assert.throws(
    () => parseInstallManifest(JSON.stringify({ ...valid, schema: 2 }), "fixture"),
    /schema 1/,
  );
  assert.throws(
    () => parseInstallManifest(JSON.stringify({ ...valid, created: "x" }), "fixture"),
    /schema 1/,
  );
  const problems = (change: Partial<InstallManifest>) => manifestProblems({ ...valid, ...change });
  assert.deepEqual(problems({}), []);
  assert.match(problems({ node_path: "node" }).join(), /node_path/);
  assert.match(problems({ node_path: '/a"b/node' }).join(), /JSON escapes/);
  for (const created of [
    home,
    path.join(home, "agent"),
    path.join(home, "lsp", "x"),
    "/etc",
    "/home/u/.pi",
    "rel/x",
    `${home}/../x`,
  ]) {
    assert.notDeepEqual(problems({ created: [created] }), [], created);
  }
  assert.match(problems({ installed_at: "yesterday" }).join(), /installed_at/);
});

test("install.json written before the runtime option stays valid; runtime and bun_path are checked", () => {
  const home = "/home/u/.choco-pi";
  const legacy = validManifest(home);
  const parsed = parseInstallManifest(JSON.stringify(legacy), "legacy");
  assert.equal(parsed.runtime, undefined);
  assert.equal(parsed.bun_path, undefined);
  const withBun: InstallManifest = {
    ...legacy,
    runtime: "bun",
    bun_path: path.join(home, "runtime", "bun", "bin", "bun"),
  };
  assert.deepEqual(parseInstallManifest(JSON.stringify(withBun), "bun"), withBun);
  const withNode = { ...legacy, runtime: "node", bun_path: null };
  assert.deepEqual(parseInstallManifest(JSON.stringify(withNode), "node"), withNode);
  assert.throws(
    () => parseInstallManifest(JSON.stringify({ ...legacy, runtime: "deno" }), "deno"),
    /schema 1/,
  );
  assert.match(manifestProblems({ ...legacy, bun_path: "bun" }).join(), /bun_path is not/);
  assert.match(manifestProblems({ ...legacy, bun_path: '/a"b/bun' }).join(), /bun_path contains/);
});

function fakeBunScript(version: string): string {
  return [
    "#!/bin/sh",
    `if [ "$1" = --no-env-file ] && [ "$2" = -e ]; then printf '%s\\n%s' '${version}' "$0"; exit 0; fi`,
    'for a; do [ "$a" != --version ] || { echo 1.6.0; exit 0; }; done',
    'echo "FAKEBUN $*"',
    "",
  ].join("\n");
}

async function fixtureBunZip(
  directory: string,
  platform: string,
  version: string,
  archive: string,
): Promise<void> {
  const staging = await mkdtemp(path.join(directory, "zip-"));
  await mkdir(path.join(staging, `bun-${platform}`));
  await writeFile(path.join(staging, `bun-${platform}`, "bun"), fakeBunScript(version), {
    mode: 0o755,
  });
  await mkdir(path.dirname(archive), { recursive: true });
  await runFile("zip", ["-qr", archive, `bun-${platform}`], { cwd: staging });
  await rm(staging, { recursive: true, force: true });
}

async function zipToolsPresent(): Promise<boolean> {
  const searchPath = process.env.PATH ?? "";
  return (await onPath("zip", searchPath)) && (await onPath("unzip", searchPath));
}

test("the private Bun zip is verified against the pinned sha256 before unzip ever runs", async (t) => {
  if (!(await zipToolsPresent())) {
    t.skip("needs zip and unzip on PATH");
    return;
  }
  const directory = await scratch(t);
  const mirror = path.join(directory, "mirror");
  const archive = path.join(mirror, "bun-v1.4.4", "bun-darwin-aarch64.zip");
  await fixtureBunZip(directory, "darwin-aarch64", "1.4.4", archive);
  const realUnzip = (await runFile("/bin/sh", ["-c", "command -v unzip"])).stdout.trim();
  const tools = path.join(directory, "tools");
  await mkdir(tools);
  const marker = path.join(directory, "unzip-ran");
  await writeFile(
    path.join(tools, "unzip"),
    `#!/bin/sh\n: > '${marker}'\nexec '${realUnzip}' "$@"\n`,
    { mode: 0o755 },
  );
  const options = {
    mirror: pathToFileURL(mirror).href,
    searchPath: tools,
    platform: "darwin-aarch64" as const,
  };
  const runtime = path.join(directory, "runtime");
  const pinsFor = (sha256: string) =>
    parseRuntimePins(pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY, sha256));

  await assert.rejects(
    provisionPrivateBun(runtime, pinsFor("f".repeat(64)), options),
    ChecksumMismatchError,
  );
  assert.deepEqual(await readdir(runtime), [], "no bun, archive or staging left");
  assert.equal(await exists(marker), false, "unzip never ran on the mismatched zip");

  const digest = (await sha(archive, "sha256")).toString("hex");
  const provisioned = await provisionPrivateBun(runtime, pinsFor(digest), options);
  const binary = provisioned.path;
  assert.equal(binary, path.join(runtime, "bun", "bin", "bun"));
  assert.deepEqual(provisioned.created, [path.join(runtime, "bun")]);
  assert.equal(await exists(marker), true);
  assert.deepEqual(await readdir(runtime), ["bun"]);
  assert.equal((await runFile(binary, ["--version"])).stdout.trim(), "1.6.0");
  await rm(mirror, { recursive: true });
  assert.deepEqual(
    await provisionPrivateBun(runtime, pinsFor(digest), options),
    { path: binary, created: [] },
    "an installed pinned Bun is reused without downloading",
  );
});

test("provisioning Bun without unzip or on an unpinned platform explains and downloads nothing", async (t) => {
  const directory = await scratch(t);
  const runtime = path.join(directory, "runtime");
  const pins = parseRuntimePins(pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY));
  const mirror = pathToFileURL(path.join(directory, "no-mirror")).href;
  const noUnzip = path.join(directory, "empty-bin");
  await mkdir(noUnzip);
  const failure = await provisionPrivateBun(runtime, pins, {
    mirror,
    searchPath: noUnzip,
    platform: "linux-x64",
  }).then(
    () => null,
    (error: Error) => error,
  );
  assert.equal(failure?.message, UNZIP_GUIDANCE);
  assert.doesNotMatch(UNZIP_GUIDANCE, /\bsudo\b/);
  assert.deepEqual(await readdir(runtime), []);
  await assert.rejects(
    provisionPrivateBun(runtime, pins, { mirror, searchPath: noUnzip, platform: null }),
    /no pinned Bun build/,
  );
  const platform = await currentBunPlatform();
  if (process.platform === "darwin") assert.match(String(platform), /^darwin-(aarch64|x64)$/);
  assert.equal(await currentBunPlatform("win32", "x64"), null);
});

test("the launcher link replaces only our own link and refuses a foreign file", async (t) => {
  const directory = await scratch(t);
  const binDir = path.join(directory, "bin");
  const launcher = path.join(directory, "home", "app", "bin", "choco-pi");
  const link = path.join(binDir, "choco-pi");
  assert.deepEqual(await linkLauncher(binDir, launcher, null), { link, action: "created" });
  assert.deepEqual(await linkLauncher(binDir, launcher, null), { link, action: "unchanged" });
  assert.equal(await isOurLink(link, launcher), true);
  const moved = path.join(directory, "other", "app", "bin", "choco-pi");
  await assert.rejects(linkLauncher(binDir, moved, null), /refusing to replace/);
  assert.equal(await readlink(link), launcher, "an unrecorded link is left alone");
  assert.deepEqual(await linkLauncher(binDir, moved, link), { link, action: "replaced" });
  assert.equal(await readlink(link), moved);
  await rm(link);
  await writeFile(link, "user script\n");
  await assert.rejects(linkLauncher(binDir, launcher, link), /not a symlink; refusing/);
  assert.equal(await readFile(link, "utf8"), "user script\n");
  assert.equal(await isOurLink(link, launcher), false);
  assert.deepEqual(
    (await readdir(binDir)).toSorted(),
    ["choco-pi"],
    "no temporary link left behind",
  );
});

async function fixtureSource(directory: string): Promise<string> {
  const source = path.join(directory, "source");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await cp(path.join(ROOT, "bin", "choco-pi"), path.join(source, "bin", "choco-pi"));
  await cp(INSTALL_SH, path.join(source, "install.sh"));
  await cp(path.join(ROOT, "scripts", "standalone"), path.join(source, "scripts", "standalone"), {
    recursive: true,
  });
  await cp(path.join(ROOT, "profile", "standalone"), path.join(source, "profile", "standalone"), {
    recursive: true,
  });
  const runtimeValues = path.join("profile", "extensions", "lib", "runtime-values.ts");
  await mkdir(path.dirname(path.join(source, runtimeValues)), { recursive: true });
  await cp(path.join(ROOT, runtimeValues), path.join(source, runtimeValues));
  await writeFile(
    path.join(source, "scripts", "install-profile.ts"),
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      "export async function installProfile(options: { root: string; agentDir: string; piLauncher: string }) {",
      '  const markerPath = path.join(options.agentDir, "choco-pi", "profile.json");',
      "  await mkdir(path.dirname(markerPath), { recursive: true });",
      "  await writeFile(markerPath, JSON.stringify({ checkout: options.root, launcher: options.piLauncher }));",
      '  return { links: [], settingsPath: path.join(options.agentDir, "settings.json"), markerPath, addedPackages: [], removed: [], warnings: [] };',
      "}",
      "",
    ].join("\n"),
  );
  const fakePi = path.join(source, "fake-pi");
  await mkdir(
    path.join(
      fakePi,
      path.dirname(
        PI_CLI_RELATIVE.replace(/^node_modules\/@earendil-works\/pi-coding-agent\//, ""),
      ),
    ),
    { recursive: true },
  );
  await writeFile(
    path.join(fakePi, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.6.0",
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  await writeFile(
    path.join(fakePi, "dist", "bundle", "cli.js"),
    'process.stdout.write("1.6.0\\n");\n',
    { mode: 0o755 },
  );
  const vendored: Record<string, string> = {};
  for (const name of [
    "@choco-pi/shared",
    "@earendil-works/pi-schema",
    "@optique/core",
    "@logtape/logtape",
  ]) {
    const directoryName = name.replace("/", "__");
    await cp(
      await realpath(path.join(ROOT, "node_modules", name)),
      path.join(source, "vendor", directoryName),
      { recursive: true, dereference: true },
    );
    vendored[name] = `link:./vendor/${directoryName}`;
  }
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      private: true,
      type: "module",
      packageManager: `pnpm@${(await readRuntimePins()).pnpmVersion}`,
      dependencies: { "@earendil-works/pi-coding-agent": "link:./fake-pi", ...vendored },
    }),
  );
  await writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  return source;
}

async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => !entry.split(path.sep).includes("node_modules")).toSorted();
}

async function pinnedPnpmMissing(): Promise<string | null> {
  const pinned = (await readRuntimePins()).pnpmVersion;
  const version = await runFile("pnpm", ["--version"]).then(
    ({ stdout }) => stdout.trim(),
    () => null,
  );
  return version === pinned ? null : `needs pnpm ${pinned} on PATH (found ${version ?? "none"})`;
}

async function fixturePnpmRegistry(
  directory: string,
  source: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const platform = await currentPnpmPlatform();
  if (platform === null) return null;
  const realPnpm = (
    await runFile("/bin/sh", ["-c", "command -v pnpm"], { env: environment })
  ).stdout.trim();
  const registry = path.join(directory, "pnpm-registry");
  const pinsFile = path.join(source, "scripts", "standalone", "runtime-pins.txt");
  const version = (await readRuntimePins(pinsFile)).pnpmVersion;
  const integrity = await fixturePnpmExe(
    directory,
    registry,
    platform,
    version,
    `#!/bin/sh\nPATH='${NODE_DIR}':"$PATH" exec '${realPnpm}' "$@"\n`,
  );
  const pins = await readFile(pinsFile, "utf8");
  await writeFile(
    pinsFile,
    pins.replace(
      new RegExp(`^pnpm_integrity_${platform} \\S+$`, "m"),
      `pnpm_integrity_${platform} ${integrity}`,
    ),
  );
  return pathToFileURL(registry).href;
}

async function fixtureEnvironment(
  directory: string,
): Promise<{ userHome: string; environment: NodeJS.ProcessEnv }> {
  const userHome = path.join(directory, "user-home");
  await mkdir(userHome);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userHome,
    PATH: `${NODE_DIR}:${process.env.PATH ?? ""}`,
  };
  delete environment.CHOCO_PI_HOME;
  for (const name of [
    "PNPM_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
  ])
    delete environment[name];
  return { userHome, environment };
}

async function commitFixture(
  source: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const lockDirs = [
    `--config.store-dir=${path.join(directory, "lock-store")}`,
    `--config.cache-dir=${path.join(directory, "lock-cache")}`,
    `--config.state-dir=${path.join(directory, "lock-state")}`,
  ];
  await runFile("pnpm", ["install", "--lockfile-only", ...lockDirs], {
    cwd: source,
    env: { ...environment, PNPM_HOME: path.join(directory, "lock-home") },
  });
  await runFile("git", ["init", "--quiet", "--initial-branch=main", source]);
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", "fixture"]);
}

async function commitChange(source: string): Promise<string> {
  await writeFile(path.join(source, "CHANGELOG"), "next\n");
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", "next"]);
  return (await runFile("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
}

async function stageOneInstall(
  app: string,
  home: string,
  binDir: string,
  source: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (!(await exists(path.join(home, "install.json"))))
    await appendFile(path.join(home, PROVENANCE_NAME), `${app}\n`);
  const { stdout: bootstrap } = await runFile(
    process.execPath,
    [path.join(app, "scripts", "standalone", "bootstrap.ts")],
    { env: environment, timeout: 120_000 },
  );
  const args = [
    path.join(app, "scripts", "standalone", "manage.ts"),
    "install",
    "--home",
    home,
    "--bin-dir",
    binDir,
    "--source",
    source,
    "--ref",
    "main",
  ];
  const { stdout } = await runFile(process.execPath, args, { env: environment, timeout: 120_000 });
  return bootstrap + stdout;
}

async function readManifest(home: string): Promise<InstallManifest> {
  return parseInstallManifest(
    await readFile(path.join(home, "install.json"), "utf8"),
    "install.json",
  );
}

test("stage 1 install is idempotent, updates by fast-forward, and uninstall removes exactly what it recorded", async (t) => {
  const skipReason = await pinnedPnpmMissing();
  if (skipReason !== null) {
    t.skip(skipReason);
    return;
  }
  const directory = await scratch(t);
  const { userHome, environment } = await fixtureEnvironment(directory);
  const source = await fixtureSource(directory);
  const bunPlatform = await currentBunPlatform();
  const shippedPins = await readRuntimePins();
  const bunMirror = path.join(directory, "bun-mirror");
  const withBun =
    bunPlatform !== null &&
    (await zipToolsPresent()) &&
    (await onPath("unzip", "/usr/bin:/bin")) &&
    !(await onPath("bun", "/usr/bin:/bin"));
  if (withBun) {
    const zip = path.join(bunMirror, `bun-v${shippedPins.bunVersion}`, `bun-${bunPlatform}.zip`);
    await fixtureBunZip(directory, bunPlatform, shippedPins.bunVersion, zip);
    const digest = (await sha(zip, "sha256")).toString("hex");
    const pinsFile = path.join(source, "scripts", "standalone", "runtime-pins.txt");
    const pinsText = await readFile(pinsFile, "utf8");
    await writeFile(
      pinsFile,
      pinsText.replace(/^(bun_sha256_\S+) [a-f0-9]{64}$/gm, `$1 ${digest}`),
    );
  }
  await commitFixture(source, directory, environment);

  const home = path.join(directory, "choco");
  const binDir = path.join(directory, "bin");
  const app = path.join(home, "app");
  await runFile("git", ["clone", "--quiet", "--no-hardlinks", source, app]);
  const install = () => stageOneInstall(app, home, binDir, source, environment);
  const first = await install();
  assert.match(first, /created: .*choco-pi ->/);
  assert.match(first, /^Next steps:$/m, "the first setup prints the next steps");
  const seed = await readSettingsSeed();
  const seeded: unknown = JSON.parse(
    await readFile(path.join(home, "agent", "settings.json"), "utf8"),
  );
  assert.deepEqual(
    seeded,
    Object.fromEntries(Object.entries(seed.settings).map(([key, entry]) => [key, entry?.value])),
    "the stub profile writes no settings, so exactly the seed keys are there",
  );
  const manifestText = await readFile(path.join(home, "install.json"), "utf8");
  const manifest = parseInstallManifest(manifestText, "install.json");
  assert.equal(manifest.node_path, process.execPath);
  assert.equal(manifest.app, app);
  assert.equal(manifest.bin_link, path.join(binDir, "choco-pi"));
  assert.ok(
    manifest.created.includes(app) && manifest.created.includes(path.join(binDir, "choco-pi")),
  );
  for (const entry of ["pnpm-store", "pnpm-cache", "pnpm-state", "pnpm-home"]) {
    const owned = path.join(home, "runtime", entry);
    assert.ok(manifest.created.includes(owned), `${owned} is owned`);
  }
  const launcherEnvironment = { ...environment, PATH: "/usr/bin:/bin" };
  const version = await runFile(path.join(binDir, "choco-pi"), ["--version"], {
    env: launcherEnvironment,
  });
  assert.equal(version.stdout.trim(), "1.6.0");
  const tree = await snapshot(home);

  const second = await install();
  assert.match(second, /unchanged: .*choco-pi ->/);
  assert.doesNotMatch(second, /seeded:|Next steps:/, "a re-run seeds nothing");
  const again = parseInstallManifest(
    await readFile(path.join(home, "install.json"), "utf8"),
    "install.json",
  );
  assert.deepEqual({ ...again, updated_at: "" }, { ...manifest, updated_at: "" });
  assert.deepEqual(await snapshot(home), tree, "re-run creates nothing new");

  const head = await commitChange(source);
  await runFile(path.join(binDir, "choco-pi"), ["self", "update"], {
    env: launcherEnvironment,
    timeout: 120_000,
  });
  const updated = parseInstallManifest(
    await readFile(path.join(home, "install.json"), "utf8"),
    "install.json",
  );
  assert.equal(updated.rev, head);
  assert.equal((await runFile("git", ["-C", app, "rev-parse", "HEAD"])).stdout.trim(), head);

  if (withBun) {
    const bunEnvironment = {
      ...launcherEnvironment,
      CHOCO_PI_BUN_MIRROR: pathToFileURL(bunMirror).href,
    };
    const { stdout: switched } = await runFile(
      path.join(binDir, "choco-pi"),
      ["self", "runtime", "bun"],
      { env: bunEnvironment, timeout: 60_000 },
    );
    assert.match(switched, /bun: provisioned /);
    const bunManifest = parseInstallManifest(
      await readFile(path.join(home, "install.json"), "utf8"),
      "install.json",
    );
    assert.equal(bunManifest.runtime, "bun");
    assert.equal(bunManifest.bun_path, path.join(home, "runtime", "bun", "bin", "bun"));
    assert.ok(bunManifest.created.includes(path.join(home, "runtime", "bun")));
    const { stdout: viaBun } = await runFile(path.join(binDir, "choco-pi"), ["hello"], {
      env: launcherEnvironment,
    });
    assert.match(viaBun, /^FAKEBUN --no-env-file --no-install --config=\S+ \S+cli\.js hello$/m);
  } else {
    t.diagnostic(
      "Bun provisioning part skipped (needs zip, unzip, a pinned platform, no bun in /usr/bin:/bin)",
    );
  }

  await writeFile(path.join(home, "agent", "auth.json"), "{}\n");
  await writeFile(path.join(home, "notes.txt"), "user file\n");
  await mkdir(path.join(home, "lsp"));
  const { stdout: removal } = await runFile(path.join(binDir, "choco-pi"), ["self", "uninstall"], {
    env: launcherEnvironment,
  });
  assert.match(removal, /kept: .*agent/);
  assert.deepEqual((await readdir(home)).toSorted(), ["agent", "lsp", "notes.txt"]);
  assert.equal(await readFile(path.join(home, "agent", "auth.json"), "utf8"), "{}\n");
  assert.deepEqual(await readdir(binDir), []);
  assert.deepEqual(await readdir(userHome), [], "nothing written to the user's home");
});

test("a runtime directory the installer did not create survives install, update and uninstall", async (t) => {
  const skipReason = await pinnedPnpmMissing();
  if (skipReason !== null) {
    t.skip(skipReason);
    return;
  }
  const directory = await scratch(t);
  const { environment } = await fixtureEnvironment(directory);
  const source = await fixtureSource(directory);
  const pnpmRegistry = await fixturePnpmRegistry(directory, source, environment);
  await commitFixture(source, directory, environment);
  const home = path.join(directory, "choco");
  const binDir = path.join(directory, "bin");
  const app = path.join(home, "app");
  const foreignBun = path.join(home, "runtime", "bun");
  await mkdir(foreignBun, { recursive: true });
  await writeFile(path.join(foreignBun, "unrelated"), "not the installer's\n");
  await runFile("git", ["clone", "--quiet", "--no-hardlinks", source, app]);
  await stageOneInstall(app, home, binDir, source, environment);
  const installed = await readManifest(home);
  assert.ok(installed.created.includes(app), "stage 0 reported the clone");
  assert.equal(installed.created.includes(foreignBun), false, "existence is not ownership");
  assert.ok(installed.created.includes(path.join(home, "runtime", "pnpm-store")));

  if (pnpmRegistry === null) {
    t.diagnostic("private pnpm part skipped (no pnpm pin for this platform)");
    return;
  }
  const pnpmDirectory = path.join(home, "runtime", "pnpm");
  const marker = path.join(directory, "old-pnpm-ran");
  await earlierPnpmLayout(pnpmDirectory, "11.11.0", false, marker);
  const launcherEnvironment = {
    ...environment,
    PATH: "/usr/bin:/bin",
    CHOCO_PI_NPM_REGISTRY: pnpmRegistry,
  };
  const head = await commitChange(source);
  const { stdout: updateOutput } = await runFile(
    path.join(binDir, "choco-pi"),
    ["self", "update"],
    {
      env: launcherEnvironment,
      timeout: 120_000,
    },
  );
  assert.match(
    updateOutput,
    new RegExp(`^pnpm: private ${literal(path.join(pnpmDirectory, "pnpm"))}$`, "m"),
  );
  const updated = await readManifest(home);
  assert.equal(updated.rev, head);
  assert.deepEqual(updated.created.slice(0, installed.created.length), installed.created);
  assert.ok(updated.created.includes(pnpmDirectory));
  assert.deepEqual(await readdir(pnpmDirectory), ["pnpm"]);
  assert.equal(await exists(marker), false, "the pnpm 11 layout never ran");
  assert.equal(updated.created.includes(foreignBun), false, "update does not claim it either");
  const version = await runFile(path.join(binDir, "choco-pi"), ["--version"], {
    env: launcherEnvironment,
  });
  assert.equal(version.stdout.trim(), "1.6.0");

  await runFile(path.join(binDir, "choco-pi"), ["self", "uninstall"], { env: launcherEnvironment });
  assert.equal(await readFile(path.join(foreignBun, "unrelated"), "utf8"), "not the installer's\n");
  assert.deepEqual((await readdir(home)).toSorted(), ["agent", "runtime"]);
  assert.deepEqual(await readdir(path.join(home, "runtime")), ["bun"]);
});

function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STUB_NODE = [
  "#!/bin/sh",
  'case "$1" in',
  '  -e) case "$2" in *execPath*) printf %s "$0" ;; *) printf 24 ;; esac ;;',
  "  --version) echo v24.0.0 ;;",
  '  *) echo "STAGE1 $*" ;;',
  "esac",
  "",
].join("\n");

test("install.sh installs into CHOCO_PI_HOME unless --home overrides it", async (t) => {
  if (!(await onPath("git", "/usr/bin:/bin"))) {
    t.skip("needs git in /usr/bin:/bin");
    return;
  }
  const directory = await scratch(t);
  const tools = path.join(directory, "tools");
  await mkdir(tools);
  await writeFile(path.join(tools, "node"), STUB_NODE, { mode: 0o755 });
  const source = await pinsOnlySource(
    directory,
    `installer_protocol ${INSTALLER_PROTOCOL}\n${pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY)}`,
  );
  const userHome = path.join(directory, "user-home");
  const envHome = path.join(directory, "env-home");
  const run = async (args: readonly string[]) => {
    const { stdout } = await runFile(
      "/bin/sh",
      [INSTALL_SH, "--bin-dir", path.join(directory, "bin"), "--source", source, ...args],
      { env: { HOME: userHome, PATH: `${tools}:/usr/bin:/bin`, CHOCO_PI_HOME: envHome } },
    );
    return stdout;
  };
  const fromEnvironment = await run([]);
  assert.match(fromEnvironment, new RegExp(`STAGE1 \\S+ install --home ${literal(envHome)} `));
  assert.equal(await exists(path.join(envHome, "app", ".git")), true);
  assert.equal(await exists(path.join(userHome, ".choco-pi")), false);

  const flagHome = path.join(directory, "flag-home");
  const fromFlag = await run(["--home", flagHome]);
  assert.match(fromFlag, new RegExp(`STAGE1 \\S+ install --home ${literal(flagHome)} `));
  assert.equal(await exists(path.join(flagHome, "app", ".git")), true);
});

test("install.sh downloads Node, then hands stage 1 the runtime name rather than a path", async (t) => {
  const platform = nodePlatform();
  const basePath = "/usr/bin:/bin";
  const skipReason =
    (await pinnedPnpmMissing()) ??
    (platform === null || (await onPath("node", basePath)) || !(await onPath("git", basePath))
      ? "needs darwin/linux with git but no node in /usr/bin:/bin"
      : null);
  if (skipReason !== null || platform === null) {
    t.skip(skipReason ?? "unsupported platform");
    return;
  }
  const directory = await scratch(t);
  const { environment } = await fixtureEnvironment(directory);
  const source = await fixtureSource(directory);
  const calls = path.join(directory, "node-calls.log");
  const nodeName = `node-v24.0.0-${platform}`;
  const nodeMirror = path.join(directory, "node-mirror");
  const nodeArchive = path.join(nodeMirror, "v24.0.0", `${nodeName}.tar.gz`);
  const nodeWrapper = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${calls}'`,
    `exec '${process.execPath}' "$@"`,
    "",
  ].join("\n");
  await fixtureTarball(directory, nodeName, new Map([["bin/node", nodeWrapper]]), nodeArchive);
  const nodeDigest = (await sha(nodeArchive, "sha256")).toString("hex");
  const bunPlatform = await currentBunPlatform();
  const withBun =
    bunPlatform !== null &&
    (await zipToolsPresent()) &&
    (await onPath("unzip", basePath)) &&
    !(await onPath("bun", basePath));
  const bunMirror = path.join(directory, "bun-mirror");
  const pinsFile = path.join(source, "scripts", "standalone", "runtime-pins.txt");
  let pins = (await readFile(pinsFile, "utf8"))
    .replace(/^node_version \S+$/m, "node_version 24.0.0")
    .replace(/^(node_sha256_\S+) [a-f0-9]{64}$/gm, `$1 ${nodeDigest}`);
  if (withBun) {
    const version = (await readRuntimePins()).bunVersion;
    const zip = path.join(bunMirror, `bun-v${version}`, `bun-${bunPlatform}.zip`);
    await fixtureBunZip(directory, bunPlatform, version, zip);
    const bunDigest = (await sha(zip, "sha256")).toString("hex");
    pins = pins.replace(/^(bun_sha256_\S+) [a-f0-9]{64}$/gm, `$1 ${bunDigest}`);
  }
  await writeFile(pinsFile, pins);
  await commitFixture(source, directory, environment);
  const shims = path.join(directory, "shims");
  await mkdir(shims);
  const pnpm = (
    await runFile("/bin/sh", ["-c", "command -v pnpm"], { env: environment })
  ).stdout.trim();
  await writeFile(
    path.join(shims, "pnpm"),
    ["#!/bin/sh", `PATH='${NODE_DIR}':"$PATH" exec '${pnpm}' "$@"`, ""].join("\n"),
    { mode: 0o755 },
  );
  const userHome = path.join(directory, "user-home");
  const installEnvironment = {
    HOME: userHome,
    PATH: `${shims}:${basePath}`,
    CHOCO_PI_NODE_MIRROR: pathToFileURL(nodeMirror).href,
    CHOCO_PI_BUN_MIRROR: pathToFileURL(bunMirror).href,
  };
  const install = async (label: string, extra: readonly string[]) => {
    const home = path.join(directory, `home-${label}`);
    const binDir = path.join(directory, `bin-${label}`);
    const args = [
      INSTALL_SH,
      "--home",
      home,
      "--bin-dir",
      binDir,
      "--source",
      source,
      "--ref",
      "main",
    ];
    await runFile("/bin/sh", [...args, ...extra], {
      env: installEnvironment,
      timeout: 180_000,
    }).catch((error: Failure) => {
      assert.fail(
        `install.sh ${label} failed (${error.code}):\n${error.stdout ?? ""}${error.stderr ?? ""}`,
      );
    });
    const stageOne = (await readFile(calls, "utf8"))
      .split("\n")
      .filter((line) => line.includes(" install --home ") && line.includes(home));
    assert.equal(stageOne.length, 1, `one stage 1 call for ${label}`);
    const version = await runFile(path.join(binDir, "choco-pi"), ["--version"], {
      env: { HOME: userHome, PATH: basePath },
    });
    assert.equal(version.stdout.trim(), "1.6.0");
    return { home, stageOne: stageOne[0] ?? "", manifest: await readManifest(home) };
  };

  const byDefault = await install("default", []);
  assert.doesNotMatch(byDefault.stageOne, /--runtime/, "the default leaves the runtime to stage 1");
  assert.match(byDefault.stageOne, / --ref main$/, "only arguments every stage 1 accepts");
  assert.equal(byDefault.manifest.runtime, "node");
  assert.ok(byDefault.manifest.created.includes(path.join(byDefault.home, "app")));
  assert.ok(byDefault.manifest.created.includes(path.join(byDefault.home, "runtime", "node")));
  assert.equal(await exists(path.join(byDefault.home, PROVENANCE_NAME)), false);

  if (!withBun) {
    t.diagnostic(
      "--runtime bun part skipped (needs zip, unzip, a pinned platform, no bun in /usr/bin:/bin)",
    );
    return;
  }
  const onBun = await install("bun", ["--runtime", "bun"]);
  assert.match(onBun.stageOne, / --runtime bun$/);
  assert.equal(onBun.manifest.runtime, "bun");
  assert.equal(onBun.manifest.bun_path, path.join(onBun.home, "runtime", "bun", "bin", "bun"));
  assert.ok(onBun.manifest.created.includes(path.join(onBun.home, "runtime", "bun")));
});

test("the creation journal yields only ownable paths and is empty when absent", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  await mkdir(home);
  const link = path.join(directory, "bin", "choco-pi");
  assert.deepEqual(await readProvenance(home, link), { accepted: [], rejected: [] });
  const app = path.join(home, "app");
  const node = path.join(home, "runtime", "node");
  const invalid = [
    home,
    path.join(home, "agent"),
    path.join(home, "lsp", "x"),
    path.join(home, PROVENANCE_NAME),
    "/etc",
    "rel/x",
    `${home}/../x`,
  ];
  await writeFile(
    path.join(home, PROVENANCE_NAME),
    [app, node, app, ...invalid, link, ""].join("\n"),
  );
  const withLink = await readProvenance(home, link);
  assert.deepEqual(withLink.accepted, [app, node, link]);
  assert.deepEqual(
    withLink.rejected.map(({ entry }) => entry),
    invalid,
  );
  assert.deepEqual(
    (await readProvenance(home, null)).accepted,
    [app, node],
    "a path outside the home is owned only as the recorded bin link",
  );
  assert.equal(provenanceEntryProblem(home, null, path.join(home, "runtime", "pnpm")), null);
});

async function uninstallHome(
  home: string,
  userHome: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runFile(
    process.execPath,
    [path.join(ROOT, "scripts", "standalone", "manage.ts"), "self", "uninstall"],
    {
      env: {
        PATH: `${NODE_DIR}:/usr/bin:/bin`,
        HOME: userHome,
        CHOCO_PI_STANDALONE: "1",
        CHOCO_PI_HOME: home,
        CHOCO_PI_LAUNCHER: path.join(home, "app", "bin", "choco-pi"),
      },
    },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: Failure) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

async function aliasedHome(directory: string, label: string) {
  const home = path.join(directory, label);
  const outside = path.join(directory, `${label}-outside`);
  const userHome = path.join(directory, `${label}-user`);
  await mkdir(path.join(home, "app", "bin"), { recursive: true });
  await writeFile(path.join(home, "app", "bin", "choco-pi"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(path.join(home, "runtime", "node", "bin"), { recursive: true });
  await mkdir(outside);
  await mkdir(userHome);
  await writeFile(path.join(outside, "valuable.txt"), "keep me\n");
  await symlink(outside, path.join(home, "alias"));
  return { home, outside, userHome, escaping: path.join(home, "alias", "valuable.txt") };
}

test("uninstall never deletes through a symlinked ancestor, with or without install.json", async (t) => {
  const directory = await scratch(t);

  const bare = await aliasedHome(directory, "journal-only");
  await writeFile(
    path.join(bare.home, PROVENANCE_NAME),
    [path.join(bare.home, "app"), bare.escaping, ""].join("\n"),
  );
  const fromJournal = await uninstallHome(bare.home, bare.userHome);
  assert.equal(fromJournal.code, 0, fromJournal.stderr);
  assert.equal(await readFile(path.join(bare.outside, "valuable.txt"), "utf8"), "keep me\n");
  assert.match(
    fromJournal.stdout,
    new RegExp(`^kept: ${literal(bare.escaping)} \\(.*outside the install home`, "m"),
  );
  assert.equal(await exists(path.join(bare.home, "app")), false, "the real entry is removed");

  const recorded = await aliasedHome(directory, "manifest");
  const binDir = path.join(directory, "bin");
  await mkdir(binDir);
  const binLink = path.join(binDir, "choco-pi");
  await symlink(path.join(recorded.home, "app", "bin", "choco-pi"), binLink);
  const manifest: InstallManifest = {
    ...validManifest(recorded.home),
    node_path: process.execPath,
    bin_link: binLink,
    created: [
      path.join(recorded.home, "app"),
      path.join(recorded.home, "runtime", "node"),
      recorded.escaping,
      path.join(recorded.home, "install.json"),
      binLink,
    ],
  };
  assert.deepEqual(manifestProblems(manifest), [], "lexically, the escaping path looks owned");
  await writeFile(path.join(recorded.home, "install.json"), JSON.stringify(manifest));
  const fromManifest = await uninstallHome(recorded.home, recorded.userHome);
  assert.equal(fromManifest.code, 0, fromManifest.stderr);
  assert.equal(await readFile(path.join(recorded.outside, "valuable.txt"), "utf8"), "keep me\n");
  assert.match(fromManifest.stdout, new RegExp(`^kept: ${literal(recorded.escaping)} \\(`, "m"));
  assert.deepEqual(await readdir(recorded.home), ["alias"], "app, runtime and install.json go");
  assert.deepEqual(await readdir(binDir), [], "our bin link goes");
});

test("a recorded entry that is a symlink to an outside directory loses only the link", async (t) => {
  const directory = await scratch(t);
  const { home, outside, userHome } = await aliasedHome(directory, "home");
  const linked = path.join(home, "runtime", "bun");
  await symlink(outside, linked);
  const manifest: InstallManifest = {
    ...validManifest(home),
    node_path: process.execPath,
    bin_link: null,
    created: [path.join(home, "app"), linked, path.join(home, "install.json")],
  };
  await writeFile(path.join(home, "install.json"), JSON.stringify(manifest));
  const result = await uninstallHome(home, userHome);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^removed: ${literal(linked)}$`, "m"));
  assert.equal(await exists(linked), false, "the link is removed");
  assert.deepEqual(await readdir(outside), ["valuable.txt"], "its target is untouched");
});

test("owned entries are resolved through the filesystem, not just lexically", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  const userHome = path.join(home, "user");
  await mkdir(path.join(home, "agent"), { recursive: true });
  await mkdir(path.join(userHome, ".pi"), { recursive: true });
  await mkdir(path.join(directory, "outside"));
  await symlink(path.join(home, "agent"), path.join(home, "state"));
  await symlink(path.join(userHome, ".pi"), path.join(home, "pi"));
  await symlink(path.join(directory, "outside"), path.join(home, "alias"));
  const refused = async (entry: string) =>
    (await resolveOwnedEntry(home, entry, userHome)).kind === "refused";
  assert.equal(await refused(path.join(home, "state", "auth.json")), true, "user state via a link");
  assert.equal(await refused(path.join(home, "pi", "agent")), true, "~/.pi via a link");
  assert.equal(await refused(userHome), true, "the user's home itself");
  assert.equal(await refused(path.join(home, "alias", "x", "y")), true, "a missing parent outside");
  assert.deepEqual(await resolveOwnedEntry(home, path.join(home, "runtime", "node"), userHome), {
    kind: "missing",
  });
  assert.deepEqual(await resolveOwnedEntry(home, path.join(home, "alias"), userHome), {
    kind: "resolved",
    path: path.join(home, "alias"),
  });
  await writeFile(
    path.join(home, PROVENANCE_NAME),
    [path.join(home, "app"), path.join(home, "alias", "x"), ""].join("\n"),
  );
  const journal = await readProvenance(home, null);
  assert.deepEqual(journal.accepted, [path.join(home, "app")]);
  assert.deepEqual(
    journal.rejected.map(({ entry }) => entry),
    [path.join(home, "alias", "x")],
    "a journal entry through an outside link never becomes owned",
  );
});

async function nodeDownloadFixture(
  directory: string,
  source: string,
  platform: string,
): Promise<string> {
  const nodeName = `node-v24.0.0-${platform}`;
  const nodeMirror = path.join(directory, "node-mirror");
  const nodeArchive = path.join(nodeMirror, "v24.0.0", `${nodeName}.tar.gz`);
  const nodeWrapper = ["#!/bin/sh", `exec '${process.execPath}' "$@"`, ""].join("\n");
  await fixtureTarball(directory, nodeName, new Map([["bin/node", nodeWrapper]]), nodeArchive);
  const nodeDigest = (await sha(nodeArchive, "sha256")).toString("hex");
  const pinsFile = path.join(source, "scripts", "standalone", "runtime-pins.txt");
  await writeFile(
    pinsFile,
    (await readFile(pinsFile, "utf8"))
      .replace(/^node_version \S+$/m, "node_version 24.0.0")
      .replace(/^(node_sha256_\S+) [a-f0-9]{64}$/gm, `$1 ${nodeDigest}`),
  );
  return pathToFileURL(nodeMirror).href;
}

test("a failed install keeps ownership of what it created, for the retry and for uninstall", async (t) => {
  const platform = nodePlatform();
  const basePath = "/usr/bin:/bin";
  const skipReason =
    (await pinnedPnpmMissing()) ??
    (platform === null || (await onPath("node", basePath)) || !(await onPath("git", basePath))
      ? "needs darwin/linux with git but no node in /usr/bin:/bin"
      : null);
  if (skipReason !== null || platform === null) {
    t.skip(skipReason ?? "unsupported platform");
    return;
  }
  const directory = await scratch(t);
  const { environment } = await fixtureEnvironment(directory);
  const source = await fixtureSource(directory);
  const nodeMirror = await nodeDownloadFixture(directory, source, platform);
  await commitFixture(source, directory, environment);
  const shims = path.join(directory, "shims");
  await mkdir(shims);
  const pnpm = (
    await runFile("/bin/sh", ["-c", "command -v pnpm"], { env: environment })
  ).stdout.trim();
  await writeFile(
    path.join(shims, "pnpm"),
    ["#!/bin/sh", `PATH='${NODE_DIR}':"$PATH" exec '${pnpm}' "$@"`, ""].join("\n"),
    { mode: 0o755 },
  );
  const userHome = path.join(directory, "user-home");
  const binDir = path.join(directory, "bin");
  const noPnpm = {
    PATH: basePath,
    CHOCO_PI_NODE_MIRROR: nodeMirror,
    CHOCO_PI_NPM_REGISTRY: pathToFileURL(path.join(directory, "no-registry")).href,
  };
  const installSh = async (home: string, extra: Record<string, string>) =>
    runFile(
      "/bin/sh",
      [INSTALL_SH, "--home", home, "--bin-dir", binDir, "--source", source, "--ref", "main"],
      { env: { HOME: userHome, ...extra }, timeout: 180_000 },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error: Failure) => ({
        code: error.code ?? -1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );
  const journal = async (home: string) => (await readProvenance(home, null)).accepted;
  const home = path.join(directory, "home");
  const app = path.join(home, "app");
  const runtime = path.join(home, "runtime");
  const pnpmDirectories = ["pnpm-store", "pnpm-cache", "pnpm-state", "pnpm-home"].map((entry) =>
    path.join(runtime, entry),
  );

  const nodeFails = await installSh(home, {
    PATH: basePath,
    CHOCO_PI_NODE_MIRROR: pathToFileURL(path.join(directory, "no-node")).href,
  });
  assert.equal(nodeFails.code, 1, nodeFails.output);
  assert.match(nodeFails.output, /download failed/);
  assert.deepEqual(await journal(home), [app], "stage 0 journaled the clone before failing");

  const pnpmFails = await installSh(home, noPnpm);
  assert.equal(pnpmFails.code, 1, pnpmFails.output);
  assert.equal(await exists(path.join(home, "install.json")), false, "failed before install.json");
  assert.deepEqual(await journal(home), [app, path.join(runtime, "node"), ...pnpmDirectories]);

  const retry = await installSh(home, {
    PATH: `${shims}:${basePath}`,
    CHOCO_PI_NODE_MIRROR: nodeMirror,
  });
  assert.equal(retry.code, 0, retry.output);
  const manifest = await readManifest(home);
  for (const owned of [app, path.join(runtime, "node"), ...pnpmDirectories]) {
    assert.ok(manifest.created.includes(owned), `${owned} is owned after the retry`);
  }
  assert.equal(await exists(path.join(home, PROVENANCE_NAME)), false, "merged, then removed");
  await runFile(path.join(binDir, "choco-pi"), ["self", "uninstall"], {
    env: { HOME: userHome, PATH: basePath },
  });
  assert.deepEqual(await readdir(home), ["agent"]);
  assert.deepEqual(await readdir(binDir), []);

  const abandoned = path.join(directory, "abandoned");
  const failed = await installSh(abandoned, noPnpm);
  assert.equal(failed.code, 1, failed.output);
  const { stdout: removal } = await runFile(
    path.join(abandoned, "app", "bin", "choco-pi"),
    ["self", "uninstall"],
    { env: { HOME: userHome, PATH: basePath } },
  );
  assert.match(removal, new RegExp(`removed: ${literal(path.join(abandoned, "app"))}$`, "m"));
  assert.deepEqual(await readdir(abandoned), []);
  assert.deepEqual(await readdir(userHome), [], "nothing written to the user's home");
});

const PROTOCOL_ONE_STAGE_ONE = [
  'const valued = new Set(["--home", "--bin-dir", "--source", "--ref", "--runtime"]);',
  "const args = process.argv.slice(2);",
  "for (let index = 1; index < args.length; index += 2) {",
  '  if (args[0] !== "install" || !valued.has(args[index])) {',
  "    process.stderr.write(`unknown argument: ${args[index]}\\n`);",
  "    process.exit(2);",
  "  }",
  "}",
  'process.stdout.write(`OLD STAGE1 ${args.join(" ")}\\n`);',
  "",
].join("\n");

async function stageOneSource(directory: string, pins: string, stageOne: string): Promise<string> {
  const source = await pinsOnlySource(directory, pins);
  await writeFile(path.join(source, "scripts", "standalone", "manage.ts"), stageOne);
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", "stage 1"]);
  return source;
}

test("install.sh refuses an app without installer_protocol before downloading Node", async (t) => {
  const basePath = "/usr/bin:/bin";
  if ((await onPath("node", basePath)) || !(await onPath("git", basePath))) {
    t.skip("needs git but no node in /usr/bin:/bin");
    return;
  }
  const directory = await scratch(t);
  const source = await stageOneSource(
    directory,
    pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY),
    PROTOCOL_ONE_STAGE_ONE,
  );
  const binDir = path.join(directory, "bin");
  const installSh = (home: string) =>
    runFile(
      "/bin/sh",
      [INSTALL_SH, "--home", home, "--bin-dir", binDir, "--source", source, "--ref", "main"],
      {
        env: {
          HOME: path.join(directory, "user-home"),
          PATH: basePath,
          CHOCO_PI_NODE_MIRROR: pathToFileURL(path.join(directory, "no-node")).href,
        },
      },
    ).then(
      () => null,
      (error: Failure) => error,
    );
  const refusal =
    /the app at main \([0-9a-f]{12}\) predates standalone installer protocol 3 \(it declares none\); install it with that revision's own install\.sh/;

  const home = path.join(directory, "home");
  const fresh = await installSh(home);
  assert.ok(fresh !== null, "install.sh must fail");
  assert.equal(fresh.code, 1);
  assert.match(String(fresh.stderr), refusal);
  assert.doesNotMatch(
    String(fresh.stdout) + String(fresh.stderr),
    /downloading Node|download failed|STAGE1/,
  );
  assert.equal(await exists(path.join(home, "runtime", "node")), false, "no Node provisioned");
  assert.equal(await exists(home), false, "the clone, journal and new home are removed");

  const kept = path.join(directory, "kept");
  await runFile("git", ["clone", "--quiet", source, path.join(kept, "app")]);
  const existing = await installSh(kept);
  assert.ok(existing !== null, "install.sh must fail");
  assert.match(String(existing.stderr), refusal);
  assert.equal(await exists(path.join(kept, "app", ".git")), true);
  assert.equal(await exists(path.join(kept, "runtime")), false, "no Node provisioned");
  assert.equal(await exists(path.join(kept, PROVENANCE_NAME)), false);
});

test("install.sh refuses an app that needs a newer installer protocol before downloading Node", async (t) => {
  if (!(await onPath("git", "/usr/bin:/bin"))) {
    t.skip("needs git in /usr/bin:/bin");
    return;
  }
  const directory = await scratch(t);
  const source = await stageOneSource(
    directory,
    `installer_protocol ${INSTALLER_PROTOCOL + 1}\n${pinsText("24.0.0", "0".repeat(64), ZERO_INTEGRITY)}`,
    PROTOCOL_ONE_STAGE_ONE,
  );
  const home = path.join(directory, "home");
  const failure = await runFile(
    "/bin/sh",
    [INSTALL_SH, "--home", home, "--bin-dir", path.join(directory, "bin"), "--source", source],
    {
      env: {
        HOME: path.join(directory, "user-home"),
        PATH: "/usr/bin:/bin",
        CHOCO_PI_NODE_MIRROR: pathToFileURL(path.join(directory, "no-node")).href,
      },
    },
  ).then(
    () => null,
    (error: Failure) => error,
  );
  assert.ok(failure !== null, "install.sh must fail");
  assert.equal(failure.code, 1);
  assert.match(
    String(failure.stderr),
    new RegExp(
      `needs installer protocol ${INSTALLER_PROTOCOL + 1}, but this install\\.sh supports only ${INSTALLER_PROTOCOL}; .*${literal(path.join(home, "app", "install.sh"))}`,
    ),
  );
  assert.doesNotMatch(String(failure.stdout), /downloading Node|STAGE1/);
  assert.equal(await exists(path.join(home, "runtime")), false, "nothing provisioned");
  assert.deepEqual(
    (await readProvenance(home, null)).accepted,
    [path.join(home, "app")],
    "the clone stays owned for the matching installer",
  );
});

async function installedFixture(t: test.TestContext) {
  const directory = await scratch(t);
  const { environment } = await fixtureEnvironment(directory);
  const source = await fixtureSource(directory);
  const registry = await fixturePnpmRegistry(directory, source, environment);
  if (registry === null) return null;
  await commitFixture(source, directory, environment);
  const home = path.join(directory, "choco");
  const binDir = path.join(directory, "bin");
  const app = path.join(home, "app");
  await runFile("git", ["clone", "--quiet", "--no-hardlinks", source, app]);
  await stageOneInstall(app, home, binDir, source, environment);
  const launcherEnvironment = {
    ...environment,
    PATH: "/usr/bin:/bin",
    CHOCO_PI_NPM_REGISTRY: registry,
  };
  const launcher = path.join(binDir, "choco-pi");
  const selfUpdate = (extra: readonly string[] = []) =>
    runFile(launcher, ["self", "update", ...extra], {
      env: launcherEnvironment,
      timeout: 180_000,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error: Failure) => ({
        code: error.code ?? -1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );
  const head = async () => (await runFile("git", ["-C", app, "rev-parse", "HEAD"])).stdout.trim();
  const version = async () =>
    (await runFile(launcher, ["--version"], { env: launcherEnvironment })).stdout.trim();
  return { source, home, app, selfUpdate, head, version };
}

async function commitSource(source: string, message: string): Promise<string> {
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", message]);
  return (await runFile("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
}

test("self update runs the target's own installer, so it crosses a pins format the running code rejects", async (t) => {
  const skipReason = await pinnedPnpmMissing();
  if (skipReason !== null) {
    t.skip(skipReason);
    return;
  }
  const fixture = await installedFixture(t);
  if (fixture === null) {
    t.skip("no pnpm pin for this platform");
    return;
  }
  const pinsFile = path.join(fixture.source, "scripts", "standalone", "runtime-pins.txt");
  const provisionFile = path.join(fixture.source, "scripts", "standalone", "provision.ts");
  const skipLine = 'if (line === "" || line.startsWith("#")) continue;';
  const provision = await readFile(provisionFile, "utf8");
  assert.ok(provision.includes(skipLine), "the fixture parser has the comment skip to extend");
  await writeFile(
    provisionFile,
    provision.replace(skipLine, `${skipLine}\n    if (line.startsWith("future_pin ")) continue;`),
  );
  await appendFile(pinsFile, "future_pin in a format the installed code does not know\n");
  const targetPins = await readFile(pinsFile, "utf8");
  assert.throws(() => parseRuntimePins(targetPins), /malformed runtime pin line: future_pin/);
  const target = await commitSource(fixture.source, "new pins format");

  const update = await fixture.selfUpdate();
  assert.equal(update.code, 0, update.output);
  assert.match(
    update.output,
    new RegExp(`updated [0-9a-f]{12} -> ${target.slice(0, 12)} \\(main\\)`),
  );
  assert.equal(await fixture.head(), target);
  assert.equal((await readManifest(fixture.home)).rev, target);
  assert.equal(await fixture.version(), "1.6.0");
});

test("a failed self update reinstalls the old revision with its own installer, even after its ref is gone, and keeps what the failed run created", async (t) => {
  const skipReason = await pinnedPnpmMissing();
  if (skipReason !== null) {
    t.skip(skipReason);
    return;
  }
  const fixture = await installedFixture(t);
  if (fixture === null) {
    t.skip("no pnpm pin for this platform");
    return;
  }
  const before = await readManifest(fixture.home);
  const oldRev = await fixture.head();
  await writeFile(
    path.join(fixture.source, "scripts", "install-profile.ts"),
    'export async function installProfile(): Promise<never> {\n  throw new Error("target setup fails");\n}\n',
  );
  const target = await commitSource(fixture.source, "broken setup");
  await runFile("git", ["-C", fixture.source, "branch", "--move", "main", "replacement"]);

  const update = await fixture.selfUpdate(["--ref", "replacement"]);
  assert.equal(update.code, 1, update.output);
  assert.match(update.output, /target setup fails/, "the target's stage 1 ran and failed");
  assert.match(update.output, new RegExp(`update to ${target.slice(0, 12)} failed`));
  assert.match(update.output, new RegExp(`update failed; restored ${oldRev.slice(0, 12)}`));
  assert.equal(await fixture.head(), oldRev);
  const after = await readManifest(fixture.home);
  assert.equal(after.rev, oldRev);
  assert.equal(after.ref, before.ref);
  const pnpmDirectory = path.join(fixture.home, "runtime", "pnpm");
  assert.equal(before.created.includes(pnpmDirectory), false);
  assert.ok(after.created.includes(pnpmDirectory), "the failed run's pnpm is owned");
  assert.equal(await exists(path.join(fixture.home, PROVENANCE_NAME)), false, "journal merged");
  assert.equal(await fixture.version(), "1.6.0");
});

test("self update refuses a target older than the installer hand-off before it moves anything", async (t) => {
  const skipReason = await pinnedPnpmMissing();
  if (skipReason !== null) {
    t.skip(skipReason);
    return;
  }
  const fixture = await installedFixture(t);
  if (fixture === null) {
    t.skip("no pnpm pin for this platform");
    return;
  }
  const manifestFile = path.join(fixture.home, "install.json");
  const manifestBefore = await readFile(manifestFile, "utf8");
  const oldRev = await fixture.head();
  const pinsFile = path.join(fixture.source, "scripts", "standalone", "runtime-pins.txt");
  const pins = await readFile(pinsFile, "utf8");
  assert.match(pins, /^installer_protocol 3$/m);
  await writeFile(pinsFile, pins.replace(/^installer_protocol 3$/m, "installer_protocol 2"));
  await commitSource(fixture.source, "older protocol");

  const update = await fixture.selfUpdate();
  assert.equal(update.code, 1, update.output);
  assert.match(update.output, /declares installer_protocol 2, older than 3/);
  assert.doesNotMatch(update.output, /choco-pi install:/, "no installer ran");
  assert.equal(await fixture.head(), oldRev);
  assert.equal(await readFile(manifestFile, "utf8"), manifestBefore);
});

test("the management CLI answers usage errors with exit 2 and --help with exit 0", async () => {
  const manage = path.join(ROOT, "scripts", "standalone", "manage.ts");
  const run = (args: readonly string[]) =>
    runFile(process.execPath, [manage, ...args]).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: Failure) => ({
        code: error.code ?? -1,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
      }),
    );
  for (const args of [
    ["self", "update", "--bogus"],
    ["self", "update", "--ref"],
    ["self", "nope"],
    ["self", "update", "--ref="],
    ["self", "update", "--ref", ""],
    ["self", "setup", "--import-pi-settings", "--from="],
    ["install", "--home="],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, /^Usage: /m, args.join(" "));
  }
  const help = await run(["self", "update", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--ref/);
});

test("pruneOrphanedPackageDirs removes leftover removed-package node_modules without touching live or custom dirs", async (context) => {
  const app = await mkdtemp(path.join(tmpdir(), "choco-pi-prune-orphans-"));
  context.after(() => rm(app, { recursive: true, force: true }));
  const orphan = path.join(app, "packages", "choco-pi-web-access");
  const emptyOrphan = path.join(app, "packages", "removed-empty");
  const active = path.join(app, "packages", "choco-pi-web-search");
  const custom = path.join(app, "packages", "user-notes");
  await mkdir(path.join(orphan, "node_modules", "pkg"), { recursive: true });
  await mkdir(emptyOrphan, { recursive: true });
  await mkdir(path.join(active, "node_modules"), { recursive: true });
  await writeFile(path.join(active, "package.json"), "{}", "utf8");
  await mkdir(custom, { recursive: true });
  await writeFile(path.join(custom, "notes.txt"), "keep", "utf8");

  const removed = await pruneOrphanedPackageDirs(app);
  const pathExists = (target: string) =>
    lstat(target).then(
      () => true,
      () => false,
    );
  assert.deepEqual(removed.sort(), [orphan, emptyOrphan].sort());
  assert.equal(await pathExists(orphan), false);
  assert.equal(await pathExists(emptyOrphan), false);
  assert.equal(await pathExists(active), true);
  assert.equal(await pathExists(custom), true);
});
