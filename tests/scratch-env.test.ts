import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import scratchEnvExtension from "../.pi/extensions/scratch-env.ts";
import { isString } from "../.pi/extensions/lib/runtime-values.ts";
import {
  PREVIOUS_SCRATCH_DIR_ENV,
  ROOT_SESSION_ENV,
  SCRATCH_DIR_ENV,
  registerScratchRoot,
  setPreviousScratchDir,
  unregisterScratchRoot,
} from "../.pi/extensions/lib/scratch-path.ts";

const model: Model<Api> = {
  id: "scratch",
  name: "scratch",
  // SAFETY: Custom provider API identifiers are runtime strings accepted by registerProvider.
  api: "scratch-test-api" as Api,
  provider: "scratch-test",
  baseUrl: "http://127.0.0.1.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 2_000,
};

const COMMAND =
  'printf \'%s|%s|%s\' "$PI_SCRATCH_DIR" "$PI_ROOT_SESSION_ID" "$PI_PREVIOUS_SCRATCH_DIR"';

function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
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
    stopReason,
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: stopReason, message });
  stream.end();
  return stream;
}

type Prepare = (sessionId: string) => (() => void) | undefined;

/** Runs the real bash tool inside a real session and returns its output. */
async function runBash(prepare?: Prepare): Promise<{ output: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), "choco-scratch-env-"));
  let calls = 0;
  const factory: ExtensionFactory = (pi) => {
    pi.registerProvider("scratch-test", {
      baseUrl: model.baseUrl,
      apiKey: "inert",
      api: model.api,
      authHeader: false,
      models: [model],
      streamSimple() {
        calls += 1;
        if (calls > 1) return response([{ type: "text", text: "done" }], "stop");
        return response(
          [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: COMMAND } }],
          "toolUse",
        );
      },
    });
    scratchEnvExtension(pi);
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
  await credentials.modify("scratch-test", async () => ({ type: "api_key", key: "inert" }));
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
  });
  await session.bindExtensions({});
  const sessionId = session.sessionId;
  const cleanup = prepare?.(sessionId);
  try {
    const outputs: string[] = [];
    session.subscribe((event) => {
      if (event.type !== "tool_execution_end" || event.toolName !== "bash") return;
      const result = event.result;
      for (const part of result.content)
        if (part.type === "text" && isString(part.text)) outputs.push(part.text);
    });
    await session.prompt("run");
    assert.equal(outputs.length, 1);
    return { output: outputs[0] ?? "", sessionId };
  } finally {
    cleanup?.();
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function withEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const CLEAN = {
  [ROOT_SESSION_ENV]: undefined,
  [SCRATCH_DIR_ENV]: undefined,
  [PREVIOUS_SCRATCH_DIR_ENV]: undefined,
};

test("bash receives the session's scratch directory and root id", async () => {
  const restore = withEnv(CLEAN);
  try {
    const { output, sessionId } = await runBash();
    assert.equal(output.trim(), `/tmp/choco-pi/${sessionId}/|${sessionId}|`);
  } finally {
    restore();
  }
});

test("a subagent child's bash resolves the lineage root and previous directory", async () => {
  const restore = withEnv(CLEAN);
  try {
    const { output } = await runBash((sessionId) => {
      registerScratchRoot(sessionId, "root-lineage");
      setPreviousScratchDir(sessionId, "/tmp/choco-pi/older/");
      return () => unregisterScratchRoot(sessionId);
    });
    assert.equal(output.trim(), "/tmp/choco-pi/root-lineage/|root-lineage|/tmp/choco-pi/older/");
  } finally {
    restore();
  }
});

test("inherited scratch variables are never replaced", async () => {
  const restore = withEnv({
    [ROOT_SESSION_ENV]: "inherited-root",
    [SCRATCH_DIR_ENV]: "/tmp/choco-pi/inherited-dir/",
    [PREVIOUS_SCRATCH_DIR_ENV]: "/tmp/choco-pi/inherited-prev/",
  });
  try {
    const { output } = await runBash();
    assert.equal(
      output.trim(),
      "/tmp/choco-pi/inherited-dir/|inherited-root|/tmp/choco-pi/inherited-prev/",
    );
  } finally {
    restore();
  }
});
