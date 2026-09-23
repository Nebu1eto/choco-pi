import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  installAgentTools,
  installLiveSessionBridge,
  registerManagedSession,
  type LiveSessionBridgeDependencies,
} from "../.pi/extensions/session-bridge.ts";
import { isString } from "../.pi/extensions/lib/runtime-values.ts";
import { createSessionSdkFixture } from "./helpers/session-sdk-fixture.ts";

type Deferred = { promise: Promise<void>; resolve(): void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const model: Model<Api> = {
  id: "admission",
  name: "admission",
  // SAFETY: Custom provider API identifiers are runtime strings accepted by registerProvider.
  api: "admission-test-api" as Api,
  provider: "admission-test",
  baseUrl: "http://127.0.0.1.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 2_000,
};

function response(value: string, gate?: Promise<void>) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: value }],
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
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: value, partial: message });
  const finish = () => {
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  };
  if (gate) void gate.then(finish);
  else finish();
  return stream;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
  if (isString(content)) return content;
  return content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

async function targetFixture(
  root: string,
  extraFactories: readonly ExtensionFactory[] = [],
  responseGate?: Promise<void>,
): Promise<{ session: AgentSession; requests: string[] }> {
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  const requests: string[] = [];
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider("admission-test", {
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
        return response("ok", responseGate);
      },
    });
  };
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
    extensionFactories: [provider, ...extraFactories],
  });
  await loader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("admission-test", async () => ({ type: "api_key", key: "inert" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager: settings,
    noTools: "all",
  });
  await session.bindExtensions({});
  return { session, requests };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function sendTool(sender: AgentSession, sessionId: string, message: string) {
  const definition = sender.extensionRunner.getToolDefinition("session_send");
  assert.ok(definition);
  return definition.execute(
    `send-${message}`,
    { session_id: sessionId, message },
    new AbortController().signal,
    () => undefined,
    sender.extensionRunner.createContext(),
  );
}

test("concurrent idle managed sends admit once, then steer in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-admission-direct-"));
  const entered = deferred();
  const release = deferred();
  const barrier: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", async () => {
      entered.resolve();
      await release.promise;
    });
  };
  const target = await targetFixture(root, [barrier]);
  const sender = await createSessionSdkFixture(root, [installAgentTools]);
  const unregister = registerManagedSession(target.session);
  try {
    const first = sendTool(sender.session, target.session.sessionId, "message one");
    const second = sendTool(sender.session, target.session.sessionId, "message two");
    await entered.promise;
    assert.equal(target.requests.length, 0);
    release.resolve();
    const results = await Promise.all([first, second]);
    for (const result of results) {
      const text = result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      assert.match(text, /"accepted": "direct"/);
    }
    await target.session.waitForIdle();
    assert.equal(target.session.state.errorMessage?.includes("already processing") ?? false, false);
    assert.equal(
      target.requests.some((text) => text.includes("message one")),
      true,
    );
    assert.equal(
      target.requests.some((text) => text.includes("message two")),
      true,
    );
    assert.ok(
      target.requests.join("\n").indexOf("message one") <
        target.requests.join("\n").indexOf("message two"),
    );
  } finally {
    unregister();
    sender.session.dispose();
    target.session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("busy managed sends acknowledge immediately without turn serialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-admission-busy-"));
  const release = deferred();
  const target = await targetFixture(root, [], release.promise);
  const sender = await createSessionSdkFixture(root, [installAgentTools]);
  const unregister = registerManagedSession(target.session);
  try {
    const seed = target.session.sendUserMessage("busy seed");
    await waitFor(() => target.requests.length === 1 && !target.session.isIdle);
    const sends = Promise.all([
      sendTool(sender.session, target.session.sessionId, "busy one"),
      sendTool(sender.session, target.session.sessionId, "busy two"),
    ]);
    const acknowledged = await Promise.race([
      sends.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(acknowledged, true);
    release.resolve();
    await seed;
    await target.session.waitForIdle();
  } finally {
    unregister();
    sender.session.dispose();
    target.session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("mailbox startup admission delivers sequential writes without claim timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-admission-mailbox-"));
  const entered = deferred();
  const release = deferred();
  let callback: (() => void) | undefined;
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
  const barrier: ExtensionFactory = (pi) => {
    installLiveSessionBridge(pi, dependencies);
    pi.on("before_agent_start", async () => {
      entered.resolve();
      await release.promise;
    });
  };
  const target = await targetFixture(join(root, "target"), [barrier]);
  try {
    const mailbox = dependencies.mailboxPath(target.session.sessionId);
    await mkdir(mailbox, { recursive: true });
    for (const [sequence, id, message] of [
      [3, "mail-three", "mailbox three"],
      [4, "mail-four", "mailbox four"],
    ] as const) {
      await writeFile(
        join(mailbox, `${String(sequence).padStart(20, "0")}-${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          fromSessionId: "sender",
          targetSessionId: target.session.sessionId,
          mode: "steer",
          message,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    assert.ok(callback);
    callback();
    await entered.promise;
    release.resolve();
    await waitFor(() => target.requests.some((text) => text.includes("mailbox four")));
    await target.session.waitForIdle();
    assert.equal(
      target.requests.some((text) => text.includes("mailbox three")),
      true,
    );
    assert.equal(
      target.requests.some((text) => text.includes("mailbox four")),
      true,
    );
    assert.ok(
      target.requests.join("\n").indexOf("mailbox three") <
        target.requests.join("\n").indexOf("mailbox four"),
    );
  } finally {
    target.session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
