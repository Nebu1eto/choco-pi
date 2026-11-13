import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  ChecksumMismatchError,
  extractVerifiedArchive,
  findSystemPnpm,
  parseIntegrity,
  parseRuntimePins,
  pnpmVersionQualifies,
  provisionPrivatePnpm,
  readRuntimePins,
  sha256Expected,
  type RuntimePins,
} from "../scripts/standalone/provision.ts";

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

function pinsText(nodeVersion: string, nodeSha256: string, pnpmIntegrity: string): string {
  const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
  return [
    `node_version ${nodeVersion}`,
    ...platforms.map((platform) => `node_sha256_${platform} ${nodeSha256}`),
    "pnpm_version 11.11.0",
    `pnpm_integrity ${pnpmIntegrity}`,
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
  assert.throws(() => parseRuntimePins("node_version 22.1.0\n"), /24\.x\.y/);
  assert.throws(
    () => parseRuntimePins(pinsText("24.0.0", "0".repeat(64), "sha1-abc")),
    /unsupported integrity/,
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
    const source = await pinsOnlySource(path.join(directory, label), pins);
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
  const entry = await provisionPrivatePnpm(
    runtime,
    pinsFor(integrity),
    pathToFileURL(registry).href,
  );
  assert.equal(entry, path.join(runtime, "pnpm", "bin", "pnpm.mjs"));
  await rm(registry, { recursive: true });
  assert.equal(
    await provisionPrivatePnpm(runtime, pinsFor(integrity), pathToFileURL(registry).href),
    entry,
    "re-run reuses it",
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

test("stage 1 install is idempotent, updates by fast-forward, and uninstall removes exactly what it recorded", async (t) => {
  const pnpmVersion = await runFile("pnpm", ["--version"]).then(
    ({ stdout }) => stdout.trim(),
    () => null,
  );
  if (pnpmVersion !== "11.11.0") {
    t.skip(`needs pnpm 11.11.0 on PATH (found ${pnpmVersion ?? "none"})`);
    return;
  }
  const directory = await scratch(t);
  const userHome = path.join(directory, "user-home");
  await mkdir(userHome);
  const runtimeDirs = [
    `--config.store-dir=${path.join(directory, "lock-store")}`,
    `--config.cache-dir=${path.join(directory, "lock-cache")}`,
    `--config.state-dir=${path.join(directory, "lock-state")}`,
  ];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userHome,
    PATH: `${NODE_DIR}:${process.env.PATH ?? ""}`,
  };
  delete environment.CHOCO_PI_HOME;
  const source = await fixtureSource(directory);
  await runFile("pnpm", ["install", "--lockfile-only", ...runtimeDirs], {
    cwd: source,
    env: environment,
  });
  await runFile("git", ["init", "--quiet", "--initial-branch=main", source]);
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", "fixture"]);

  const home = path.join(directory, "choco");
  const binDir = path.join(directory, "bin");
  const app = path.join(home, "app");
  await runFile("git", ["clone", "--quiet", "--no-hardlinks", source, app]);
  const install = async () => {
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
    const { stdout } = await runFile(process.execPath, args, {
      env: environment,
      timeout: 120_000,
    });
    return stdout;
  };
  const first = await install();
  assert.match(first, /created: .*choco-pi ->/);
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
  const again = parseInstallManifest(
    await readFile(path.join(home, "install.json"), "utf8"),
    "install.json",
  );
  assert.deepEqual({ ...again, updated_at: "" }, { ...manifest, updated_at: "" });
  assert.deepEqual(await snapshot(home), tree, "re-run creates nothing new");

  await writeFile(path.join(source, "CHANGELOG"), "next\n");
  await runFile("git", ["-C", source, "add", "-A"]);
  await runFile("git", ["-C", source, ...GIT_IDENTITY, "commit", "--quiet", "-m", "next"]);
  const head = (await runFile("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
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
