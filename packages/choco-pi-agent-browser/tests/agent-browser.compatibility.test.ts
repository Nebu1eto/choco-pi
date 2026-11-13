import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgvDescriptor } from "../extensions/agent-browser/lib/argv-descriptor.ts";
import {
  getAgentBrowserExecutableFingerprintKey,
  resolveAgentBrowserExecutable,
} from "../extensions/agent-browser/lib/executable-resolution.ts";
import { extractRefSnapshotFromData } from "../extensions/agent-browser/lib/session-page-state.ts";
import { buildAgentBrowserSpawnCommand } from "../extensions/agent-browser/lib/process.ts";
import {
  getRequestedAgentBrowserCapabilities,
  getUnsupportedCapabilityError,
} from "../extensions/agent-browser/lib/runtime-extension.ts";
import { resolveAgentBrowserCompatibility } from "../extensions/agent-browser/lib/upstream-version.ts";

test("new global flag payloads cannot become commands", () => {
  assert.equal(
    parseArgvDescriptor(["--input-mode", "human", "open", "https://example.test"]).commandInfo
      .command,
    "open",
  );
  assert.equal(
    parseArgvDescriptor(["--ca-cert", "/tmp/x", "snapshot"]).commandInfo.command,
    "snapshot",
  );
  assert.equal(
    parseArgvDescriptor(["--no-webmcp", "false", "snapshot"]).commandInfo.command,
    "snapshot",
  );
});

test("tested profiles expose feature introductions without guessing future support", () => {
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 0.34.0").capabilities.webmcp,
    "unsupported",
  );
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 0.35.2").capabilities["custom-ca-trust"],
    "supported",
  );
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 0.36.0").capabilities.webmcp,
    "supported",
  );
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 0.37.1").capabilities["recording-fps"],
    "supported",
  );
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 0.37.1").capabilities["delta-snapshot"],
    "unsupported",
  );
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 0.38.1").capabilities["delta-snapshot"],
    "supported",
  );
  assert.equal(
    resolveAgentBrowserCompatibility("agent-browser 1.0.0").capabilities.webmcp,
    "unknown",
  );
});

test("capability detection covers raw nested batch operations without exposing payloads", () => {
  assert.deepEqual(
    getRequestedAgentBrowserCapabilities(
      ["batch"],
      'snapshot --delta\nwebmcp invoke charge --params {"secret":"value"}',
    ),
    ["delta-snapshot", "webmcp"],
  );
});

test("capability detection distinguishes commands, option values, and command-owned flags", () => {
  const legacy = resolveAgentBrowserCompatibility("agent-browser 0.34.0");
  assert.equal(getUnsupportedCapabilityError(legacy, ["fill", "#query", "webmcp"]), undefined);
  assert.equal(getUnsupportedCapabilityError(legacy, ["snapshot", "--cursor"]), undefined);
  assert.match(getUnsupportedCapabilityError(legacy, ["webmcp", "list"]) ?? "", /webmcp/u);
  assert.match(
    getUnsupportedCapabilityError(legacy, ["record", "start", "take.webm", "--cursor"]) ?? "",
    /recording-cursor/u,
  );
  assert.deepEqual(
    getRequestedAgentBrowserCapabilities(["set", "--name", "--cursor", "value"]),
    [],
  );
  assert.deepEqual(
    getRequestedAgentBrowserCapabilities(["record", "start", "take.webm", "--", "--cursor"]),
    [],
  );
});

test("stdin capability detection parses each command instead of scanning raw text", () => {
  assert.deepEqual(
    getRequestedAgentBrowserCapabilities(
      ["batch"],
      '[["fill","#query","webmcp"],["snapshot","--cursor"]]',
    ),
    [],
  );
  assert.deepEqual(
    getRequestedAgentBrowserCapabilities(
      ["batch"],
      '[["webmcp","list"],["record","start","take.webm","--cursor"]]',
    ),
    ["webmcp", "recording-cursor"],
  );
});

test("Windows execution binds the exact resolved launcher", () => {
  const command = buildAgentBrowserSpawnCommand(
    ["snapshot"],
    "win32",
    "C:\\tools\\agent-browser.cmd",
  );
  assert.match(command.args.at(-1) ?? "", /C:\\tools\\agent-browser\.cmd/u);
  assert.doesNotMatch(command.args.at(-1) ?? "", /Get-Command/u);
});

test("tested, older, future, prerelease, build, and malformed versions are advisory", () => {
  assert.equal(resolveAgentBrowserCompatibility("agent-browser 0.34.0").warnings.length, 0);
  assert.equal(resolveAgentBrowserCompatibility("agent-browser 0.38.1").profileVersion, "0.38.1");
  for (const version of ["0.33.9", "0.39.0", "1.0.0", "0.38.1-next.1", "0.38.1+build.4"])
    assert.ok(resolveAgentBrowserCompatibility(`agent-browser ${version}`).detectedVersion);
  assert.equal(
    resolveAgentBrowserCompatibility("unexpected").warnings[0]?.code,
    "malformed-version",
  );
});

test("nested full snapshots retain refs and tree evidence", () => {
  const snapshot = extractRefSnapshotFromData({
    origin: "https://example.test",
    snapshot: {
      kind: "full",
      refs: { e1: { name: "Continue", role: "button" } },
      revision: 1,
      tree: '- button "Continue" [ref=e1]',
    },
  });
  assert.deepEqual(snapshot?.refIds, ["e1"]);
  assert.equal(snapshot?.refs?.e1?.name, "Continue");
});

test("executable fingerprint changes when a symlink target changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-fingerprint-"));
  try {
    const first = join(directory, "first");
    const second = join(directory, "second");
    const executable = join(directory, "agent-browser");
    await writeFile(first, "first", { mode: 0o700 });
    await writeFile(second, "second payload", { mode: 0o700 });
    await symlink(first, executable);
    const before = await resolveAgentBrowserExecutable({ cwd: directory, path: directory });
    await rm(executable);
    await symlink(second, executable);
    const after = await resolveAgentBrowserExecutable({ cwd: directory, path: directory });
    assert.ok(before && after);
    assert.notEqual(
      getAgentBrowserExecutableFingerprintKey(before),
      getAgentBrowserExecutableFingerprintKey(after),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
