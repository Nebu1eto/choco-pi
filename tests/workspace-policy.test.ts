import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compile, map, obj, opt, str, type Static } from "@earendil-works/pi-schema";

const run = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const MEMBER_COUNT = 18;

const ManifestSchema = obj(
  { packageManager: opt(str()), scripts: opt(map(str())) },
  { open: true },
);
const checkManifest = compile(ManifestSchema).check;
type Manifest = Static<typeof ManifestSchema>;

async function readText(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

async function readManifest(path: string): Promise<Manifest> {
  const parsed: unknown = JSON.parse(await readText(path));
  assert.ok(checkManifest(parsed), `${path} is not a package manifest`);
  return parsed;
}

/** Top-level YAML block keys of pnpm-workspace.yaml mapped to their indented lines. */
function workspaceBlocks(text: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const top = /^(\S[^:]*):\s*$/.exec(line);
    if (top?.[1]) {
      current = [];
      blocks.set(top[1], current);
      continue;
    }
    assert.ok(current && /^\s/.test(line), `unexpected workspace line: ${line}`);
    current.push(line.trim());
  }
  return blocks;
}

async function members(): Promise<string[]> {
  const entries = await readdir(new URL("packages/", ROOT), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(new URL(`packages/${entry.name}/`, ROOT));
    if (files.includes("package.json")) names.push(entry.name);
  }
  return names.sort();
}

/**
 * `key = "value"` pairs of one TOML table. Strict mode rejects any other line in it, which is
 * the whole of mise.toml's [tools]; mise.lock tables also hold arrays, which are skipped.
 */
function tomlTable(text: string, table: string, strict: boolean): Map<string, string> {
  const values = new Map<string, string>();
  let inside = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(trimmed);
    if (header) {
      inside = header[1] === table;
      continue;
    }
    if (!inside) continue;
    const pair = /^([\w.-]+|"[^"]+")\s*=\s*"([^"]*)"$/.exec(trimmed);
    if (pair?.[1] && pair[2] !== undefined) values.set(pair[1].replace(/^"|"$/g, ""), pair[2]);
    else assert.ok(!strict, `unexpected [${table}] line: ${line}`);
  }
  return values;
}

/** The tools mise.toml pins, by tool name. */
async function miseTools(): Promise<Map<string, string>> {
  return tomlTable(await readText("mise.toml"), "tools", true);
}

/**
 * Lines of a mise.toml outside the tools-only grammar: comments and blank lines, then one
 * `[tools]` header, then `name = "x.y.z"` pins. Every other line is reported, however it is
 * indented: another table, a dotted key, an inline table, or a template can make mise run
 * code or require `mise trust`.
 */
function miseConfigViolations(text: string): string[] {
  const violations: string[] = [];
  let tools = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!tools && trimmed === "[tools]") tools = true;
    else if (!tools || !/^[a-z][a-z0-9-]* = "\d+\.\d+\.\d+"$/.test(trimmed)) violations.push(line);
  }
  if (!tools) violations.push("(no [tools] table)");
  return violations;
}

/** `key value` pairs of scripts/standalone/runtime-pins.txt. */
async function runtimePins(): Promise<Map<string, string>> {
  const pins = new Map<string, string>();
  for (const line of (await readText("scripts/standalone/runtime-pins.txt")).split("\n")) {
    const match = /^(\S+) (\S+)$/.exec(line.trim());
    if (match?.[1] && match[2]) pins.set(match[1], match[2]);
  }
  return pins;
}

/** The lockfile's first YAML document: the self-lock pnpm 12 writes for packageManager. */
function selfLock(lockfile: string): string | undefined {
  const documents = lockfile.split(/^---$/m);
  return documents[0]?.trim() === "" ? documents[1] : undefined;
}

/** Whether a self-lock packages or snapshots key names pnpm or a pnpm platform binary at `version`. */
function isPnpmEntry(line: string, version: string): boolean {
  const key = /^  (?:'([^']+)'|([^'\s]+)):$/.exec(line);
  const name = key?.[1] ?? key?.[2] ?? "";
  if (!name.endsWith(`@${version}`)) return false;
  const bare = name.slice(0, -version.length - 1);
  return bare === "pnpm" || /^@pnpm\/exe\.[a-z0-9-]+$/.test(bare);
}

/** The field lines pnpm 12 writes under its own packages and snapshots entries. */
const SELF_LOCK_FIELDS = [
  /^    resolution: \{integrity: sha512-[A-Za-z0-9+/]{86}==\}$/,
  /^    engines: \{node: '>=\d+'\}$/,
  /^    (?:hasBin|optional): true$/,
  /^    (?:cpu|os|libc): \[[\w-]+\]$/,
  /^    optionalDependencies:$/,
];

/** Whether a self-lock line is allowed below a packages or snapshots key at `version`. */
function isPnpmField(line: string, version: string): boolean {
  if (SELF_LOCK_FIELDS.some((field) => field.test(line))) return true;
  const binary = /^      '@pnpm\/exe\.[a-z0-9-]+': (\S+)$/.exec(line);
  return binary?.[1] === version;
}

