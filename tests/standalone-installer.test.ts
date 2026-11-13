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
import {
  manifestProblems,
  parseInstallManifest,
  type InstallManifest,
} from "../scripts/standalone/install-manifest.ts";
import { isOurLink, linkLauncher } from "../scripts/standalone/manage.ts";
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
  extractVerifiedArchive,
  findSystemPnpm,
  INSTALLER_PROTOCOL,
  parseIntegrity,
  parseRuntimePins,
  pnpmVersionQualifies,
  provisionPrivateBun,
  provisionPrivatePnpm,
  readRuntimePins,
  sha256Expected,
  UNZIP_GUIDANCE,
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

/** Packs `files` (relative path -> contents) under `top/` into a .tar.gz. */
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
    "pnpm_version 11.11.0",
    `pnpm_integrity ${pnpmIntegrity}`,
    "bun_version 1.4.4",
    "bun_minimum_version 1.4.4",
    ...BUN_PLATFORMS.map((platform) => `bun_sha256_${platform} ${bunSha256}`),
    "",
  ].join("\n");
}

const ZERO_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;

test("the shipped pins parse and match package.json's pnpm", async () => {
  const pins = await readRuntimePins();
  assert.match(pins.nodeVersion, /^24\.\d+\.\d+$/);
  assert.equal(pins.nodeSha256.size, 4);
  const manifest: unknown = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const declared =
    manifest instanceof Object && "packageManager" in manifest ? manifest.packageManager : null;
  assert.equal(declared, `pnpm@${pins.pnpmVersion}`);
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

/** A git source whose only content is a pins file; enough for install.sh stage 0. */
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
});

test("the private pnpm is verified against the pinned integrity before extraction", async (t) => {
  const directory = await scratch(t);
  const registry = path.join(directory, "registry");
  const archive = path.join(registry, "pnpm", "-", "pnpm-11.11.0.tgz");
  await fixtureTarball(
    directory,
    "package",
    new Map([
      ["package.json", JSON.stringify({ name: "pnpm", version: "11.11.0" })],
      ["bin/pnpm.mjs", "console.log('11.11.0');\n"],
    ]),
    archive,
  );
  const integrity = `sha512-${(await sha(archive, "sha512")).toString("base64")}`;
  assert.deepEqual(parseIntegrity(integrity).digest, await sha(archive, "sha512"));
  const pinsFor = (value: string): RuntimePins =>
    parseRuntimePins(pinsText("24.0.0", "0".repeat(64), value));
  const runtime = path.join(directory, "runtime");
  await mkdir(runtime);
  await assert.rejects(
    provisionPrivatePnpm(runtime, pinsFor(ZERO_INTEGRITY), pathToFileURL(registry).href),
    ChecksumMismatchError,
  );
  assert.deepEqual(await readdir(runtime), [], "nothing extracted after a mismatch");
  const provisioned = await provisionPrivatePnpm(
    runtime,
    pinsFor(integrity),
    pathToFileURL(registry).href,
  );
  const entry = provisioned.path;
  assert.equal(entry, path.join(runtime, "pnpm", "bin", "pnpm.mjs"));
  assert.deepEqual(provisioned.created, [path.join(runtime, "pnpm")]);
  await rm(registry, { recursive: true });
  assert.deepEqual(
    await provisionPrivatePnpm(runtime, pinsFor(integrity), pathToFileURL(registry).href),
    { path: entry, created: [] },
    "re-run reuses it and creates nothing",
  );
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

/** A fake bun: answers the installer's probe as `version`, prints Pi's 1.5.2 for --version, else its argv. */
function fakeBunScript(version: string): string {
  return [
    "#!/bin/sh",
    `if [ "$1" = --no-env-file ] && [ "$2" = -e ]; then printf '%s\\n%s' '${version}' "$0"; exit 0; fi`,
    'for a; do [ "$a" != --version ] || { echo 1.5.2; exit 0; }; done',
    'echo "FAKEBUN $*"',
    "",
  ].join("\n");
}

/** Zips a fake bun as `bun-<platform>/bun`, the layout of Bun's release assets. */
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
  assert.equal((await runFile(binary, ["--version"])).stdout.trim(), "1.5.2");
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

/** A git-managed fixture app: the real launcher and management code, a stub Pi and a stub profile installer. */
async function fixtureSource(directory: string): Promise<string> {
  const source = path.join(directory, "source");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await cp(path.join(ROOT, "bin", "choco-pi"), path.join(source, "bin", "choco-pi"));
  await cp(path.join(ROOT, "scripts", "standalone"), path.join(source, "scripts", "standalone"), {
    recursive: true,
  });
  // self setup applies the standalone settings seed.
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
      '  return { links: [], settingsPath: path.join(options.agentDir, "settings.json"), markerPath, removed: [], warnings: [] };',
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
      version: "1.5.2",
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  // Executable from the start: pnpm marks linked bins executable, which would dirty the tree.
  await writeFile(
    path.join(fakePi, "dist", "bundle", "cli.js"),
    'process.stdout.write("1.5.2\\n");\n',
    { mode: 0o755 },
  );
  const piSchema = await realpath(path.join(ROOT, "node_modules", "@earendil-works", "pi-schema"));
  await cp(piSchema, path.join(source, "vendor", "pi-schema"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      private: true,
      type: "module",
      packageManager: "pnpm@11.11.0",
      dependencies: {
        "@earendil-works/pi-coding-agent": "link:./fake-pi",
        "@earendil-works/pi-schema": "link:./vendor/pi-schema",
      },
    }),
  );
  await writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  return source;
}

async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => !entry.split(path.sep).includes("node_modules")).toSorted();
}

