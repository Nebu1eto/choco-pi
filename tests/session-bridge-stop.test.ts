import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
  installLiveSessionBridge,
  type LiveSessionBridgeDependencies,
} from "../.pi/extensions/session-bridge.ts";
import { isString } from "../.pi/extensions/lib/runtime-values.ts";
import { publishStopState, removeStopState } from "../.pi/extensions/lib/stop-control.ts";

const model: Model<Api> = {
  id: "stop",
  name: "stop",
  // SAFETY: Custom provider API identifiers are runtime strings accepted by registerProvider.
  api: "stop-test-api" as Api,
  provider: "stop-test",
  baseUrl: "http://127.0.0.1.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 2_000,
};

function response() {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
  if (isString(content)) return content;
  return content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
}

test("a stopped session holds mailbox messages, notifies once, and delivers after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-bridge-stop-"));
  let callback: (() => void) | undefined;
  const notices: string[] = [];
  const dependencies: LiveSessionBridgeDependencies = {
    mailboxPath: (sessionId) => join(root, "mailboxes", sessionId),
    publishLiveState: async () => undefined,
    removeOwnedLiveState: async () => undefined,
    watchMailbox: async (_directory, signal, onJsonFile) => {
      callback = onJsonFile;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  const requests: string[] = [];
  const factory: ExtensionFactory = (pi) => {
    pi.registerProvider("stop-test", {
      baseUrl: model.baseUrl,
      apiKey: "inert",
      api: model.api,
      authHeader: false,
      models: [model],
      streamSimple(_activeModel, context) {
        requests.push(
          context.messages
            .filter((message) => message.role === "user")
            .map((message) => userText(message.content))
            .join("\n"),
        );
        return response();
      },
    });
    installLiveSessionBridge(pi, dependencies);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
  };
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  const settings = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await loader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("stop-test", async () => ({ type: "api_key", key: "inert" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const { session }: { session: AgentSession } = await createAgentSession({
    cwd,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager: settings,
    noTools: "all",
  });
  await session.bindExtensions({});
  const sessionId = session.sessionId;
  try {
    const mailbox = dependencies.mailboxPath(sessionId);
    await mkdir(mailbox, { recursive: true });
    publishStopState(sessionId, { epoch: 1, closed: true });
    const write = (sequence: number, id: string, message: string) =>
      writeFile(
        join(mailbox, `${String(sequence).padStart(20, "0")}-${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          fromSessionId: "sender-1",
          targetSessionId: sessionId,
          mode: "steer",
          message,
          createdAt: new Date().toISOString(),
        }),
      );
    await write(1, "held-one", "held payload one");
    assert.ok(callback);
    callback();
    await waitFor(() => notices.length === 1);
    callback();
    await settle();
    assert.equal(requests.length, 0);
    assert.deepEqual(notices, [
      "Session bridge: message from sender-1 held while this session is stopped; it will be delivered after /resume-work.",
    ]);
    // The claim stays on disk, unacknowledged, so a restart recovers it.
    assert.equal((await readdir(mailbox)).filter((file) => file.endsWith(".claimed")).length, 1);

    await write(2, "held-two", "held payload two");
    callback();
    await waitFor(() => notices.length === 2);
    assert.equal(requests.length, 0);

    publishStopState(sessionId, { epoch: 2, closed: false });
    await waitFor(() => requests.some((text) => text.includes("held payload two")));
    await session.waitForIdle();
    assert.equal(
      requests.some((text) => text.includes("held payload one")),
      true,
    );
    assert.ok(
      requests.join("\n").indexOf("held payload one") <
        requests.join("\n").indexOf("held payload two"),
    );
    assert.equal(notices.length, 2);
  } finally {
    removeStopState(sessionId);
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
