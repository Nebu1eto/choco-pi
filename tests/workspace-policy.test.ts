import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compile, map, obj, opt, str, type Static } from "@earendil-works/pi-schema";

const run = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const EXACT_PACKAGE_MANAGER = "pnpm@11.11.0";
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

test("the root pins the exact pnpm toolchain and runs no install hook", async () => {
  const manifest = await readManifest("package.json");
  assert.equal(manifest.packageManager, EXACT_PACKAGE_MANAGER);
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
