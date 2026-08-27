import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGlobalSettings, installProfile } from "../scripts/install-profile.mjs";

test("global settings preserve user preferences and dedupe every tracked local package", () => {
  const root = process.cwd();
  const settings = buildGlobalSettings(
    {
      packages: ["./packages/choco-pi-provider-synthetic", "./packages/choco-pi-lsp"],
      theme: "nord-dark",
    },
    {
      packages: [
        path.join("/old", ".pi", "packages", "choco-pi-provider-synthetic"),
        path.join("/old", ".pi", "packages", "choco-pi-lsp"),
        "npm:user-package",
      ],
      defaultModel: "user-model",
    },
    root,
  );

  assert.deepEqual(settings.packages, [
    path.resolve(".pi/packages/choco-pi-provider-synthetic"),
    path.resolve(".pi/packages/choco-pi-lsp"),
    "npm:user-package",
  ]);
  assert.equal(settings.defaultModel, "user-model");
});

test("tracked npm package pins dedupe stale older versions of the same package", () => {
  const settings = buildGlobalSettings(
    { packages: ["npm:example-extension@4.0.0", "npm:@example/subagents@0.16.1"] },
    {
      packages: [
        "npm:example-extension@3.8.74",
        "npm:@example/subagents@0.15.0",
        "npm:user-package",
      ],
    },
    process.cwd(),
  );

  assert.deepEqual(settings.packages, [
    "npm:example-extension@4.0.0",
    "npm:@example/subagents@0.16.1",
    "npm:user-package",
  ]);
});

test("user-added duplicate pins keep the newer version", () => {
  const settings = buildGlobalSettings(
    { packages: ["./packages/choco-pi-provider-synthetic"] },
    { packages: ["npm:user-package@1.0.0", "npm:user-package@1.2.0"] },
    process.cwd(),
  );

  assert.deepEqual(settings.packages, [
    path.resolve(".pi/packages/choco-pi-provider-synthetic"),
    "npm:user-package@1.2.0",
  ]);
});

test("profile installer links tracked config and is idempotent", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));

  await installProfile({ root: process.cwd(), agentDir });
  await installProfile({ root: process.cwd(), agentDir });

  assert.equal(
    await readlink(path.join(agentDir, "choco-pi-ui.json")),
    path.resolve(".pi/zentui.json"),
  );
  assert.equal(
    await readlink(path.join(agentDir, "choco-pi-codex.json")),
    path.resolve(".pi/choco-pi-codex.json"),
  );
  const codexConfig = JSON.parse(
    await readFile(path.join(agentDir, "choco-pi-codex.json"), "utf8"),
  );
  assert.equal(codexConfig.openai.fast, false);
  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(
    settings.packages,
    [
      "choco-pi-provider-synthetic",
      "choco-pi-ui",
      "choco-pi-shells",
      "choco-pi-hooks",
      "choco-pi-subagents",
      "choco-pi-goal",
      "choco-pi-mcp",
      "choco-pi-lsp",
      "choco-pi-codex",
      "choco-pi-agents-md",
      "choco-pi-web-access",
      "choco-pi-agent-browser",
      "choco-pi-computer-use",
    ].map((name) => path.resolve(".pi/packages", name)),
  );
  assert.deepEqual(settings.extensions, [path.resolve(".pi/extensions")]);
  assert.deepEqual(settings.modelThinkingLevels, {
    "anthropic/claude-fable-5": "high",
    "anthropic/claude-opus-5": "medium",
    "anthropic/claude-opus-4-6": "high",
    "anthropic/claude-sonnet-5": "xhigh",
    "openai-codex/gpt-5.6-sol": "low",
    "openai-codex/gpt-daybreak-blue-latest": "high",
    "openai-codex/gpt-5.6-terra": "high",
    "openai-codex/gpt-5.6-luna": "xhigh",
    "synthetic/hf:moonshotai/Kimi-K3": "high",
  });
});

test("profile installer preserves a conflicting file unless backup is explicit", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-conflict-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const target = path.join(agentDir, "choco-pi-ui.json");
  await writeFile(target, "user-owned\n");

  await assert.rejects(
    installProfile({ root: process.cwd(), agentDir }),
    /already exists; rerun with --backup/,
  );
  assert.equal(await readFile(target, "utf8"), "user-owned\n");
  await assert.rejects(readlink(path.join(agentDir, "SYSTEM.md")), { code: "ENOENT" });

  const result = await installProfile({ root: process.cwd(), agentDir, backup: true });
  const migrated = result.links.find((link) => link.target === target);
  assert.equal(migrated?.action, "backed-up");
  assert.equal(await readFile(migrated?.backup ?? "", "utf8"), "user-owned\n");
});

test("installing the profile removes the packages each bundled fork replaces", () => {
  const projectSettings = { packages: ["./packages/choco-pi-lsp", "./packages/choco-pi-ui"] };
  const existingSettings = {
    packages: [
      "npm:pi-lens@4.0.0",
      "/Users/someone/Workspace/choco-pi/.pi/packages/pi-zentui",
      "npm:@maddeye/pi-nord@1.0.0",
      "npm:pi-mono-figma",
    ],
  };

  const settings = buildGlobalSettings(projectSettings, existingSettings, "/repo", [
    "pi-lens",
    "pi-zentui",
    "@maddeye/pi-nord",
  ]);

  assert.deepEqual(settings.packages, [
    path.resolve("/repo/.pi/packages/choco-pi-lsp"),
    path.resolve("/repo/.pi/packages/choco-pi-ui"),
    "npm:pi-mono-figma",
  ]);
});

test("installing the profile drops another checkout's resource directories", () => {
  const projectSettings = { packages: [] };
  const existingSettings = {
    extensions: ["/Users/someone/Workspace/choco-pi/.pi/extensions", "/Users/someone/my-tools"],
    skills: ["/Users/someone/Workspace/choco-pi/.pi/skills"],
    prompts: [],
  };

  const settings = buildGlobalSettings(projectSettings, existingSettings, "/repo");

  // A previous checkout's .pi/extensions would load a second copy of every
  // extension; pi then refuses to start because both register the same tools.
  assert.deepEqual(settings.extensions, [
    path.resolve("/repo/.pi/extensions"),
    "/Users/someone/my-tools",
  ]);
  assert.deepEqual(settings.skills, [path.resolve("/repo/.pi/skills")]);
});

test("every bundled fork declares the packages it supersedes", async () => {
  const projectSettings = JSON.parse(await readFile(".pi/settings.json", "utf8"));
  for (const spec of projectSettings.packages) {
    const manifest = JSON.parse(await readFile(path.resolve(".pi", spec, "package.json"), "utf8"));
    assert.ok(
      Array.isArray(manifest.chocoPi?.supersedes),
      `${spec} must declare chocoPi.supersedes (use [] when it replaces nothing)`,
    );
  }
});

test("malformed JSON names the file instead of reporting a bare parse position", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "choco-pi-install-json-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = path.join(home, "agent");
  const settingsPath = path.join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(settingsPath, "{ not json", "utf8");

  await assert.rejects(
    () => installProfile({ root: process.cwd(), agentDir }),
    (error) =>
      error instanceof Error &&
      error.message.includes(settingsPath) &&
      error.message.includes("valid JSON"),
  );
});
