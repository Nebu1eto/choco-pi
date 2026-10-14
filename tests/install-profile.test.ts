import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { deriveBackgroundLanes } from "../.pi/packages/choco-pi-compaction/src/background/settings.ts";
import {
  buildGlobalSettings,
  installProfile,
  MIGRATED_SIDECARS,
  PROFILE_LINKS,
  RETIRED_PROFILE_FILES,
} from "../scripts/install-profile.ts";

const CodexConfigSchema = Type.Object({
  openai: Type.Object({ fast: Type.Boolean() }),
});

function parseJson<T extends TSchema>(contents: string, schema: T): Static<T> {
  const parsed: unknown = JSON.parse(contents);
  assert.ok(Value.Check(schema, parsed), "JSON fixture must match its expected schema");
  return parsed;
}

const SidecarSchema = Type.Record(Type.String(), Type.Unknown());

type SidecarFixture = {
  sidecar?: string;
  responsesCompaction?: boolean;
  compactionAnthropic?: string;
};

/**
 * A minimal profile root plus agent directory. The codex config is linked from
 * the root, as in a real install, so `responsesCompaction` reaches the
 * installer through the link.
 */
async function sidecarFixture(
  context: TestContext,
  { sidecar, responsesCompaction, compactionAnthropic }: SidecarFixture,
) {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-sidecar-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", "settings.json"), '{"packages":[]}\n', "utf8");
  const codex = responsesCompaction === undefined ? {} : { compaction: { responsesCompaction } };
  await writeFile(path.join(root, ".pi", "choco-pi-codex.json"), JSON.stringify(codex), "utf8");
  await mkdir(path.join(agentDir, "extensions"), { recursive: true });
  if (compactionAnthropic !== undefined) {
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ compactionAnthropic }),
      "utf8",
    );
  }
  const sidecarPath = path.join(agentDir, "extensions", "background-compaction.json");
  if (sidecar !== undefined) await writeFile(sidecarPath, sidecar, "utf8");
  return { root, agentDir, sidecarPath };
}

const LEGACY_SIDECAR = JSON.stringify({
  enabled: true,
  text: true,
  codexNative: true,
  anthropicNative: false,
});

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

test("user thinking levels win and the profile only fills in missing models", () => {
  const settings = buildGlobalSettings(
    {
      packages: [],
      modelThinkingLevels: { "a/shared": "medium", "a/profile-only": "high" },
    },
    { modelThinkingLevels: { "a/shared": "low", "a/user-only": "xhigh" } },
    process.cwd(),
  );

  assert.deepEqual(settings.modelThinkingLevels, {
    "a/shared": "low",
    "a/profile-only": "high",
    "a/user-only": "xhigh",
  });
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
  const codexConfig = parseJson(
    await readFile(path.join(agentDir, "choco-pi-codex.json"), "utf8"),
    CodexConfigSchema,
  );
  const sourceCodexConfig = parseJson(
    await readFile(path.resolve(".pi/choco-pi-codex.json"), "utf8"),
    CodexConfigSchema,
  );
  assert.equal(codexConfig.openai.fast, sourceCodexConfig.openai.fast);
  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(
    settings.packages,
    [
      "choco-pi-web-search",
      "choco-pi-web-access",
      "choco-pi-provider-synthetic",
      "choco-pi-ui",
      "choco-pi-shells",
      "choco-pi-hooks",
      "choco-pi-subagents",
      "choco-pi-advisor",
      "choco-pi-goal",
      "choco-pi-mcp",
      "choco-pi-lsp",
      "choco-pi-compaction",
      "choco-pi-codex",
      "choco-pi-agents-md",
      "choco-pi-agent-browser",
      "choco-pi-computer-use",
      "choco-pi-editor-context",
    ].map((name) => path.resolve(".pi/packages", name)),
  );
  const projectSettings = JSON.parse(await readFile(path.resolve(".pi/settings.json"), "utf8"));
  assert.deepEqual(settings.extensions, [path.resolve(".pi/extensions"), "-builtin:codemode"]);
  assert.deepEqual(projectSettings.extensions, ["-builtin:codemode"]);
  assert.deepEqual(settings.modelThinkingLevels, projectSettings.modelThinkingLevels);
});

