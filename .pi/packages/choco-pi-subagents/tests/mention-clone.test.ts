import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type Model,
  type SystemMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type InlineExtension,
  getAgentDir,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildMentionCloneContext,
  createMentionClonePromptExtension,
  registerMentionCloneParentPromptObserver,
  runMentionClone,
  shouldHandleMentionCloneCompletion,
} from "../src/mention-clone.ts";

type HostBoundaryValue = {} | null | undefined;

function reinterpretHostValue<Target>(value: HostBoundaryValue): Target {
  // SAFETY: Test fixtures deliberately provide only the host members reached by each test.
  return value as Target;
}

const captureModel: Model<"openai-responses"> = {
  id: "mention-clone-capture",
  name: "Mention Clone Capture",
  api: "openai-responses",
  provider: "mention-clone-capture",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};

function system(content: string): SystemMessage {
  return { role: "system", content, timestamp: Date.now() };
}

function user(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function context(sessionManager: SessionManager, fallback = "fallback prompt") {
  return { sessionManager, getSystemPrompt: () => fallback, cwd: "/project" };
}

test("fresh context wrappers in one activation generation allow the completion", () => {
  const sessionStartCtx = {};
  const inputCtx = {};
  const generation = 1;

  assert.notEqual(inputCtx, sessionStartCtx);
  assert.equal(shouldHandleMentionCloneCompletion(generation, generation), true);
});

test("undefined and replacement activation generations reject the completion", () => {
  assert.equal(shouldHandleMentionCloneCompletion(undefined, undefined), false);
  assert.equal(shouldHandleMentionCloneCompletion(1, undefined), false);
  assert.equal(shouldHandleMentionCloneCompletion(undefined, 1), false);
  assert.equal(shouldHandleMentionCloneCompletion(1, 2), false);
});

test("clone prompt falls back before the first assistant reply", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage(user("@agent-reviewer inspect this"));

  const clone = buildMentionCloneContext(context(manager, "current preflight prompt"));

  assert.equal(clone.systemPrompt, "current preflight prompt");
  assert.equal(clone.messages.length, 1);
  const clonedMessage = clone.messages[0];
  assert.equal(clonedMessage?.role, "user");
  if (clonedMessage?.role === "user") {
    assert.equal(clonedMessage.content, "@agent-reviewer inspect this");
  }
});

test("clone prompt replays the compaction system snapshot", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage(system("base prompt"));
  const firstKept = manager.appendMessage(user("keep this"));
  manager.appendMessage(system("delta after tools changed"));
  manager.appendMessage(user("latest request"));
  manager.appendCompaction("summary", firstKept, 500);

  const clone = buildMentionCloneContext(context(manager));

  assert.equal(clone.systemPrompt, "base prompt\n\ndelta after tools changed");
  assert.ok(clone.messages.every((message) => message.role !== "system"));
});

test("clone prompt follows the selected branch", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage(system("base prompt"));
  const branchPoint = manager.appendMessage(user("shared request"));
  manager.appendMessage(system("abandoned branch delta"));
  manager.appendMessage(user("abandoned request"));
  manager.branch(branchPoint);
  manager.appendMessage(system("selected branch delta"));
  manager.appendMessage(user("selected request"));

  const clone = buildMentionCloneContext(context(manager));

  assert.equal(clone.systemPrompt, "base prompt\n\nselected branch delta");
  assert.deepEqual(
    clone.messages.map((message) => message.role),
    ["user", "user"],
  );
});

test("clone preserves an intentionally empty transcript prompt", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage(system(""));
  manager.appendMessage(user("request"));
  assert.equal(buildMentionCloneContext(context(manager, "fallback")).systemPrompt, "");
});

test("clone preserves the parent prompt verbatim for forced projection", () => {
  const manager = SessionManager.inMemory("/project");
  const prompt = "rules\n\n<cwd>\n/example\n</cwd>\n\nMANDATORY RULE\n\n<cwd>\n/project\n</cwd>";
  manager.appendMessage(system(prompt));
  manager.appendMessage(user("request"));
  assert.equal(buildMentionCloneContext(context(manager)).systemPrompt, prompt);
});

test("clone force extension sends empty and non-empty parent prompts verbatim", async () => {
  for (const forcedPrompt of ["", "rules\n\n<cwd>\n/project\n</cwd>"]) {
    let providerPrompt: string | undefined;
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    modelRuntime.registerProvider(captureModel.provider, {
      api: captureModel.api,
      apiKey: "test-key",
      models: [captureModel],
      streamSimple: (_model, transcript) => {
        providerPrompt = getCurrentSystemPrompt(transcript.messages);
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: captureModel.api,
          provider: captureModel.provider,
          model: captureModel.id,
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
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      },
    });
    const loader = new DefaultResourceLoader({
      cwd: "/project",
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createMentionClonePromptExtension(forcedPrompt)],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: "/project",
      model: captureModel,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory("/project"),
      noTools: "all",
    });
    try {
      await session.prompt("capture");
      assert.equal(providerPrompt, forcedPrompt);
    } finally {
      session.dispose();
    }
  }
});