/** The skip reason when pnpm on PATH is not the pinned 11.11.0, else null. */
async function pinnedPnpmMissing(): Promise<string | null> {
  const version = await runFile("pnpm", ["--version"]).then(
    ({ stdout }) => stdout.trim(),
    () => null,
  );
  return version === "11.11.0" ? null : `needs pnpm 11.11.0 on PATH (found ${version ?? "none"})`;
}

/** A user home under `directory` and an environment that resolves node and pnpm. */
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
  return { userHome, environment };
}

/** Locks the fixture's dependencies and commits it as branch main. */
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
    env: environment,
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

/** Runs stage 1 the way install.sh does right after it cloned (and journaled) `app`. */
async function stageOneInstall(
  app: string,
  home: string,
  binDir: string,
  source: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (!(await exists(path.join(home, "install.json"))))
    await appendFile(path.join(home, PROVENANCE_NAME), `${app}\n`);
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
  return stdout;
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
  // The app's pins name a fixture Bun zip, served from a file: mirror below.
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
  const launcherEnvironment = { ...environment, PATH: "/usr/bin:/bin" };
  const version = await runFile(path.join(binDir, "choco-pi"), ["--version"], {
    env: launcherEnvironment,
  });
  assert.equal(version.stdout.trim(), "1.5.2");
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

  const launcherEnvironment = { ...environment, PATH: "/usr/bin:/bin" };
  const head = await commitChange(source);
  await runFile(path.join(binDir, "choco-pi"), ["self", "update"], {
    env: launcherEnvironment,
    timeout: 120_000,
  });
  const updated = await readManifest(home);
  assert.equal(updated.rev, head);
  // No pnpm on this PATH, so the update provisions (and owns) a private pnpm.
  assert.deepEqual(updated.created.slice(0, installed.created.length), installed.created);
  assert.equal(updated.created.includes(foreignBun), false, "update does not claim it either");

  await runFile(path.join(binDir, "choco-pi"), ["self", "uninstall"], { env: launcherEnvironment });
  assert.equal(await readFile(path.join(foreignBun, "unrelated"), "utf8"), "not the installer's\n");
  assert.deepEqual((await readdir(home)).toSorted(), ["agent", "runtime"]);
  assert.deepEqual(await readdir(path.join(home, "runtime")), ["bun"]);
});

/** Matches `text` literally inside a RegExp. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A stand-in node that answers install.sh's probes and prints the stage 1 command. */
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
  // The downloaded "Node.js" runs the real node, so stage 1 is the real manage.ts.
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
  // Stage 1 finds this pnpm on PATH; only pnpm itself sees a node on PATH.
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
    assert.equal(version.stdout.trim(), "1.5.2");
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

/** Runs `self uninstall` of this checkout's manage.ts against `home`, as the launcher would. */
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

/** An install home with an app and a runtime/node, and `<home>/alias` linked to a sibling. */
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

  // No install.json: only the journal records the install.
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

  // install.json lists the escaping path; app, runtime and the bin link still go.
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

/** Pins naming a fixture Node tarball (wrapping this node) served from a file: mirror. */
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
  // Stage 1 finds no pnpm on PATH and cannot download one from here.
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
  const pnpmDirectories = ["pnpm-store", "pnpm-cache", "pnpm-state"].map((entry) =>
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

  // An install abandoned after a failure is uninstalled from its journal alone.
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

/** A stage 1 that, like the one at a1a0efa0, rejects every argument it does not know. */
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

/** A git source holding only `pins` and `stageOne` as scripts/standalone/manage.ts. */
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
    /the app at main predates the standalone installer protocol .*that ref's own install\.sh/;

  // A fresh home: this run's clone, and the journal and home it made, are undone.
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

  // A checkout this run did not clone is left as it is.
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
      `needs installer protocol ${INSTALLER_PROTOCOL + 1}, but this install\\.sh supports up to ${INSTALLER_PROTOCOL}; .*${literal(path.join(home, "app", "install.sh"))}`,
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
