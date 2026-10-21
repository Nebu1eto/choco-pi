/**
 * Capture retention across rebinds (D8) through a real `createAgentSession`
 * (captured Anthropic and xAI provider streams, fake transports, no network):
 * replacing the main owner for the SAME session (model change and back, an
 * Anthropic or xAI mode round trip whose off state installs no replay binding
 * because no checkpoint exists) keeps the session's wire captures, so the
 * native lane still finds a scope-matched capture; a session start for a
 * DIFFERENT session releases the previous session's captures, and shutdown
 * releases the current one's.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { ANTHROPIC_BACKEND_ID, hasUsableCapture } from "../src/anthropic/backend.ts";
import { capturesFor, releaseSessionCaptures } from "../src/anthropic/capture.ts";
import { readAnthropicCompactionMode } from "../src/anthropic/mode.ts";
import { getCoordinator } from "../src/background/registry.ts";
import registerCompaction from "../src/index.ts";
import { mainOwnerKey } from "../src/ownership.ts";
import { BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL } from "../src/preferences-section.ts";
import { releaseXaiSessionCaptures, xaiCapturesFor } from "../src/xai/capture.ts";
import { readXaiCompactionMode } from "../src/xai/mode.ts";
import { textResponse as xaiTextResponse } from "./xai-rig.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const OAUTH_KEY = "sk-ant-oat01-capture-retention-non-secret-placeholder";
const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
const OTHER_MODEL: Model<"anthropic-messages"> = {
  ...MODEL,
  id: "claude-sonnet-5-5",
  name: "Synthetic Sonnet",
};
const XAI_KEY = "xai-capture-retention-non-secret-placeholder";
const XAI_MODEL: Model<"openai-responses"> = {
  id: "grok-retention-1",
  name: "Synthetic Grok",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
const BLOCK = {
  type: "compaction",
  content: "RETENTION synthetic native summary",
  signature: "retention-synthetic-signature",
};
const PADDING = "detail ".repeat(200);
const SCOPE = { provider: MODEL.provider, model: MODEL.id, baseUrl: MODEL.baseUrl };

type Frame = JsonObject & { readonly type: string };

function reply(content: JsonObject, stopReason: string): Response {
  const frames: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "retention",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 90, output_tokens: 30 }],
      },
    },
    { type: "message_stop" },
  ];
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SectionSchema = Type.Object({
  handleChange: Type.Function([Type.String(), Type.String()], Type.Unknown()),
});
const ProviderSchema = Type.Object({
  buildSections: Type.Function([Type.Unknown()], Type.Array(SectionSchema)),
});

interface Rig {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly lane: { count: number };
  /** Requests the captured xAI provider sent. */
  readonly xaiSent: { count: number };
  readonly ctx: () => ExtensionContext;
  dispose(): Promise<void>;
}

interface RigOptions {
  /** The sidecar's `anthropicNative` lane; off, a mode switch off leaves no Anthropic binding. */
  readonly anthropicNative?: boolean;
}

