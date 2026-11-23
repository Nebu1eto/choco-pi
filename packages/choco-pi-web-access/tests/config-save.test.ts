import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-config-save-"));
const configPath = join(agentDir, "web-search.json");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { getCachedWebSearchConfig, saveWebSearchConfig } = await import("../config-loader.ts");
const { saveConfig } = await import("../extension-config.ts");

beforeEach(async () => {
  await rm(configPath, { recursive: true, force: true });
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

test("saving over malformed config rejects and leaves the file bytes untouched", async () => {
  const original = '{ "provider": "exa", broken\n';
  await writeFile(configPath, original, "utf8");
  await assert.rejects(saveWebSearchConfig({ workflow: "none" }), /Failed to parse/);
  assert.equal(await readFile(configPath, "utf8"), original);
  // The extension-level helper surfaces the same failure instead of discarding it.
  await assert.rejects(saveConfig({ workflow: "none" }), /Failed to parse/);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("saving over a non-object config rejects without rewriting it", async () => {
  const original = "[1, 2, 3]\n";
  await writeFile(configPath, original, "utf8");
  await assert.rejects(saveWebSearchConfig({ workflow: "none" }), /expected a JSON object/);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("non-ENOENT read errors reject without modifying the path", async () => {
  await mkdir(configPath);
  await assert.rejects(saveWebSearchConfig({ workflow: "none" }), /Failed to read/);
  assert.deepEqual(await readdir(configPath), []);
});

test("a missing config is created from the patch", async () => {
  await saveWebSearchConfig({ workflow: "none" });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { workflow: "none" });
});

test("concurrent saves of different keys all persist", async () => {
  await writeFile(configPath, JSON.stringify({ keep: true }) + "\n", "utf8");
  await Promise.all([
    saveWebSearchConfig({ provider: "exa" }),
    saveWebSearchConfig({ workflow: "none" }),
    saveConfig({ autoOpenBrowser: false }),
  ]);
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(persisted, {
    keep: true,
    provider: "exa",
    workflow: "none",
    autoOpenBrowser: false,
  });
  assert.deepEqual(getCachedWebSearchConfig(), persisted);
});

test("a failed save does not block later queued saves", async () => {
  await writeFile(configPath, "{ broken", "utf8");
  await assert.rejects(saveWebSearchConfig({ provider: "exa" }), /Failed to parse/);
  await writeFile(configPath, JSON.stringify({ keep: 1 }) + "\n", "utf8");
  await saveWebSearchConfig({ provider: "kagi" });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { keep: 1, provider: "kagi" });
});
