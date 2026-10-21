/**
 * Registration seams through a real host session: the replay-disable path
 * journals exactly one `disable` lane record with the notices unchanged, and
 * `/compaction-allow-loss` journals consent only for an opaque checkpoint.
 * Provider-supplied codes never reach the journal, a late rejection of a
 * request from an earlier binding is dropped, and shutdown withdraws the
 * registration's consent resolver.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { releaseSessionCaptures } from "../src/anthropic/capture.ts";
import { isAnthropicDetails } from "../src/anthropic/details.ts";
import { LANE_RECORD_TYPE, laneRecordsOf } from "../src/background/lane-journal.ts";
import registerCompaction from "../src/index.ts";
import {
  lossAuthorizedFor,
  OPAQUE_CONSENT_SYMBOL,
  type OpaqueConsentResolver,
} from "../src/opaque-checkpoint.ts";
import { BACKGROUND_OFF_SETTINGS_PATHS } from "./host-harness.ts";

const OAUTH_KEY = "sk-ant-oat01-register-announce-non-secret-placeholder";
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
const BLOCK = {
  type: "compaction",
  content: "ANNOUNCE synthetic native summary",
  signature: "announce-synthetic-signature",
};
const DISABLE_PREFIX = "Anthropic server-side compaction";
/** A provider-supplied code: shown in the notice, never journaled. */
const PROVIDER_CODE = "compaction_private-payload";

/** The replay-disable notice exactly as before the journal existed. */
function disableNotice(code: string): string {
  return `${DISABLE_PREFIX}: the provider rejected the replayed checkpoint (${code}); server-side compaction is off for this session, its summary text is sent instead and later compactions are summarized locally.`;
}

function rejection(code: string): Response {
  return errorResponse(400, {
    type: "invalid_request_error",
    message: "synthetic signature rejection",
    details: { error_code: code },
  });
}

type Frame = JsonObject & { readonly type: string };

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frames(options: { readonly block?: boolean; readonly text?: string }): Frame[] {
  const list: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "announce",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  ];
  const block =
    options.block === true ? BLOCK : { type: "text", text: options.text ?? "ANNOUNCE-TEXT" };
  list.push({ type: "content_block_start", index: 0, content_block: block });
  list.push({ type: "content_block_stop", index: 0 });
  list.push({
    type: "message_delta",
    delta: { stop_reason: options.block === true ? "compaction" : "end_turn", stop_sequence: null },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ type: "compaction", input_tokens: 90, output_tokens: 30 }],
    },
  });
  list.push({ type: "message_stop" });
  return list;
}

