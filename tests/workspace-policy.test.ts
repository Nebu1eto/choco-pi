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

/** The pnpm version the lockfile's first YAML document locks under packageManagerDependencies. */
function lockedPackageManager(lockfile: string): string | undefined {
  const documents = lockfile.split(/^---$/m);
  const selfLock = documents[0]?.trim() === "" ? documents[1] : undefined;
  if (selfLock === undefined) return undefined;
  const match =
    /^( +)packageManagerDependencies:\n(?:\1 +.*\n)*?\1 +pnpm:\n\1 + +specifier: \S+\n\1 + +version: (\S+)$/m.exec(
      selfLock,
    );
  return match?.[2];
}

/**
 * The dependency names the lockfile's self-lock lists directly under packageManagerDependencies.
 * A direct line that is not a block-mapping key (an inline entry, odd indentation) is returned
 * as an "unsupported entry" so the caller's comparison fails instead of skipping it.
 */
function lockedPackageManagerNames(lockfile: string): string[] {
  const documents = lockfile.split(/^---$/m);
  const selfLock = documents[0]?.trim() === "" ? documents[1] : undefined;
  if (selfLock === undefined) return [];
  const lines = selfLock.split("\n");
  const start = lines.findIndex((line) => /^ +packageManagerDependencies:$/.test(line));
  if (start < 0) return [];
  const indent = (lines[start]?.length ?? 0) - (lines[start]?.trimStart().length ?? 0);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const depth = line.length - line.trimStart().length;
    if (depth <= indent) break;
    if (depth > indent + 2) continue;
    const entry = /^('?)([^':\s{}]+)\1:$/.exec(line.trim());
    names.push(depth === indent + 2 && entry?.[2] ? entry[2] : `unsupported entry: ${line.trim()}`);
  }
  return names;
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

test("the self-lock check rejects any dependency beside pnpm, in either YAML form", () => {
  const selfLock = (entries: string): string =>
    `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n${entries}\n\npackages: {}\n---\nlockfileVersion: '9.0'\n`;
  const pnpm = "      pnpm:\n        specifier: 12.21.0\n        version: 12.21.0";
  assert.deepEqual(lockedPackageManagerNames(selfLock(pnpm)), ["pnpm"]);
  assert.equal(lockedPackageManager(selfLock(pnpm)), "12.21.0");
  const extras = [
    "      '@pnpm/exe':\n        specifier: 12.21.0\n        version: 12.21.0",
    "      '@pnpm/exe': {specifier: 12.21.0, version: 12.21.0}",
    "     '@pnpm/exe':\n        specifier: 12.21.0",
  ];
  for (const extra of extras) {
    assert.notDeepEqual(lockedPackageManagerNames(selfLock(`${pnpm}\n${extra}`)), ["pnpm"], extra);
  }
});

test("mise, package.json, the lockfile, and the runtime pins name one toolchain", async () => {
  const tools = await miseTools();
  const pnpm = tools.get("pnpm");
  assert.ok(pnpm, "mise.toml pins pnpm");
  const manifest = await readManifest("package.json");
  assert.equal(manifest.packageManager, `pnpm@${pnpm}`);
  assert.equal(lockedPackageManager(await readText("pnpm-lock.yaml")), pnpm);
  // pnpm 12 locks only itself here. An older pnpm that switches to the pinned
  // version adds @pnpm/exe, which pnpm 12 then keeps: revert that change.
  assert.deepEqual(lockedPackageManagerNames(await readText("pnpm-lock.yaml")), ["pnpm"]);
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
