import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
import {
  bool,
  compile,
  map,
  obj,
  opt,
  unknown,
  type JsonSchema,
  type Static,
} from "@earendil-works/pi-schema";
import { deriveBackgroundLanes } from "../packages/choco-pi-compaction/src/background/settings.ts";
import {
  buildGlobalSettings,
  DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_PACKAGES,
  installProfile,
  MIGRATED_SIDECARS,
  PROFILE_LINKS,
  RETIRED_PROFILE_FILES,
} from "../scripts/install-profile.ts";
import { profileMarkerPath, readProfileMarker } from "../profile/extensions/lib/profile-marker.ts";

const CodexConfigSchema = obj({ openai: obj({ fast: bool() }, { open: true }) }, { open: true });

function parseJson<T extends JsonSchema>(contents: string, schema: T): Static<T> {
  const parsed: unknown = JSON.parse(contents);
  assert.ok(compile(schema).check(parsed), "JSON fixture must match its expected schema");
  return parsed;
}

const SidecarSchema = map(unknown());

/** Bundled packages as an earlier install of this checkout recorded them. */
const BUNDLED_PACKAGES = [
  "choco-pi-web-search",
  "choco-pi-web-access",
  "choco-pi-provider-synthetic",
  "choco-pi-provider-google-antigravity",
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
  "choco-pi-code-mode",
  "choco-pi-agents-md",
  "choco-pi-agent-browser",
  "choco-pi-computer-use",
  "choco-pi-editor-context",
].map((name) => path.resolve("packages", name));

/**
 * The checkout ships no `.pi/settings.json`, so the installer takes its policy
 * from the global settings an earlier install wrote; seed those.
 */
type SeedSettings = {
  packages?: string[];
  extensions?: string[];
  modelThinkingLevels?: Record<string, string>;
};

async function seedProfileSettings(agentDir: string, extra: SeedSettings = {}) {
  await mkdir(agentDir, { recursive: true });
  const settings = {
    packages: BUNDLED_PACKAGES,
    extensions: [path.resolve("profile/extensions"), "-builtin:codemode"],
    ...extra,
  };
  await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

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
  await mkdir(path.join(root, "profile"), { recursive: true });
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", "settings.json"), '{"packages":[]}\n', "utf8");
  const codex = responsesCompaction === undefined ? {} : { compaction: { responsesCompaction } };
  await writeFile(path.join(root, "profile", "choco-pi-codex.json"), JSON.stringify(codex), "utf8");
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
    path.resolve("packages/choco-pi-provider-synthetic"),
    path.resolve("packages/choco-pi-lsp"),
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
    {
      packages: ["npm:example-extension@4.0.0", "npm:@example/subagents@0.16.1"],
    },
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
    path.resolve("packages/choco-pi-provider-synthetic"),
    "npm:user-package@1.2.0",
  ]);
});

test("profile installer links tracked config and is idempotent", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const thinking = {
    "anthropic/claude-opus-5-5": "medium",
    "synthetic/hf:zai-org/GLM-5.3": "high",
  };
  await seedProfileSettings(agentDir, { modelThinkingLevels: thinking });

  await installProfile({ root: process.cwd(), agentDir });
  await installProfile({ root: process.cwd(), agentDir });

  assert.equal(
    await readlink(path.join(agentDir, "choco-pi-ui.json")),
    path.resolve("profile/zentui.json"),
  );
  assert.equal(
    await readlink(path.join(agentDir, "choco-pi-codex.json")),
    path.resolve("profile/choco-pi-codex.json"),
  );
  const codexConfig = parseJson(
    await readFile(path.join(agentDir, "choco-pi-codex.json"), "utf8"),
    CodexConfigSchema,
  );
  const sourceCodexConfig = parseJson(
    await readFile(path.resolve("profile/choco-pi-codex.json"), "utf8"),
    CodexConfigSchema,
  );
  assert.equal(codexConfig.openai.fast, sourceCodexConfig.openai.fast);
  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, BUNDLED_PACKAGES);
  assert.deepEqual(settings.extensions, [
    path.resolve("profile/extensions"),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ]);
  // User levels win; profile defaults fill only the models the user has not set.
  assert.deepEqual(settings.modelThinkingLevels, {
    ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
    ...thinking,
  });
  assert.equal(settings.modelThinkingLevels["anthropic/claude-opus-5-5"], "medium");
});