test("the profile removes stale built-in exclusions and preserves unrelated settings", () => {
  const settings = buildGlobalSettings(
    {
      packages: [],
      extensions: ["-builtin:codemode"],
    },
    {
      extensions: [
        "+builtin:codemode",
        "+builtin:llama.cpp",
        "/Users/someone/my-tools",
        "-builtin:mcp",
        "-builtin:tool-search",
        "!builtin:old-extension",
      ],
      deviceId: "device-from-chatgpt-sign-in",
      defaultModel: "user-model",
    },
    "/repo",
  );

  assert.deepEqual(settings.extensions, [
    path.resolve("/repo/.pi/extensions"),
    "+builtin:llama.cpp",
    "/Users/someone/my-tools",
    "-builtin:codemode",
  ]);
  assert.ok(!settings.extensions.includes("+builtin:codemode"));
  assert.equal(settings.deviceId, "device-from-chatgpt-sign-in");
  assert.equal(settings.defaultModel, "user-model");
});

test("reinstalling keeps exactly one copy of the built-in extension policy", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-builtins-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ extensions: ["+builtin:codemode", "-builtin:llama.cpp"], deviceId: "d-1" })}\n`,
    "utf8",
  );

  await installProfile({ root: process.cwd(), agentDir });
  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.extensions, [path.resolve(".pi/extensions"), "-builtin:codemode"]);
  assert.equal(settings.deviceId, "d-1");
});

test("profile installer preserves enabled and disabled fast preferences", async (context) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-fast-"));
  context.after(() => rm(fixtureDir, { recursive: true, force: true }));

  for (const fast of [true, false]) {
    const root = path.join(fixtureDir, fast ? "enabled" : "disabled");
    const agentDir = path.join(root, "agent");
    const sourceConfig = path.join(root, ".pi", "choco-pi-codex.json");
    await mkdir(path.dirname(sourceConfig), { recursive: true });
    await writeFile(path.join(root, ".pi", "settings.json"), '{"packages":[]}\n', "utf8");
    await writeFile(sourceConfig, `${JSON.stringify({ openai: { fast } })}\n`, "utf8");

    const firstInstall = await installProfile({ root, agentDir });
    const secondInstall = await installProfile({ root, agentDir });
    const installedConfig = path.join(agentDir, "choco-pi-codex.json");

    assert.equal(await readlink(installedConfig), sourceConfig);
    assert.ok(firstInstall.links.every(({ action }) => action === "linked"));
    assert.ok(secondInstall.links.every(({ action }) => action === "unchanged"));
    assert.equal(
      parseJson(await readFile(installedConfig, "utf8"), CodexConfigSchema).openai.fast,
      fast,
    );
  }
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

test("invalid settings shapes fail before profile links are written", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-shape-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  for (const value of [
    null,
    [],
    { extensions: [42] },
    { packages: "not-an-array" },
    { modelThinkingLevels: { model: 3 } },
  ]) {
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(value));
    await assert.rejects(installProfile({ root: process.cwd(), agentDir }), /valid JSON/);
    await assert.rejects(readlink(path.join(agentDir, "SYSTEM.md")), { code: "ENOENT" });
  }
});

test("built-in exclusion removal preserves arbitrary unrelated JSON fields", () => {
  const existing = {
    extensions: [
      "-builtin:mcp",
      "-builtin:tool-search",
      "-builtin:llama.cpp",
      "/user/extension.ts",
      "+builtin:other",
    ],
    userPreference: { nested: [false, 42, null, { text: "untouched" }] },
    deviceId: "unchanged-device",
  };
  const settings = buildGlobalSettings(
    { packages: [], extensions: ["-builtin:codemode"] },
    existing,
    "/repo",
  );
  assert.deepEqual(settings.extensions, [
    "/repo/.pi/extensions",
    "/user/extension.ts",
    "+builtin:other",
    "-builtin:codemode",
  ]);
  assert.deepEqual(settings.userPreference, existing.userPreference);
  assert.equal(settings.deviceId, existing.deviceId);
  assert.deepEqual(existing.extensions, [
    "-builtin:mcp",
    "-builtin:tool-search",
    "-builtin:llama.cpp",
    "/user/extension.ts",
    "+builtin:other",
  ]);
});

test("install migrates the background sidecar lanes and keeps the master switch", async (context) => {
  const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
    sidecar: `${LEGACY_SIDECAR}\n`,
    responsesCompaction: true,
  });

  const first = await installProfile({ root, agentDir });
  assert.deepEqual(first.migrations, [{ target: sidecarPath, action: "migrated" }]);
  assert.deepEqual(parseJson(await readFile(sidecarPath, "utf8"), SidecarSchema), {
    enabled: true,
    text: true,
    codexNative: true,
    anthropicNative: true,
  });
  assert.equal((await lstat(sidecarPath)).mode & 0o777, 0o600);

  const second = await installProfile({ root, agentDir });
  assert.deepEqual(second.migrations, [{ target: sidecarPath, action: "unchanged" }]);
});

test("install derives the sidecar lanes from every vendor mode combination", async (context) => {
  for (const openaiServerSide of [true, false]) {
    for (const anthropicServerSide of [true, false]) {
      const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
        sidecar: JSON.stringify({ enabled: false, text: false, maxQueued: 7 }),
        responsesCompaction: openaiServerSide,
        compactionAnthropic: anthropicServerSide ? "server-side" : "choco-pi",
      });

      await installProfile({ root, agentDir });

      const lanes = deriveBackgroundLanes({ openaiServerSide, anthropicServerSide });
      assert.deepEqual(parseJson(await readFile(sidecarPath, "utf8"), SidecarSchema), {
        enabled: false,
        maxQueued: 7,
        ...lanes,
      });
      assert.equal(lanes.codexNative, openaiServerSide);
      assert.equal(lanes.anthropicNative, anthropicServerSide);
    }
  }
});

test("choco-pi Anthropic compaction turns the anthropic-native lane off", async (context) => {
  const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
    sidecar: LEGACY_SIDECAR,
    responsesCompaction: true,
    compactionAnthropic: "choco-pi",
  });

  await installProfile({ root, agentDir });

  const sidecar = parseJson(await readFile(sidecarPath, "utf8"), SidecarSchema);
  assert.equal(sidecar.anthropicNative, false);
  assert.equal(sidecar.enabled, true);
  const settings = parseJson(
    await readFile(path.join(agentDir, "settings.json"), "utf8"),
    SidecarSchema,
  );
  assert.equal(settings.compactionAnthropic, "choco-pi");
});

test("disabled responses compaction turns the codex-native lane off", async (context) => {
  for (const responsesCompaction of [false, undefined]) {
    const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
      sidecar: LEGACY_SIDECAR,
      responsesCompaction,
    });

    await installProfile({ root, agentDir });

    const sidecar = parseJson(await readFile(sidecarPath, "utf8"), SidecarSchema);
    assert.equal(sidecar.codexNative, false);
    assert.equal(sidecar.anthropicNative, true);
  }
});

test("a missing background sidecar stays missing", async (context) => {
  const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
    responsesCompaction: true,
  });

  const result = await installProfile({ root, agentDir });

  assert.deepEqual(result.migrations, [{ target: sidecarPath, action: "absent" }]);
  await assert.rejects(lstat(sidecarPath), { code: "ENOENT" });
});

test("a malformed background sidecar is left untouched with a warning", async (context) => {
  for (const contents of ["{ not json", JSON.stringify({ enabled: "yes" })]) {
    const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
      sidecar: contents,
      responsesCompaction: true,
    });

    const result = await installProfile({ root, agentDir });

    assert.deepEqual(result.migrations, [{ target: sidecarPath, action: "skipped" }]);
    assert.equal(await readFile(sidecarPath, "utf8"), contents);
    assert.ok(
      result.warnings.some((warning) => warning.includes(sidecarPath)),
      "the warning names the sidecar",
    );
  }
});

test("an unreadable codex config skips the sidecar migration with a warning", async (context) => {
  const { root, agentDir, sidecarPath } = await sidecarFixture(context, {
    sidecar: LEGACY_SIDECAR,
  });
  await writeFile(path.join(root, ".pi", "choco-pi-codex.json"), "{ not json", "utf8");

  const result = await installProfile({ root, agentDir });

  assert.deepEqual(result.migrations, [{ target: sidecarPath, action: "skipped" }]);
  assert.equal(await readFile(sidecarPath, "utf8"), LEGACY_SIDECAR);
  assert.ok(result.warnings.some((warning) => warning.includes("choco-pi-codex.json")));
});

test("install removes a stale context-cap.json link and reports it once", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-context-cap-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const target = path.join(agentDir, "extensions", "context-cap.json");
  await mkdir(path.dirname(target), { recursive: true });
  // An earlier install linked the tracked file, which no longer exists: dangling.
  await symlink(path.resolve(".pi/extensions/context-cap.json"), target);

  const first = await installProfile({ root: process.cwd(), agentDir });
  assert.deepEqual(first.removed, [target]);
  assert.ok(!first.links.some((link) => link.target === target), "it is no longer linked");
  await assert.rejects(lstat(target), { code: "ENOENT" });

  const second = await installProfile({ root: process.cwd(), agentDir });
  assert.deepEqual(second.removed, []);
});

test("install removes a stale context-cap.json copy without needing --backup", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-context-cap-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const target = path.join(agentDir, "extensions", "context-cap.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ headroom: { tokens: 1 }, models: {} })}\n`, "utf8");

  const result = await installProfile({ root: process.cwd(), agentDir });
  assert.deepEqual(result.removed, [target]);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("a directory at a retired path is left in place with a warning", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-context-cap-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const target = path.join(agentDir, "extensions", "context-cap.json");
  await mkdir(target, { recursive: true });

  const result = await installProfile({ root: process.cwd(), agentDir });
  assert.deepEqual(result.removed, []);
  assert.ok((await lstat(target)).isDirectory());
  assert.ok(result.warnings.some((warning) => warning.includes(target)));
});