function errorResponse(status: number, error: JsonObject): Response {
  return new Response(JSON.stringify({ type: "error", error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

interface Rig {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly notices: string[];
  dispose(): Promise<void>;
}

async function createRig(options: {
  readonly foreground: typeof globalThis.fetch;
  readonly lane: typeof globalThis.fetch;
  readonly seed?: (manager: SessionManager) => void;
}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-register-announce-"));
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
    models: [MODEL],
    streamSimple: (_active, context, streamOptions) =>
      installedStreamSimple(MODEL, context, { ...streamOptions, fetch: options.foreground }),
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const notices: string[] = [];
  const extension = (pi: ExtensionAPI): void => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 16_384 }),
      background: {
        settingsPaths: () => BACKGROUND_OFF_SETTINGS_PATHS,
        anthropic: {
          readMode: async () => "server-side",
          fetch: options.lane,
          capture: { fetch: options.foreground },
        },
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
  manager.appendMessage({ role: "user", content: "AN-PREFIX-A", timestamp: 0 });
  manager.appendMessage(assistantMessage("AN-PREFIX-B"));
  manager.appendMessage({ role: "user", content: "AN-KEPT-C", timestamp: 0 });
  manager.appendMessage(assistantMessage("AN-KEPT-D"));
  options.seed?.(manager);
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
  const sessionId = manager.getSessionId();
  return {
    session,
    manager,
    notices,
    async dispose() {
      session.dispose();
      releaseSessionCaptures(sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const textFetch: typeof globalThis.fetch = async () => sse(frames({ text: "AN-TEXT" }));

test(
  "a replay rejection journals one disable record with provider-error; the notice is unchanged",
  { timeout: 30_000 },
  async () => {
    let reject = false;
    const foreground: typeof globalThis.fetch = async () => {
      if (reject) {
        reject = false;
        return rejection(PROVIDER_CODE);
      }
      return sse(frames({ text: "AN-ANSWER" }));
    };
    const lane: typeof globalThis.fetch = async () => sse(frames({ block: true }));
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("AN-GO");
      await rig.session.compact();
      const checkpoint = rig.manager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(checkpoint !== undefined && isAnthropicDetails(checkpoint.details));
      assert.deepEqual(laneRecordsOf(rig.manager.getBranch()), []);

      reject = true;
      await rig.session.prompt("AN-REJECTED");
      await rig.session.prompt("AN-AFTER");
      await rig.session.compact();

      const records = laneRecordsOf(rig.manager.getBranch());
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], {
        customType: LANE_RECORD_TYPE,
        schemaVersion: 1,
        at: records[0]?.at,
        sessionId: rig.manager.getSessionId(),
        provider: "anthropic",
        route: "replay",
        event: "disable",
        from: "anthropic-native",
        reason: "provider-error",
        checkpointEntryId: checkpoint.id,
        noticeAttempted: true,
      });
      assert.ok(
        !JSON.stringify(records).includes(PROVIDER_CODE),
        "the provider code is not journaled",
      );
      // The same single disable notice as before the journal existed, and no other notice.
      assert.deepEqual(rig.notices, [disableNotice(PROVIDER_CODE)]);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a replay rejection arriving after a model change is dropped; a later binding journals normally",
  { timeout: 30_000 },
  async () => {
    let reject = false;
    let hold: { readonly started: () => void; readonly release: Promise<void> } | undefined;
    const foreground: typeof globalThis.fetch = async () => {
      if (reject) {
        reject = false;
        const held = hold;
        hold = undefined;
        if (held !== undefined) {
          held.started();
          await held.release;
        }
        return rejection(PROVIDER_CODE);
      }
      return sse(frames({ text: "AN-ANSWER" }));
    };
    const lane: typeof globalThis.fetch = async () => sse(frames({ block: true }));
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("AN-GO");
      await rig.session.compact();
      const checkpoint = rig.manager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(checkpoint !== undefined && isAnthropicDetails(checkpoint.details));

      // The replayed request starts under the first binding; the model change rebinds.
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      hold = { started: started.resolve, release: release.promise };
      reject = true;
      const stale = rig.session.prompt("AN-STALE");
      await started.promise;
      // `setModel` emits nothing for an equal model; emit the host event the same way.
      await rig.session.extensionRunner.emit({
        type: "model_select",
        model: MODEL,
        previousModel: MODEL,
        source: "set",
      });
      release.resolve();
      await stale;
      await rig.session.prompt("AN-AFTER-STALE");

      assert.deepEqual(laneRecordsOf(rig.manager.getBranch()), [], "no stale disable record");
      assert.deepEqual(rig.notices, [], "no stale notice");

      // A fresh request under a later binding still journals and notifies normally.
      await rig.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await rig.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      reject = true;
      await rig.session.prompt("AN-FRESH-REJECTED");
      await rig.session.prompt("AN-FRESH-AFTER");
      const records = laneRecordsOf(rig.manager.getBranch());
      assert.equal(records.length, 1);
      assert.equal(records[0]?.event, "disable");
      assert.equal(records[0]?.reason, "provider-error");
      assert.equal(records[0]?.checkpointEntryId, checkpoint.id);
      assert.deepEqual(rig.notices, [disableNotice(PROVIDER_CODE)]);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "/compaction-allow-loss without an opaque checkpoint notifies and journals nothing",
  { timeout: 30_000 },
  async () => {
    const rig = await createRig({ foreground: textFetch, lane: textFetch });
    try {
      await rig.session.prompt("/compaction-allow-loss");
      assert.deepEqual(rig.notices, ["Background compaction: no opaque checkpoint on this branch"]);
      assert.deepEqual(laneRecordsOf(rig.manager.getBranch()), []);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "/compaction-allow-loss over an opaque checkpoint journals one consent record for it",
  { timeout: 30_000 },
  async () => {
    let checkpointId = "";
    const rig = await createRig({
      foreground: textFetch,
      lane: textFetch,
      seed: (manager) => {
        const kept = manager.getBranch().at(-2)?.id ?? null;
        checkpointId = manager.appendCompaction("placeholder", kept, 100, {
          strategy: "xai-responses-compaction-v1",
        });
      },
    });
    try {
      const sessionId = rig.manager.getSessionId();
      assert.equal(lossAuthorizedFor(sessionId, checkpointId), false);
      await rig.session.prompt("/compaction-allow-loss");
      assert.deepEqual(rig.notices, [
        `Background compaction: loss authorized for checkpoint ${checkpointId} (this session only)`,
      ]);
      const records = laneRecordsOf(rig.manager.getBranch());
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], {
        customType: LANE_RECORD_TYPE,
        schemaVersion: 1,
        at: records[0]?.at,
        sessionId,
        provider: "xai",
        route: "manual",
        event: "consent",
        from: "xai-native",
        reason: "consent",
        checkpointEntryId: checkpointId,
        noticeAttempted: true,
      });
      assert.equal(lossAuthorizedFor(sessionId, checkpointId), true);
      assert.equal(lossAuthorizedFor(sessionId, "another-checkpoint"), false);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "shutdown withdraws the registration's consent resolver; a reactivation publishes it again",
  { timeout: 30_000 },
  async () => {
    // A shape-compatible slot that records which resolvers are published and consulted.
    const resolvers = new Set<OpaqueConsentResolver>();
    let consulted = 0;
    const slot = {
      version: 1,
      lossAuthorizedFor: (sessionId: string, entryId: string): boolean => {
        for (const resolver of resolvers) {
          consulted += 1;
          if (resolver(sessionId, entryId)) return true;
        }
        return false;
      },
      publish: (resolver: OpaqueConsentResolver): (() => void) => {
        resolvers.add(resolver);
        return () => {
          resolvers.delete(resolver);
        };
      },
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, OPAQUE_CONSENT_SYMBOL);
    Object.defineProperty(globalThis, OPAQUE_CONSENT_SYMBOL, { value: slot, configurable: true });
    let checkpointId = "";
    const rig = await createRig({
      foreground: textFetch,
      lane: textFetch,
      seed: (manager) => {
        const kept = manager.getBranch().at(-2)?.id ?? null;
        checkpointId = manager.appendCompaction("placeholder", kept, 100, {
          strategy: "xai-responses-compaction-v1",
        });
      },
    });
    try {
      const sessionId = rig.manager.getSessionId();
      assert.equal(resolvers.size, 1, "published once at registration");
      await rig.session.prompt("/compaction-allow-loss");
      assert.equal(lossAuthorizedFor(sessionId, checkpointId), true);

      await rig.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      assert.equal(resolvers.size, 0, "shutdown removed the resolver");
      consulted = 0;
      assert.equal(lossAuthorizedFor(sessionId, checkpointId), false);
      assert.equal(consulted, 0, "the shut-down registration is not consulted");

      await rig.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      assert.equal(resolvers.size, 1, "the reactivated registration published again");
      assert.equal(
        lossAuthorizedFor(sessionId, checkpointId),
        false,
        "consent ended with shutdown",
      );
      assert.equal(consulted, 1, "the reactivated registration is consulted");
      await rig.session.prompt("/compaction-allow-loss");
      assert.equal(lossAuthorizedFor(sessionId, checkpointId), true);
    } finally {
      await rig.dispose();
      Reflect.deleteProperty(globalThis, OPAQUE_CONSENT_SYMBOL);
      if (previous !== undefined)
        Object.defineProperty(globalThis, OPAQUE_CONSENT_SYMBOL, previous);
    }
  },
);