/**
 * Why a lockfile's self-lock differs from the one pnpm 12 writes when it locks only itself at
 * `version`, or undefined when it matches. The top-level lines and the importers block must be
 * that output byte for byte, and packageManagerDependencies may appear only once. Every
 * packages or snapshots line must be a pnpm or pnpm platform binary key, or a field pnpm 12
 * writes for them. Any other dependency, importer, document, or placement fails instead of
 * being parsed around; YAML that pnpm itself refuses, such as a duplicated key, is left to
 * its frozen install.
 */
function selfLockMismatch(lockfile: string, version: string): string | undefined {
  if (lockfile.split(/^---$/m).length !== 3) return "the lockfile must hold exactly two documents";
  const text = selfLock(lockfile);
  if (text === undefined) return "no self-lock document";
  const lines = text.split("\n");
  const topLevel = lines.filter((line) => /^\S/.test(line));
  const keys = ["lockfileVersion: '9.0'", "importers:", "packages:", "snapshots:"];
  if (topLevel.join("\n") !== keys.join("\n")) return `top-level lines: ${topLevel.join(" | ")}`;
  const importers = /^importers:\n[\s\S]*?(?=^\S)/m.exec(text)?.[0];
  const root = [
    "importers:",
    "",
    "  .:",
    "    configDependencies: {}",
    "    packageManagerDependencies:",
    "      pnpm:",
    `        specifier: ${version}`,
    `        version: ${version}`,
    "",
    "",
  ].join("\n");
  if (importers !== root) return `importers block: ${JSON.stringify(importers)}`;
  if (text.split("packageManagerDependencies").length !== 2) {
    return "packageManagerDependencies outside the root importer";
  }
  const unexpected = lines
    .slice(lines.indexOf("packages:"))
    .filter((line) => /^\s+\S/.test(line))
    .filter((line) => !isPnpmEntry(line, version) && !isPnpmField(line, version));
  return unexpected.length > 0 ? `unexpected lines: ${unexpected.join(" | ")}` : undefined;
}

test("mise.toml pins only tools, as exact versions", async () => {
  assert.deepEqual(miseConfigViolations(await readText("mise.toml")), []);
  const tools = await miseTools();
  assert.deepEqual([...tools.keys()].sort(), ["node", "pnpm"]);
});

test("the mise.toml check rejects everything beyond exact tool pins", () => {
  const pins = '[tools]\nnode = "24.22.3"\npnpm = "12.21.0"\n';
  assert.deepEqual(miseConfigViolations(pins), []);
  const extras = [
    ' [env]\nNODE_OPTIONS = "--require=./hook.cjs"',
    'env.NODE_OPTIONS = "--require=./hook.cjs"',
    "[[hooks.enter]]",
    'bun = "{{ env.BUN_VERSION }}"',
    'bun = { version = "1.4.4" }',
    'bun = "latest"',
    "[tools]",
  ];
  for (const extra of extras)
    assert.notDeepEqual(miseConfigViolations(`${pins}${extra}\n`), [], extra);
  assert.notDeepEqual(miseConfigViolations(`[env]\nX = "1"\n${pins}`), []);
  assert.notDeepEqual(miseConfigViolations("# comments only\n"), []);
});