test("clone snapshots its parent model before resource loading", async () => {
  const selected: string[] = [];
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const alternate = { ...captureModel, id: "alternate", name: "Alternate" };
  for (const model of [captureModel, alternate]) {
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "test-key",
      models: [model],
      streamSimple: (selectedModel) => {
        selected.push(selectedModel.id);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              api: selectedModel.api,
              provider: selectedModel.provider,
              model: selectedModel.id,
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
            },
          }),
        );
        return stream;
      },
    });
  }
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage(user("parent history"));
  const fixture = {
    cwd: "/project",
    model: captureModel,
    modelRegistry: registry,
    thinkingLevel: "off" as const,
    sessionManager: manager,
    getSystemPrompt: () => "BASE",
  };
  const ctx = reinterpretHostValue<ExtensionContext>(fixture);
  const tool = reinterpretHostValue<ToolDefinition>({
    name: "Agent",
    label: "Agent",
    description: "fixture",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "started" }] }),
  });
  const originalReload = DefaultResourceLoader.prototype.reload;
  let releaseReload: (() => void) | undefined;
  const pendingReload = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  DefaultResourceLoader.prototype.reload = () => pendingReload;
  try {
    const clone = runMentionClone({ ctx, type: "reviewer", message: "review", agentTool: tool });
    fixture.model = alternate;
    releaseReload?.();
    await clone;
    assert.deepEqual(selected, [captureModel.id]);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("clone uses the parent's effective forced provider prompt", async () => {
  const providerPrompts: string[] = [];
  let parentContext: ExtensionContext | undefined;
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  runtime.registerProvider(captureModel.provider, {
    api: captureModel.api,
    apiKey: "test-key",
    models: [captureModel],
    streamSimple: (_model, transcript) => {
      providerPrompts.push(getCurrentSystemPrompt(transcript.messages));
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: captureModel.api,
            provider: captureModel.provider,
            model: captureModel.id,
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
          },
        }),
      );
      return stream;
    },
  });
  const forceThenObserve: InlineExtension = {
    name: "force-then-observe",
    factory: (pi) => {
      // Production order: this package loads before the extensions that force prompts.
      registerMentionCloneParentPromptObserver(pi);
      pi.on("before_agent_start", () => ({ systemPrompt: "FORCED" }));
      pi.on("before_agent_start", (_event, ctx) => {
        parentContext = ctx;
      });
    },
  };
  const loader = new DefaultResourceLoader({
    cwd: "/project",
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "BASE",
    extensionFactories: [forceThenObserve],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: "/project",
    model: captureModel,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory("/project"),
    noTools: "all",
  });
  const tool = reinterpretHostValue<ToolDefinition>({
    name: "Agent",
    label: "Agent",
    description: "fixture",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "started" }] }),
  });
  try {
    await session.prompt("first turn");
    assert.ok(parentContext);
    await runMentionClone({
      ctx: parentContext,
      type: "reviewer",
      message: "review",
      agentTool: tool,
    });
    assert.deepEqual(providerPrompts, ["FORCED", "FORCED"]);
  } finally {
    session.dispose();
  }
});

function userText(message: UserMessage): string {
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

test("clone keeps the parent conversation across its own turn boundary", async () => {
  // Pi rebuilds agent.state.messages from the SessionManager at every turn_end,
  // so the parent history must be canonical session entries, not a pushed array.
  const requestUserTexts: string[][] = [];
  let parentContext: ExtensionContext | undefined;
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  runtime.registerProvider(captureModel.provider, {
    api: captureModel.api,
    apiKey: "test-key",
    models: [captureModel],
    streamSimple: (_model, transcript) => {
      requestUserTexts.push(
        transcript.messages.flatMap((message) =>
          message.role === "user" ? [userText(message)] : [],
        ),
      );
      const stream = createAssistantMessageEventStream();
      const firstCloneTurn = requestUserTexts.length === 2;
      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: firstCloneTurn ? "toolUse" : "stop",
          message: {
            role: "assistant",
            content: firstCloneTurn
              ? [{ type: "toolCall", id: "call-1", name: "Agent", arguments: {} }]
              : [{ type: "text", text: "done" }],
            api: captureModel.api,
            provider: captureModel.provider,
            model: captureModel.id,
            usage,
            stopReason: firstCloneTurn ? "toolUse" : "stop",
            timestamp: Date.now(),
          },
        }),
      );
      return stream;
    },
  });
  const observe: InlineExtension = {
    name: "observe",
    factory: (pi) => {
      pi.on("before_agent_start", (_event, ctx) => {
        parentContext = ctx;
      });
    },
  };
  const loader = new DefaultResourceLoader({
    cwd: "/project",
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "BASE",
    extensionFactories: [observe],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: "/project",
    model: captureModel,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory("/project"),
    noTools: "all",
  });
  const tool = reinterpretHostValue<ToolDefinition>({
    name: "Agent",
    label: "Agent",
    description: "fixture",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "started" }] }),
  });
  try {
    await session.prompt("parent history");
    assert.ok(parentContext);
    const result = await runMentionClone({
      ctx: parentContext,
      type: "reviewer",
      message: "review",
      agentTool: tool,
    });
    assert.equal(result.spawned, true, result.error ?? "clone did not spawn");
    assert.equal(requestUserTexts.length, 3);
    for (const texts of requestUserTexts.slice(1)) {
      assert.deepEqual(texts.slice(0, 1), ["parent history"]);
    }
  } finally {
    session.dispose();
  }
});