test("without project settings, global settings supply the profile and lose superseded packages", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-global-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  // choco-pi-lsp supersedes pi-lens; the user's own package stays.
  await seedProfileSettings(agentDir, {
    packages: [...BUNDLED_PACKAGES, "npm:pi-lens@1.0.0", "npm:user-package@2.0.0"],
  });

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [...BUNDLED_PACKAGES, "npm:user-package@2.0.0"]);
});

const GOOGLE_PACKAGE = path.resolve("packages", "choco-pi-provider-google-antigravity");

/** Writes the profile marker an earlier install left, optionally with its offer record. */
async function seedProfileMarker(agentDir: string, bundledPackages?: string[]) {
  const target = profileMarkerPath(agentDir);
  await mkdir(path.dirname(target), { recursive: true });
  const marker = {
    schema: 1,
    name: "choco-pi",
    checkout: process.cwd(),
    revision: null,
    installedAt: new Date(0).toISOString(),
    pi: { version: null, launcher: null },
    hostBridge: {
      schema: 1,
      entryPrefix: "choco-pi:host-bridge",
      statusKey: "choco-pi.host-bridge",
      reportStatusKey: "choco-pi.report",
    },
    ...(bundledPackages !== undefined && { bundledPackages }),
  };
  await writeFile(target, `${JSON.stringify(marker)}\n`, "utf8");
}

test("a reinstall from before the offer record adds packages bundled since, in default order", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-new-bundled-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  // An install from before the Google provider was bundled; its marker predates the record.
  await seedProfileSettings(agentDir, {
    packages: [
      ...BUNDLED_PACKAGES.filter((spec) => spec !== GOOGLE_PACKAGE),
      "npm:user-package@2.0.0",
    ],
  });
  await seedProfileMarker(agentDir);

  const result = await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [...BUNDLED_PACKAGES, "npm:user-package@2.0.0"]);
  assert.deepEqual(result.addedPackages, [GOOGLE_PACKAGE]);
});

test("a reinstall keeps out a bundled package the user removed before the offer record", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-removed-old-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const mcp = path.resolve("packages", "choco-pi-mcp");
  await seedProfileSettings(agentDir, {
    packages: BUNDLED_PACKAGES.filter((spec) => spec !== GOOGLE_PACKAGE && spec !== mcp),
  });

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(
    settings.packages,
    BUNDLED_PACKAGES.filter((spec) => spec !== mcp),
  );
});

test("a reinstall keeps out a recorded bundled package the user removed", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-removed-recorded-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const remaining = BUNDLED_PACKAGES.filter((spec) => spec !== GOOGLE_PACKAGE);
  await seedProfileSettings(agentDir, { packages: remaining });
  await seedProfileMarker(
    agentDir,
    BUNDLED_PACKAGES.map((spec) => path.basename(spec)),
  );

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, remaining);
});

test("an install records the bundled packages it offered in the profile marker", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-offer-record-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  await seedProfileSettings(agentDir);

  await installProfile({ root: process.cwd(), agentDir });

  const observation = await readProfileMarker(agentDir);
  assert.equal(observation.status, "valid");
  assert.ok(observation.status === "valid");
  assert.deepEqual(
    observation.marker.bundledPackages,
    DEFAULT_PROFILE_PACKAGES.map((spec) => path.basename(spec)),
  );
});