async function createRig(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-capture-retention-"));
  // Mode switches write their files under the agent directory: keep them in the temp dir.
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  const sidecar = join(dir, "background-compaction.json");
  const anthropicNative = options.anthropicNative ?? true;
  await writeFile(
    sidecar,
    JSON.stringify({
      enabled: true,
      // Some lane keeps the owner attached, so every mode switch replaces it.
      text: !anthropicNative,
      anthropicNative,
      prepareAt: 0.99,
      hysteresis: 0,
      reserveTokens: 0,
      retryBaseMs: 0,
      cooldownMs: 0,
      timeoutMs: 20_000,
      maxOutputTokens: 1_000,
    }),
  );
  const lane = { count: 0 };
  const laneFetch: typeof globalThis.fetch = async () => {
    lane.count += 1;
    return reply(BLOCK, "compaction");
  };
  let foregroundIndex = 0;
  const foregroundFetch: typeof globalThis.fetch = async () =>
    reply({ type: "text", text: `RETENTION-ACK-${foregroundIndex++} ${PADDING}` }, "end_turn");
  const xaiSent = { count: 0 };
  const xaiFetch: typeof globalThis.fetch = async () => {
    xaiSent.count += 1;
    return xaiTextResponse(`RETENTION-XAI-${xaiSent.count} ${PADDING}`);
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider("anthropic", {
    api: "anthropic-messages",
    apiKey: OAUTH_KEY,
    models: [MODEL, OTHER_MODEL],
    streamSimple: () => {
      throw new Error("unwrapped provider stream used");
    },
  });
  runtime.registerProvider("xai", {
    api: "openai-responses",
    apiKey: XAI_KEY,
    models: [XAI_MODEL],
    streamSimple: () => {
      throw new Error("unwrapped xAI provider stream used");
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  let latestCtx: ExtensionContext | undefined;
  const extension = (pi: ExtensionAPI): void => {
    pi.on("session_start", (_event, ctx) => {
      latestCtx = ctx;
      ctx.ui.notify = () => undefined;
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 16_384 }),
      background: {
        settingsPaths: () => [sidecar],
        // The real mode files under the temp agent dir (default server-side), so a
        // Preferences mode switch is what the next session start reads.
        anthropic: {
          fetch: laneFetch,
          capture: { fetch: foregroundFetch },
          readMode: readAnthropicCompactionMode,
        },
        xai: { capture: { fetch: xaiFetch }, readMode: readXaiCompactionMode },
      },
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: MODEL,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const firstSessionId = manager.getSessionId();
  return {
    session,
    manager,
    lane,
    xaiSent,
    ctx: () => {
      assert.ok(latestCtx, "a session started");
      return latestCtx;
    },
    async dispose() {
      session.dispose();
      for (const id of [firstSessionId, manager.getSessionId()]) {
        releaseSessionCaptures(id);
        releaseXaiSessionCaptures(id);
      }
      if (previousAgentDir === undefined) Reflect.deleteProperty(process.env, AGENT_DIR_ENV);
      else process.env[AGENT_DIR_ENV] = previousAgentDir;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function ownerGeneration(rig: Rig): number {
  return getCoordinator(mainOwnerKey(rig.manager.getSessionId()))?.status().ownerGeneration ?? -1;
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Change a Preferences row and wait until the main owner was replaced. */
async function changeRow(rig: Rig, id: string, value: string): Promise<void> {
  const provider: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL,
  )?.value;
  assert.ok(Value.Check(ProviderSchema, provider), "the Preferences provider is published");
  const [section] = provider.buildSections(rig.ctx());
  assert.ok(section);
  const before = ownerGeneration(rig);
  section.handleChange(id, value);
  await waitFor(`${id}=${value} to replace the owner`, () => ownerGeneration(rig) > before);
}

/** A native preparation on the current owner finds a scope-matched capture. */
async function prepareNative(rig: Rig): Promise<void> {
  const coordinator = getCoordinator(mainOwnerKey(rig.manager.getSessionId()));
  assert.ok(coordinator);
  const before = rig.lane.count;
  const request = await coordinator.requestPreparation({
    trigger: "manual",
    backendId: ANTHROPIC_BACKEND_ID,
  });
  assert.ok(request.accepted, JSON.stringify(request));
  await waitFor("the native preparation", () => {
    const state = coordinator.status().state;
    return state !== "queued" && state !== "preparing";
  });
  const status = coordinator.status();
  assert.equal(status.state, "ready", JSON.stringify(status));
  assert.equal(rig.lane.count, before + 1);
  coordinator.cancel();
}

test(
  "model_select away and back keeps the session's captures; the native lane still finds one",
  { timeout: 60_000 },
  async () => {
    const rig = await createRig();
    try {
      for (let turn = 0; turn < 3; turn++) await rig.session.prompt(`RETENTION-${turn} ${PADDING}`);
      const sessionId = rig.manager.getSessionId();
      const captured = capturesFor(sessionId).map((capture) => capture.sequence);
      assert.equal(captured.length, 3);
      await rig.session.setModel(OTHER_MODEL);
      assert.deepEqual(
        capturesFor(sessionId).map((capture) => capture.sequence),
        captured,
        "kept across the rebind to another model",
      );
      await rig.session.setModel(MODEL);
      assert.deepEqual(
        capturesFor(sessionId).map((capture) => capture.sequence),
        captured,
      );
      assert.equal(hasUsableCapture(sessionId, SCOPE), true);
      await prepareNative(rig);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "an Anthropic mode round trip without a checkpoint keeps the session's captures",
  { timeout: 60_000 },
  async () => {
    // No anthropic-native lane: mode off and no checkpoint installs no Anthropic binding.
    const rig = await createRig({ anthropicNative: false });
    try {
      for (let turn = 0; turn < 3; turn++) await rig.session.prompt(`RETENTION-${turn} ${PADDING}`);
      const sessionId = rig.manager.getSessionId();
      const captured = capturesFor(sessionId).map((capture) => capture.sequence);
      assert.equal(captured.length, 3);
      await changeRow(rig, "compactionAnthropic", "choco-pi");
      assert.deepEqual(
        capturesFor(sessionId).map((capture) => capture.sequence),
        captured,
        "kept while the mode is off and no binding exists",
      );
      await changeRow(rig, "compactionAnthropic", "server-side");
      assert.deepEqual(
        capturesFor(sessionId).map((capture) => capture.sequence),
        captured,
        "still there once the mode is back on",
      );
      assert.equal(hasUsableCapture(sessionId, SCOPE), true);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "an xAI mode round trip without a checkpoint keeps the session's xAI capture",
  { timeout: 60_000 },
  async () => {
    const rig = await createRig();
    try {
      const sessionId = rig.manager.getSessionId();
      // xAI server-side is the default mode: the session is bound and its xAI request captured.
      await rig.session.setModel(XAI_MODEL);
      await rig.session.prompt(`RETENTION-XAI ${PADDING}`);
      assert.equal(rig.xaiSent.count, 1, "the captured xAI provider sent the prompt");
      const captured = xaiCapturesFor(sessionId).map((capture) => capture.sequence);
      assert.equal(captured.length, 1);
      // Back on the Anthropic model, whose owner every mode switch replaces.
      await rig.session.setModel(MODEL);
      assert.deepEqual(
        xaiCapturesFor(sessionId).map((capture) => capture.sequence),
        captured,
      );
      await changeRow(rig, "compactionXai", "choco-pi");
      assert.deepEqual(
        xaiCapturesFor(sessionId).map((capture) => capture.sequence),
        captured,
        "kept while the xAI mode is off and no xAI binding exists",
      );
      await changeRow(rig, "compactionXai", "server-side");
      assert.deepEqual(
        xaiCapturesFor(sessionId).map((capture) => capture.sequence),
        captured,
        "still there once the xAI mode is back on",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a session start for a different session releases the previous captures; shutdown releases the current",
  { timeout: 60_000 },
  async () => {
    const rig = await createRig();
    try {
      await rig.session.prompt(`RETENTION-OLD ${PADDING}`);
      const oldId = rig.manager.getSessionId();
      assert.equal(capturesFor(oldId).length, 1);
      await rig.session.setModel(XAI_MODEL);
      await rig.session.prompt(`RETENTION-OLD-XAI ${PADDING}`);
      await rig.session.setModel(MODEL);
      assert.equal(xaiCapturesFor(oldId).length, 1);
      rig.manager.newSession();
      const newId = rig.manager.getSessionId();
      assert.notEqual(newId, oldId);
      // The runtime's session replacement re-creates the agent; this harness only renames its requests.
      rig.session.agent.sessionId = newId;
      await rig.session.extensionRunner.emit({ type: "session_start", reason: "new" });
      assert.equal(capturesFor(oldId).length, 0, "the previous session's captures are released");
      assert.equal(xaiCapturesFor(oldId).length, 0, "and its xAI captures");
      await rig.session.prompt(`RETENTION-NEW ${PADDING}`);
      assert.equal(capturesFor(newId).length, 1, "the new session is captured");
      await rig.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.equal(capturesFor(newId).length, 0, "shutdown releases the current session's");
    } finally {
      await rig.dispose();
    }
  },
);