test("retired profile files are neither shipped, linked, nor migrated", async () => {
  for (const target of RETIRED_PROFILE_FILES) {
    await assert.rejects(lstat(path.resolve(".pi", target)), { code: "ENOENT" });
    assert.ok(!PROFILE_LINKS.some(([, linkedTarget]) => linkedTarget === target));
    assert.ok(!MIGRATED_SIDECARS.includes(target));
  }
});

test("every profile extension sidecar is linked or migrated by the installer", async () => {
  // Tracked and untracked-but-not-ignored files: a new sidecar fails here
  // before it is committed. Ignored files (such as synthetic.json) are user state.
  const { stdout } = await promisify(execFile)("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ".pi/extensions",
  ]);
  // A tracked file deleted in the working tree is no longer shipped.
  const deleted = new Set(
    (
      await promisify(execFile)("git", ["ls-files", "--deleted", "--", ".pi/extensions"])
    ).stdout.split("\n"),
  );
  const sidecars = stdout
    .split("\n")
    .filter(
      (file) =>
        path.posix.dirname(file) === ".pi/extensions" &&
        file.endsWith(".json") &&
        !deleted.has(file),
    );
  assert.ok(sidecars.length > 0, "the profile ships extension sidecars");
  const linked = new Set(PROFILE_LINKS.map(([source]) => source));
  const migrated = new Set(MIGRATED_SIDECARS.map((target) => `.pi/${target}`));
  for (const sidecar of sidecars) {
    assert.ok(
      linked.has(sidecar) || migrated.has(sidecar),
      `${sidecar} must be listed in PROFILE_LINKS or MIGRATED_SIDECARS in scripts/install-profile.ts`,
    );
  }
  for (const target of MIGRATED_SIDECARS) {
    assert.ok(
      !PROFILE_LINKS.some(([, linkedTarget]) => linkedTarget === target),
      `${target} cannot be both linked and migrated`,
    );
  }
});