test("a clean machine with no settings at all bootstraps the bundled profile", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-empty-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, BUNDLED_PACKAGES);
  assert.deepEqual(settings.extensions, [
    path.resolve("profile/extensions"),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ]);
  assert.deepEqual(settings.skills, [path.resolve("profile/skills")]);
  assert.deepEqual(settings.prompts, [path.resolve("profile/prompts")]);
  assert.equal(await readlink(path.join(agentDir, "SYSTEM.md")), path.resolve("profile/SYSTEM.md"));
});

test("global settings with only user packages bootstrap the profile and keep them", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-user-only-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  await seedProfileSettings(agentDir, {
    packages: ["npm:user-package@2.0.0"],
    extensions: [],
  });

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [...BUNDLED_PACKAGES, "npm:user-package@2.0.0"]);
  assert.deepEqual(settings.extensions, [
    path.resolve("profile/extensions"),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ]);
});

test("a reinstall disables Pi's built-in tool-search, which choco-pi's tool_search replaces", async (context) => {
  assert.deepEqual(DEFAULT_PROFILE_EXTENSIONS, ["-builtin:codemode", "-builtin:tool-search"]);
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-tool-search-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  // An install from before the change, where the user re-enabled the built-in.
  await seedProfileSettings(agentDir, {
    extensions: [
      path.resolve("profile/extensions"),
      "-builtin:codemode",
      "+builtin:tool-search",
      "+builtin:llama.cpp",
    ],
  });

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.extensions, [
    path.resolve("profile/extensions"),
    "+builtin:llama.cpp",
    "-builtin:codemode",
    "-builtin:tool-search",
  ]);
});

test("the clean-install defaults list every bundled package Pi loads", async () => {
  const PiManifestSchema = obj({ pi: opt(unknown()) }, { open: true });
  const loaded: string[] = [];
  for (const entry of await readdir("packages", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = parseJson(
      await readFile(path.join("packages", entry.name, "package.json"), "utf8"),
      PiManifestSchema,
    );
    if (manifest.pi !== undefined) loaded.push(`./packages/${entry.name}`);
  }
  assert.deepEqual([...DEFAULT_PROFILE_PACKAGES].sort(), loaded.sort());
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
    path.resolve("/repo/profile/extensions"),
    "+builtin:llama.cpp",
    "/Users/someone/my-tools",
    "-builtin:codemode",
  ]);
  assert.ok(!settings.extensions.includes("+builtin:codemode"));
  assert.equal(settings.deviceId, "device-from-chatgpt-sign-in");
  assert.equal(settings.defaultModel, "user-model");
});

test("reinstalling keeps exactly one copy of the built-in extension policy", async (context) => {
  // A checkout that ships project settings: its policy overrides the user's.
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-builtins-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(root, ".pi", "settings.json"),
    `${JSON.stringify({ packages: [], extensions: ["-builtin:codemode"] })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ extensions: ["+builtin:codemode", "-builtin:llama.cpp"], deviceId: "d-1" })}\n`,
    "utf8",
  );

  await installProfile({ root, agentDir });
  await installProfile({ root, agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.extensions, [
    path.join(root, "profile", "extensions"),
    "-builtin:codemode",
  ]);
  assert.equal(settings.deviceId, "d-1");
});

test("profile installer preserves enabled and disabled fast preferences", async (context) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-fast-"));
  context.after(() => rm(fixtureDir, { recursive: true, force: true }));

  for (const fast of [true, false]) {
    const root = path.join(fixtureDir, fast ? "enabled" : "disabled");
    const agentDir = path.join(root, "agent");
    const sourceConfig = path.join(root, "profile", "choco-pi-codex.json");
    await mkdir(path.dirname(sourceConfig), { recursive: true });
    await mkdir(path.join(root, ".pi"), { recursive: true });
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
  await seedProfileSettings(agentDir);
  const target = path.join(agentDir, "choco-pi-ui.json");
  await writeFile(target, "user-owned\n");

  await assert.rejects(
    installProfile({ root: process.cwd(), agentDir }),
    /already exists; rerun with --backup/,
  );
  assert.equal(await readFile(target, "utf8"), "user-owned\n");
  await assert.rejects(readlink(path.join(agentDir, "SYSTEM.md")), {
    code: "ENOENT",
  });

  const result = await installProfile({
    root: process.cwd(),
    agentDir,
    backup: true,
  });
  const migrated = result.links.find((link) => link.target === target);
  assert.equal(migrated?.action, "backed-up");
  assert.equal(await readFile(migrated?.backup ?? "", "utf8"), "user-owned\n");
});

