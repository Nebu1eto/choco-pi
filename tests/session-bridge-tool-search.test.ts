import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createToolSearchResourceLoader } from "../.pi/extensions/lib/tool-surface.ts";

async function withSession(
  settings: Parameters<typeof SettingsManager.inMemory>[0],
  check: (activeTools: string[], registered: string[]) => void,
): Promise<void> {
  // An empty project and agent dir keep discovery to the factory under test.
  const root = await mkdtemp(join(tmpdir(), "choco-pi-session-tool-search-"));
  try {
    const settingsManager = SettingsManager.inMemory(settings);
    const resourceLoader = await createToolSearchResourceLoader(root, {
      agentDir: root,
      settingsManager,
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(root),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      check(
        session.getActiveToolNames(),
        session.getAllTools().map((tool) => tool.name),
      );
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SDK sessions declare Pi's built-in tool_search before their first request", async () => {
  await withSession({}, (activeTools) => {
    assert.ok(activeTools.includes("tool_search"));
    // The default tool set is kept; the activation is additive.
    assert.ok(activeTools.includes("read"));
  });
});

test("SDK sessions honor -builtin:tool-search exactly like the CLI", async () => {
  await withSession({ extensions: ["-builtin:tool-search"] }, (activeTools, registered) => {
    assert.ok(!registered.includes("tool_search"));
    assert.ok(!activeTools.includes("tool_search"));
  });
});

test("session bridge and review side chat build their sessions with the shared loader", async () => {
  // Both production factories must route through createToolSearchResourceLoader;
  // an SDK session created without it silently loses tool discovery.
  const [bridge, ask] = await Promise.all([
    readFile(new URL("../.pi/extensions/session-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../.pi/extensions/review/core/ask.ts", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of [
    ["session-bridge", bridge],
    ["review ask", ask],
  ] as const) {
    assert.match(source, /createToolSearchResourceLoader\(/, `${name} builds the shared loader`);
    assert.match(source, /resourceLoader,\n/, `${name} passes it to createAgentSession`);
  }
});
