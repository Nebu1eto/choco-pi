import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configPathsAliasSameFile } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config-path-alias.ts";
import {
  clearFolderCodexConversionConfig,
  hasFolderCodexConversionConfig,
  materializeFolderCodexConversionConfig,
} from "../.pi/packages/choco-pi-codex/src/adapter/activation/config-store.ts";

const CONFIG_BASENAME = "choco-pi-codex.json";

/** A config whose owned keys folder-clearing would strip. */
const PROFILE_CONFIG = `${JSON.stringify(
  {
    ui: { statusLine: false },
    openai: { fast: false, cacheKeepalive: true },
  },
  null,
  2,
)}\n`;

interface AliasFixture {
  root: string;
  cwd: string;
  projectConfigPath: string;
}

/** A checkout whose tracked config doubles as the global config, like the profile's. */
function createAliasedCheckout(): AliasFixture {
  const root = mkdtempSync(path.join(tmpdir(), "codex-alias-"));
  const cwd = path.join(root, "checkout");
  const agentDir = path.join(root, "agent");
  const projectConfigPath = path.join(cwd, ".pi", CONFIG_BASENAME);
  mkdirSync(path.dirname(projectConfigPath), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(projectConfigPath, PROFILE_CONFIG);
  symlinkSync(projectConfigPath, path.join(agentDir, CONFIG_BASENAME));
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  return { root, cwd, projectConfigPath };
}

function cleanup(fixture: AliasFixture, previousAgentDir: string | undefined): void {
  rmSync(fixture.root, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
}

test("a symlinked global config aliases the file it points at", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-alias-unit-"));
  try {
    const target = path.join(root, "target.json");
    const link = path.join(root, "link.json");
    const other = path.join(root, "other.json");
    writeFileSync(target, "{}\n");
    writeFileSync(other, "{}\n");
    symlinkSync(target, link);
    assert.equal(configPathsAliasSameFile(link, target), true);
    assert.equal(configPathsAliasSameFile(target, other), false);
    assert.equal(configPathsAliasSameFile(target, path.join(root, "missing.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folder-settings operations leave an aliased global profile alone", () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const fixture = createAliasedCheckout();
  try {
    assert.equal(
      hasFolderCodexConversionConfig(fixture.cwd, true),
      false,
      "the profile config is the global layer, not folder settings",
    );

    const materialized = materializeFolderCodexConversionConfig(fixture.cwd, true);
    assert.equal(materialized.ok, false, "materializing would rewrite the profile");

    const cleared = clearFolderCodexConversionConfig(fixture.cwd, true);
    assert.equal(cleared.ok, true, "clearing is a safe no-op");
    assert.equal(
      readFileSync(fixture.projectConfigPath, "utf-8"),
      PROFILE_CONFIG,
      "the tracked profile config keeps every setting",
    );
  } finally {
    cleanup(fixture, previousAgentDir);
  }
});

test("a real folder config still clears down to project-only settings", () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const root = mkdtempSync(path.join(tmpdir(), "codex-folder-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const projectConfigPath = path.join(cwd, ".pi", CONFIG_BASENAME);
  mkdirSync(path.dirname(projectConfigPath), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, CONFIG_BASENAME), PROFILE_CONFIG);
  writeFileSync(
    projectConfigPath,
    `${JSON.stringify({ ui: { statusLine: true }, openai: { fast: true, cacheKeepalive: true } })}\n`,
  );
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  try {
    assert.equal(hasFolderCodexConversionConfig(cwd, true), true);
    const cleared = clearFolderCodexConversionConfig(cwd, true);
    assert.equal(cleared.ok, true);
    const document = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
    assert.deepEqual(
      document,
      { openai: { cacheKeepalive: true } },
      "owned keys go, the project-only keepalive stays",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  }
});