test("installing the profile removes the packages each bundled fork replaces", () => {
  const projectSettings = {
    packages: ["./packages/choco-pi-lsp", "./packages/choco-pi-ui"],
  };
  const existingSettings = {
    packages: [
      "npm:pi-lens@4.0.0",
      path.join("/Users/someone/Workspace/choco-pi", ".pi", "packages", "pi-zentui"),
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
    path.resolve("/repo/packages/choco-pi-lsp"),
    path.resolve("/repo/packages/choco-pi-ui"),
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
    path.resolve("/repo/profile/extensions"),
    "/Users/someone/my-tools",
  ]);
  assert.deepEqual(settings.skills, [path.resolve("/repo/profile/skills")]);
});

test("every bundled fork declares the packages it supersedes", async () => {
  for (const name of await readdir("packages")) {
    const manifest = JSON.parse(
      await readFile(path.resolve("packages", name, "package.json"), "utf8"),
    );
    // Only Pi packages are installed; choco-pi-acp is a standalone binary.
    if (manifest.pi === undefined) continue;
    assert.ok(
      Array.isArray(manifest.chocoPi?.supersedes),
      `${name} must declare chocoPi.supersedes (use [] when it replaces nothing)`,
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
    await assert.rejects(readlink(path.join(agentDir, "SYSTEM.md")), {
      code: "ENOENT",
    });
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
    "/repo/profile/extensions",
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

      const lanes = deriveBackgroundLanes({
        openaiServerSide,
        anthropicServerSide,
      });
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
  await writeFile(path.join(root, "profile", "choco-pi-codex.json"), "{ not json", "utf8");

  const result = await installProfile({ root, agentDir });

  assert.deepEqual(result.migrations, [{ target: sidecarPath, action: "skipped" }]);
  assert.equal(await readFile(sidecarPath, "utf8"), LEGACY_SIDECAR);
  assert.ok(result.warnings.some((warning) => warning.includes("choco-pi-codex.json")));
});

test("install removes a stale context-cap.json link and reports it once", async (context) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-context-cap-"));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  await seedProfileSettings(agentDir);
  const target = path.join(agentDir, "extensions", "context-cap.json");
  await mkdir(path.dirname(target), { recursive: true });
  // An earlier install linked the tracked file, which no longer exists: dangling.
  await symlink(path.resolve("profile/extensions/context-cap.json"), target);

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
  await seedProfileSettings(agentDir);
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
  await seedProfileSettings(agentDir);
  const target = path.join(agentDir, "extensions", "context-cap.json");
  await mkdir(target, { recursive: true });

  const result = await installProfile({ root: process.cwd(), agentDir });
  assert.deepEqual(result.removed, []);
  assert.ok((await lstat(target)).isDirectory());
  assert.ok(result.warnings.some((warning) => warning.includes(target)));
});

test("retired profile files are neither shipped, linked, nor migrated", async () => {
  for (const target of RETIRED_PROFILE_FILES) {
    await assert.rejects(lstat(path.resolve("profile", target)), {
      code: "ENOENT",
    });
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
    "profile/extensions",
  ]);
  // A tracked file deleted in the working tree is no longer shipped.
  const deleted = new Set(
    (
      await promisify(execFile)("git", ["ls-files", "--deleted", "--", "profile/extensions"])
    ).stdout.split("\n"),
  );
  const sidecars = stdout
    .split("\n")
    .filter(
      (file) =>
        path.posix.dirname(file) === "profile/extensions" &&
        file.endsWith(".json") &&
        !deleted.has(file),
    );
  assert.ok(sidecars.length > 0, "the profile ships extension sidecars");
  const linked = new Set(PROFILE_LINKS.map(([source]) => source));
  const migrated = new Set(MIGRATED_SIDECARS.map((target) => `profile/${target}`));
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

test("bundled packages and profile directories of any checkout layout dedupe to this checkout", () => {
  const root = "/repo";
  const settings = buildGlobalSettings(
    { packages: ["./packages/choco-pi-lsp", "./packages/choco-pi-ui"] },
    {
      packages: [
        "/repo/.pi/packages/choco-pi-lsp",
        "/old/.pi/packages/choco-pi-ui",
        "/other/packages/choco-pi-lsp",
        "/other/packages/user-package",
        "/Users/someone/own-packages/choco-pi-ui",
      ],
      extensions: [
        "/repo/.pi/extensions",
        "/other/profile/extensions",
        "/Users/someone/profile-tools/extensions",
      ],
      skills: ["/repo/.pi/skills", "/other/profile/skills", "/repo/profile/skills"],
      prompts: ["/other/.pi/prompts", "/Users/someone/prompts", "/unmarked/profile/prompts"],
    },
    root,
    [],
    // Only /other was confirmed as a choco-pi checkout.
    new Set(["/other"]),
  );

  // A bundled name under another checkout's packages/ is this profile's copy;
  // any other name under packages/ and any other parent stay the user's.
  assert.deepEqual(settings.packages, [
    path.resolve("/repo/packages/choco-pi-lsp"),
    path.resolve("/repo/packages/choco-pi-ui"),
    "/other/packages/user-package",
    "/Users/someone/own-packages/choco-pi-ui",
  ]);
  assert.deepEqual(settings.extensions, [
    path.resolve("/repo/profile/extensions"),
    "/Users/someone/profile-tools/extensions",
  ]);
  assert.deepEqual(settings.skills, [path.resolve("/repo/profile/skills")]);
  assert.deepEqual(settings.prompts, [
    path.resolve("/repo/profile/prompts"),
    "/Users/someone/prompts",
    "/unmarked/profile/prompts",
  ]);
});

test("another checkout's profile directory is dropped only with choco-pi checkout evidence", async (context) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-evidence-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  // A user's own project that happens to have profile/skills: no checkout markers.
  const userSkills = path.join(fixture, "user-proj", "profile", "skills");
  await mkdir(userSkills, { recursive: true });
  // A checkout recognized by its profile and bundled package markers.
  const markedCheckout = path.join(fixture, "other-checkout");
  await mkdir(path.join(markedCheckout, "profile", "skills"), { recursive: true });
  await writeFile(path.join(markedCheckout, "profile", "SYSTEM.md"), "system\n", "utf8");
  await mkdir(path.join(markedCheckout, "packages", "choco-pi-ui"), { recursive: true });
  await writeFile(path.join(markedCheckout, "packages", "choco-pi-ui", "package.json"), "{}\n");
  // A checkout recognized by its root manifest name.
  const harnessCheckout = path.join(fixture, "harness-checkout");
  await mkdir(path.join(harnessCheckout, "profile", "prompts"), { recursive: true });
  await writeFile(
    path.join(harnessCheckout, "package.json"),
    `${JSON.stringify({ name: "choco-pi", private: true })}\n`,
  );
  // Only one of the two markers is not enough.
  const halfMarked = path.join(fixture, "half-marked");
  await mkdir(path.join(halfMarked, "profile", "extensions"), { recursive: true });
  await writeFile(path.join(halfMarked, "profile", "SYSTEM.md"), "system\n", "utf8");
  const agentDir = path.join(fixture, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({
      packages: BUNDLED_PACKAGES,
      extensions: [path.join(halfMarked, "profile", "extensions"), "-builtin:codemode"],
      skills: [path.join(markedCheckout, "profile", "skills"), userSkills],
      prompts: [path.join(harnessCheckout, "profile", "prompts")],
    })}\n`,
    "utf8",
  );

  await installProfile({ root: process.cwd(), agentDir });

  const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.skills, [path.resolve("profile/skills"), userSkills]);
  assert.deepEqual(settings.prompts, [path.resolve("profile/prompts")]);
  assert.deepEqual(settings.extensions, [
    path.resolve("profile/extensions"),
    path.join(halfMarked, "profile", "extensions"),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ]);
});

/** Where the old layout kept each linked profile file, relative to the checkout. */
function oldLayoutSource(sourceRelative: string) {
  assert.ok(sourceRelative.startsWith("profile/"));
  return `.pi/${sourceRelative.slice("profile/".length)}`;
}

/**
 * A checkout in the new layout (`packages` and `profile` borrowed from this
 * one) plus an agent directory an old-layout install of the same checkout
 * wrote: settings name `<root>/.pi/packages/*` in load order and the old
 * profile directories, and every profile link points into `<root>/.pi`. The
 * old `.pi/SYSTEM.md` source still exists; every other old link is dangling,
 * and `agents/planner.md` points into an old checkout that has since moved.
 */
async function oldLayoutFixture(context: TestContext) {
  const fixture = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-old-layout-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "checkout");
  const agentDir = path.join(fixture, "agent");
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await symlink(path.resolve("packages"), path.join(root, "packages"));
  await symlink(path.resolve("profile"), path.join(root, "profile"));
  await writeFile(path.join(root, ".pi", "SYSTEM.md"), "old system prompt\n", "utf8");
  for (const [sourceRelative, targetRelative] of PROFILE_LINKS) {
    const target = path.join(agentDir, targetRelative);
    await mkdir(path.dirname(target), { recursive: true });
    const oldSource =
      targetRelative === "agents/planner.md"
        ? path.join(fixture, "moved-away", oldLayoutSource(sourceRelative))
        : path.join(root, oldLayoutSource(sourceRelative));
    await symlink(oldSource, target);
  }
  const userFile = path.join(agentDir, "user-notes.md");
  await writeFile(userFile, "mine\n", "utf8");
  const oldPackages = BUNDLED_PACKAGES.map((dir) =>
    path.join(root, ".pi", "packages", path.basename(dir)),
  );
  const userPackages = ["npm:user-package@2.0.0", "/Users/someone/own-packages/my-pkg"];
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({
      packages: [...oldPackages, ...userPackages],
      extensions: [
        path.join(root, ".pi", "extensions"),
        "-builtin:codemode",
        "-builtin:tool-search",
        "+builtin:llama.cpp",
      ],
      skills: [path.join(root, ".pi", "skills"), "/Users/someone/my-skills"],
      prompts: [path.join(root, ".pi", "prompts")],
      defaultModel: "user-model",
      enabledModels: ["user/model"],
    })}\n`,
    "utf8",
  );
  return { root, agentDir, userFile, userPackages };
}

test("an old-layout install upgrades in place without --backup and is idempotent", async (context) => {
  const { root, agentDir, userFile, userPackages } = await oldLayoutFixture(context);

  const first = await installProfile({ root, agentDir });

  assert.ok(first.links.every(({ action }) => action === "linked"));
  const settingsPath = path.join(agentDir, "settings.json");
  const settingsText = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(settingsText);
  const expectedPackages = DEFAULT_PROFILE_PACKAGES.map((spec) => path.resolve(root, spec));
  assert.deepEqual(settings.packages, [...expectedPackages, ...userPackages]);
  assert.ok(
    settings.packages.indexOf(path.join(root, "packages", "choco-pi-web-search")) <
      settings.packages.indexOf(path.join(root, "packages", "choco-pi-web-access")),
  );
  assert.ok(!settings.packages.some((spec: string) => spec.includes("choco-pi-acp")));
  assert.ok(!settings.packages.some((spec: string) => spec.includes(`${path.sep}.pi${path.sep}`)));
  assert.deepEqual(settings.extensions, [
    path.join(root, "profile", "extensions"),
    "+builtin:llama.cpp",
    ...DEFAULT_PROFILE_EXTENSIONS,
  ]);
  assert.deepEqual(settings.skills, [
    path.join(root, "profile", "skills"),
    "/Users/someone/my-skills",
  ]);
  assert.deepEqual(settings.prompts, [path.join(root, "profile", "prompts")]);
  assert.equal(settings.defaultModel, "user-model");
  assert.deepEqual(settings.enabledModels, ["user/model"]);
  for (const [sourceRelative, targetRelative] of PROFILE_LINKS) {
    assert.equal(
      await readlink(path.join(agentDir, targetRelative)),
      path.join(root, sourceRelative),
      targetRelative,
    );
  }
  assert.equal(await readFile(path.join(root, ".pi", "SYSTEM.md"), "utf8"), "old system prompt\n");
  assert.equal(await readFile(userFile, "utf8"), "mine\n");
  const leftovers = (await readdir(agentDir, { recursive: true })).filter(
    (name) => name.includes(".backup-") || name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, []);

  const second = await installProfile({ root, agentDir });

  assert.ok(second.links.every(({ action }) => action === "unchanged"));
  assert.equal(await readFile(settingsPath, "utf8"), settingsText);
});

test("an old-layout upgrade still refuses to replace a foreign file without --backup", async (context) => {
  const { root, agentDir } = await oldLayoutFixture(context);
  const settingsPath = path.join(agentDir, "settings.json");
  const settingsBefore = await readFile(settingsPath, "utf8");
  const foreign = path.join(agentDir, "review-policy.md");
  await rm(foreign);
  await writeFile(foreign, "user-owned\n", "utf8");
  // A live link into another checkout's .pi is someone else's file too.
  const elsewhere = path.join(path.dirname(root), "elsewhere", ".pi", "SYSTEM.md");
  await mkdir(path.dirname(elsewhere), { recursive: true });
  await writeFile(elsewhere, "elsewhere\n", "utf8");
  const liveLink = path.join(agentDir, "SYSTEM.md");
  await rm(liveLink);
  await symlink(elsewhere, liveLink);

  await assert.rejects(installProfile({ root, agentDir }), /already exists; rerun with --backup/);
  assert.equal(await readFile(foreign, "utf8"), "user-owned\n");
  assert.equal(await readlink(liveLink), elsewhere);
  assert.equal(await readFile(settingsPath, "utf8"), settingsBefore);

  const result = await installProfile({ root, agentDir, backup: true });

  const backedUp = result.links.filter(({ action }) => action === "backed-up");
  assert.deepEqual(backedUp.map(({ target }) => target).sort(), [foreign, liveLink].sort());
  for (const link of result.links) {
    if (link.action !== "backed-up") assert.equal(link.action, "linked", link.target);
  }
  const savedForeign = backedUp.find(({ target }) => target === foreign)?.backup ?? "";
  assert.equal(await readFile(savedForeign, "utf8"), "user-owned\n");
});

test("the CLI installs when its path runs through a symlinked directory", async (context) => {
  // Node runs the main module's real path; argv[1] keeps the symlink (macOS /tmp -> /private/tmp).
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const linkedCheckout = path.join(directory, "checkout");
  await symlink(process.cwd(), linkedCheckout);
  const agentDir = path.join(directory, "agent");
  const environment: NodeJS.ProcessEnv = { HOME: directory, PATH: "/usr/bin:/bin" };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(linkedCheckout, "scripts", "install-profile.ts"), "--agent-dir", agentDir],
    { cwd: directory, env: environment },
  );
  assert.match(stdout, /^updated: .*settings\.json$/m);
  assert.ok((await lstat(path.join(agentDir, "settings.json"))).isFile());
  assert.ok((await lstat(path.join(agentDir, "choco-pi-ui.json"))).isSymbolicLink());
});
