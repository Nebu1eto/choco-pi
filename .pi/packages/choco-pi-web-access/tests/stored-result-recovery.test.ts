import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type ExtensionActions,
  type ExtensionContextActions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-stored-result-recovery-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await writeFile(
  join(agentDir, "web-search.json"),
  JSON.stringify({ webSearch: { enabled: false }, autoOpenBrowser: false }),
  "utf8",
);

const { default: webAccess } = await import("../index.ts");
const {
  storeFetchedContentResult,
  getLastResetReason,
  resolveStoredResult,
  clearResults,
  getAllResults,
  getResult,
} = await import("../storage.ts");
const { formatMultiUrlFetchSummary } = await import("../fetch-continuation.ts");

interface Host {
  runner: ExtensionRunner;
  getSearchContent: ToolDefinition;
}

let host: Host;
const originalConsoleError = console.error;
const resetLogs: string[] = [];

function conversationModel(): Model<Api> {
  return {
    id: "fixture-conversation",
    name: "Fixture conversation",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  };
}

before(async () => {
  console.error = (...args: unknown[]) => {
    resetLogs.push(args.map(String).join(" "));
  };
  const root = await mkdtemp(join(tmpdir(), "choco-pi-stored-result-host-"));
  const loaderAgentDir = join(root, "agent");
  await mkdir(loaderAgentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    agentDir: loaderAgentDir,
    cwd: root,
    extensionFactories: [{ factory: webAccess, name: "web-access" }],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false,
  });
  const manager = SessionManager.inMemory(root, { id: "stored-result-recovery-session" });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    manager,
    new ModelRegistry(runtime),
  );
  let activeTools: string[] = [];
  const actions = {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: <Value>(customType: string, data?: Value) =>
      manager.appendCustomEntry(customType, data),
    setSessionName: () => undefined,
    getSessionName: () => undefined,
    setLabel: () => undefined,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    getSettings: () => settingsManager.getSettings(),
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    refreshTools: () => undefined,
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => undefined,
  } satisfies ExtensionActions;
  const model = conversationModel();
  const contextActions = {
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "fixture",
  } satisfies ExtensionContextActions;
  runner.bindCore(actions, contextActions);
  activeTools = runner.getAllRegisteredTools().map(({ definition }) => definition.name);
  await runner.emit({ type: "session_start", reason: "startup" });
  const getSearchContent = runner.getToolDefinition("get_search_content");
  assert.ok(getSearchContent);
  host = { runner, getSearchContent };
});

after(async () => {
  console.error = originalConsoleError;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function getContent(params: {
  responseId: string;
  urlIndex?: number;
}): Promise<AgentToolResult<unknown>> {
  return host.getSearchContent.execute(
    "stored-result-recovery",
    params,
    undefined,
    undefined,
    host.runner.createToolContext("stored-result-recovery", undefined),
  );
}

function storeFetch(id: string, timestamp: number, content: string): void {
  storeFetchedContentResult(id, {
    id,
    type: "fetch",
    timestamp,
    urls: [{ url: "https://example.test/doc", title: "Doc", content, error: null }],
  });
}

async function emitSessionTree(): Promise<void> {
  await host.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
}

test("get_search_content recovers a fetch result from disk after session_tree drops it", async () => {
  storeFetch("recoverfromdisk1", Date.now(), "recovered body text");
  const before = await getContent({ responseId: "recoverfromdisk1", urlIndex: 0 });
  assert.match(resultText(before), /recovered body text/);

  resetLogs.length = 0;
  // The fetch entry was never appended to this branch, so session_tree restore drops it.
  await emitSessionTree();
  assert.equal(getLastResetReason(), "session_tree");
  assert.ok(
    resetLogs.some((line) => /reset by session_tree; dropped [1-9]\d* id\(s\)/.test(line)),
    `expected a reset log, got ${JSON.stringify(resetLogs)}`,
  );

  const after = await getContent({ responseId: "recoverfromdisk1", urlIndex: 0 });
  assert.match(resultText(after), /# Doc\n\nrecovered body text/);
});

test("missing results name the reset reason and disk status", async () => {
  await emitSessionTree();
  const missing = await getContent({ responseId: "nowhereatall1", urlIndex: 0 });
  assert.match(
    resultText(missing),
    /No stored results for responseId "?nowhereatall1"?: not in memory \(reset by session_tree\); disk: miss\./,
  );

  storeFetch("expiredondisk1", Date.now() - 2 * 60 * 60 * 1000, "stale");
  await host.runner.emit({ type: "session_shutdown", reason: "quit" });
  const expired = await getContent({ responseId: "expiredondisk1", urlIndex: 0 });
  assert.match(resultText(expired), /not in memory \(reset by shutdown\); disk: expired/);
});

test("a reset during the disk read returns the data without repopulating the map", async () => {
  storeFetch("resetduringread1", Date.now(), "raced body text");
  clearResults("session_tree");
  assert.equal(getResult("resetduringread1"), null);

  // resolveStoredResult runs synchronously up to its first filesystem await, so this
  // clear lands after the generation snapshot and before the disk read settles.
  const pending = resolveStoredResult("resetduringread1");
  clearResults("shutdown");
  const lookup = await pending;

  if (lookup.data === null || lookup.source !== "disk") {
    assert.fail(`expected an uncached disk hit, got ${JSON.stringify(lookup)}`);
  }
  assert.equal(lookup.data.urls?.[0]?.content, "raced body text");
  assert.equal(lookup.cached, false);
  assert.match(lookup.message, /disk: hit \(not cached: reset by shutdown during read\)/);
  assert.equal(getResult("resetduringread1"), null);
  assert.deepEqual(getAllResults(), []);

  // Without a concurrent reset the same lookup rehydrates the map.
  const settled = await resolveStoredResult("resetduringread1");
  if (settled.data === null || settled.source !== "disk") {
    assert.fail(`expected a cached disk hit, got ${JSON.stringify(settled)}`);
  }
  assert.equal(settled.cached, true);
  assert.ok(getResult("resetduringread1"));
});

test("multi-URL fetch footer prints exact per-URL continuation calls", () => {
  const output = formatMultiUrlFetchSummary(
    [
      { url: "https://a.test/", title: "A", content: "x".repeat(45_000), error: null },
      { url: "https://b.test/", title: "B", content: "short", error: null },
      { url: "https://c.test/", title: "", content: "", error: "HTTP 500" },
    ],
    { kind: "stored", toolName: "get_search_content", responseId: "rid123", maxSliceChars: 30_000 },
  );
  assert.match(output, /\[0\] A \(https:\/\/a\.test\/\) offset 0, length 45000 chars/);
  assert.match(
    output,
    /Continue with get_search_content\(\{ responseId: "rid123", urlIndex: 0, offset: 0, limit: 30000 \}\)/,
  );
  assert.match(
    output,
    /Continue with get_search_content\(\{ responseId: "rid123", urlIndex: 1, offset: 0, limit: 5 \}\)/,
  );
  assert.match(output, /\[2\] https:\/\/c\.test\/: Error - HTTP 500/);
  assert.doesNotMatch(output, /urlIndex: 2/);
});