test("the self-lock check accepts only what pnpm 12 writes to lock itself", () => {
  const version = "12.21.0";
  const lockfile = (text: string): string => `---\n${text}\n---\nlockfileVersion: '9.0'\n`;
  const pnpmLock = `      pnpm:\n        specifier: ${version}\n        version: ${version}\n`;
  const managers = "    packageManagerDependencies:\n";
  const integrity = `sha512-${"A".repeat(86)}==`;
  const pnpmOnly = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    configDependencies: {}",
    `${managers}${pnpmLock}`,
    "packages:",
    "",
    `  pnpm@${version}:`,
    `    resolution: {integrity: ${integrity}}`,
    "",
    `  '@pnpm/exe.darwin-arm64@${version}':`,
    `    resolution: {integrity: ${integrity}}`,
    "",
    "snapshots:",
    "",
    `  pnpm@${version}:`,
    "    optionalDependencies:",
    `      '@pnpm/exe.darwin-arm64': ${version}`,
    "",
  ].join("\n");
  assert.equal(selfLockMismatch(lockfile(pnpmOnly), version), undefined);
  assert.notEqual(selfLockMismatch(lockfile(pnpmOnly), "12.18.0"), undefined);
  const exe = `      '@pnpm/exe':\n        specifier: ${version}\n        version: ${version}\n`;
  const variants = [
    pnpmOnly.replace(managers, `${managers}${exe}`),
    pnpmOnly.replace(
      pnpmLock,
      `${pnpmLock}      '@pnpm/exe': {specifier: ${version}, version: ${version}}\n`,
    ),
    pnpmOnly.replace(pnpmLock, `${pnpmLock}      "@pnpm/exe":\n        specifier: ${version}\n`),
    pnpmOnly.replace("importers:\n\n", `importers:\n\n  decoy:\n${managers}${pnpmLock}\n`),
    pnpmOnly.replace(
      `${managers}${pnpmLock}`,
      `    packageManagerDependencies: {pnpm: {specifier: ${version}, version: ${version}}}\n`,
    ),
    pnpmOnly
      .replace(`${managers}${pnpmLock}`, "")
      .replace("packages:\n", `decoy:\n  packageManagerDependencies:\n${pnpmLock}\npackages:\n`),
    pnpmOnly.replace(`${managers}${pnpmLock}`, ""),
    pnpmOnly.replace(
      "    optionalDependencies:\n",
      `${managers}      pnpm: ${version}\n    optionalDependencies:\n`,
    ),
    pnpmOnly.replace(
      "snapshots:\n",
      `  '@pnpm/exe@${version}':\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n`,
    ),
    pnpmOnly.replace(`specifier: ${version}`, `specifier: ^${version}`),
    pnpmOnly.replaceAll("\n", "\r\n"),
    pnpmOnly.replace(
      "    optionalDependencies:\n",
      "    dependencies:\n      extra: 1.0.0\n    optionalDependencies:\n",
    ),
    pnpmOnly.replace(
      "packages:\n\n",
      "packages:\n\n  extra@1.0.0: {resolution: {integrity: sha512-extra}}\n\n",
    ),
    pnpmOnly.replace(`'@pnpm/exe.darwin-arm64': ${version}`, "'@pnpm/exe.darwin-arm64': 12.18.0"),
    pnpmOnly.replace(
      `    resolution: {integrity: ${integrity}}`,
      `    resolution: {integrity: ${integrity}} # pinned`,
    ),
    pnpmOnly.replace(integrity, "sha512-A"),
    `${pnpmOnly}---\nextra: true\n`,
  ];
  for (const variant of variants) {
    assert.notEqual(selfLockMismatch(lockfile(variant), version), undefined, variant);
  }
});

test("mise, package.json, the lockfile, and the runtime pins name one toolchain", async () => {
  const tools = await miseTools();
  const pnpm = tools.get("pnpm");
  assert.ok(pnpm, "mise.toml pins pnpm");
  const manifest = await readManifest("package.json");
  assert.equal(manifest.packageManager, `pnpm@${pnpm}`);
  // pnpm 12 locks only itself here. An older pnpm that switches to the pinned
  // version adds @pnpm/exe, which pnpm 12 then keeps: revert that change.
  assert.equal(selfLockMismatch(await readText("pnpm-lock.yaml"), pnpm), undefined);
  assert.equal(tools.get("node"), (await runtimePins()).get("node_version"));
});

test("mise.lock locks the mise.toml versions and the runtime-pins Node checksums", async () => {
  const lock = await readText("mise.lock");
  const tools = await miseTools();
  for (const name of ["node", "pnpm"]) {
    assert.equal(tomlTable(lock, `tools.${name}`, false).get("version"), tools.get(name), name);
  }
  const pins = await runtimePins();
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
    const table = `tools.node."platforms.${platform.replace("darwin", "macos")}"`;
    assert.equal(
      tomlTable(lock, table, false).get("checksum"),
      `sha256:${pins.get(`node_sha256_${platform}`)}`,
      platform,
    );
  }
});

test("the workspace includes every bundled package through one packages glob", async () => {
  const blocks = workspaceBlocks(await readText("pnpm-workspace.yaml"));
  assert.deepEqual(blocks.get("packages"), ["- packages/*"]);
  assert.equal((await members()).length, MEMBER_COUNT);
});

test("members carry no lockfile, workspace file, or package manager pin", async () => {
  for (const name of await members()) {
    const files = await readdir(new URL(`packages/${name}/`, ROOT));
    assert.ok(!files.includes("pnpm-lock.yaml"), `${name} must not keep its own lockfile`);
    assert.ok(!files.includes("pnpm-workspace.yaml"), `${name} must not keep a workspace file`);
    const manifest = await readManifest(`packages/${name}/package.json`);
    assert.equal(manifest.packageManager, undefined, name);
  }
});

test("the root pins an exact pnpm toolchain and runs no install hook", async () => {
  const manifest = await readManifest("package.json");
  assert.match(manifest.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, hook);
  }
});

test("no dependency build script is allowed to run", async () => {
  const allowBuilds = workspaceBlocks(await readText("pnpm-workspace.yaml")).get("allowBuilds");
  assert.ok(
    allowBuilds && allowBuilds.length > 0,
    "allowBuilds lists the packages with build scripts",
  );
  for (const entry of allowBuilds) {
    assert.match(entry, /^("[^"]+"|[^\s:]+): false$/, entry);
  }
});

test("no tracked file remains under .pi/", async () => {
  const { stdout } = await run("git", ["ls-files", "-z", "--", ".pi"], {
    cwd: fileURLToPath(ROOT),
  });
  assert.equal(stdout, "");
});
