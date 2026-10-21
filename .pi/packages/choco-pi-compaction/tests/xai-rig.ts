/**
 * Shared real-session rig for xAI server-side compaction tests: a real
 * `createAgentSession` with the INSTALLED openai-responses adapter on scripted
 * transports (no network), the compaction extension registered with injected
 * seams, recorded notices, and lane-journal access. Test-only; never imported
 * by `src`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import {
  type AgentSession,
  type CompactionEntry,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { OpaqueHistoryMode } from "../src/anthropic/mode.ts";
import { type LaneRecord, laneRecordsOf } from "../src/background/lane-journal.ts";
import registerCompaction from "../src/index.ts";
import {
  parseXaiWireBody,
  releaseXaiSessionCaptures,
  type XaiWireBody,
} from "../src/xai/capture.ts";
import type { XaiCompactionMode } from "../src/xai/mode.ts";
import { BACKGROUND_OFF_SETTINGS_PATHS } from "./host-harness.ts";

export const XAI_API_KEY = "xai-rig-non-secret-placeholder";
export const XAI_NOTICE_PREFIX = "xAI server-side compaction";

function grok(id: string): Model<"openai-responses"> {
  return {
    id,
    name: `Synthetic ${id}`,
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
}

/** The model the session starts on. */
export const XAI_MODEL = grok("grok-test-1");
/** A second admitted model of the same provider (a different checkpoint scope). */
export const XAI_MODEL_B = grok("grok-test-2");
/** A non-xAI Responses model (another provider, another endpoint). */
export const OTHER_MODEL: Model<"openai-responses"> = {
  ...grok("other-test-1"),
  name: "Synthetic other",
  provider: "other-llm",
  baseUrl: "https://other.example/v1",
};

export const XAI_ITEM = { type: "compaction", encrypted_content: "xai-rig-synthetic-opaque" };

type Frame = JsonObject & { readonly type: string };

/** A streamed Responses answer with one text message. */
export function textResponse(text: string): Response {
  const message = { type: "message", id: "msg_rig", role: "assistant" };
  const frames: Frame[] = [
    { type: "response.created", response: { id: "resp_rig", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_rig",
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...message,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_rig",
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A `POST /v1/responses/compact` success with the rig's opaque item. */
export function compactResponse(item: JsonObject = XAI_ITEM): Response {
  return new Response(
    JSON.stringify({
      object: "response.compaction",
      id: "cmp_rig",
      created_at: 1,
      model: XAI_MODEL.id,
      output: [item],
      usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120, dropped_message_count: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly text: string;
  readonly body: XaiWireBody | undefined;
}

export interface RecordingFetch {
  readonly sent: Sent[];
  readonly fetch: typeof globalThis.fetch;
}

export function recordingFetch(
  respond: (index: number, sent: Sent) => Response | Promise<Response>,
): RecordingFetch {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      const text = String(init?.body ?? "");
      const entry: Sent = {
        url: String(input),
        headers: new Headers(init?.headers),
        text,
        body: parseXaiWireBody(text),
      };
      sent.push(entry);
      return respond(sent.length - 1, entry);
    },
  };
}

/** Foreground: the first answer, then recognizable local summaries. */
export function textForeground(): RecordingFetch {
  return recordingFetch((index) =>
    textResponse(index === 0 ? "XR-ANSWER" : `XR-LOCAL-SUMMARY-${index}`),
  );
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: XAI_MODEL.api,
    provider: XAI_MODEL.provider,
    model: XAI_MODEL.id,
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

/** Resolved request auth as the registry returns it. */
export type RigAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

export interface XaiRig {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  /** The session's cwd and agent dir. */
  readonly dir: string;
  /** Every notice shown through `ctx.ui.notify`, verbatim. */
  readonly notices: string[];
  /** Requests the non-xAI provider sent. */
  readonly other: RecordingFetch;
  readonly ctx: () => ExtensionContext;
  /** Lane journal records on the branch. */
  records(): LaneRecord[];
  /** Dispose the session; captures stay unless `release` (default true). */
  dispose(options?: { readonly release?: boolean; readonly keepDir?: boolean }): Promise<void>;
}

export interface XaiRigOptions {
  readonly foreground: RecordingFetch;
  readonly lane: RecordingFetch;
  readonly mode?: XaiCompactionMode;
  readonly opaqueHistory?: OpaqueHistoryMode;
  readonly after?: readonly ExtensionFactory[];
  /** Reuse a session (a new registration over the same session id); no seeding. */
  readonly manager?: SessionManager;
  readonly dir?: string;
  /** Replace the registry's resolved auth for every model (header-only auth). */
  readonly auth?: () => RigAuth;
  readonly clock?: { now(): number; setTimer(callback: () => void, delayMs: number): () => void };
}

export async function createXaiRig(options: XaiRigOptions): Promise<XaiRig> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "choco-pi-xai-rig-")));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider("xai", {
    api: "openai-responses",
    apiKey: XAI_API_KEY,
    models: [XAI_MODEL, XAI_MODEL_B],
    // Uncaptured path: the installed adapter on the same fake transport.
    streamSimple: (active, context, streamOptions) =>
      installedStreamSimple(active.id === XAI_MODEL_B.id ? XAI_MODEL_B : XAI_MODEL, context, {
        ...streamOptions,
        fetch: options.foreground.fetch,
      }),
  });
  const other = recordingFetch(() => textResponse("XR-OTHER-ANSWER"));
  runtime.registerProvider("other-llm", {
    api: "openai-responses",
    apiKey: "other-non-secret-placeholder",
    models: [OTHER_MODEL],
    streamSimple: (_active, context, streamOptions) =>
      installedStreamSimple(OTHER_MODEL, context, { ...streamOptions, fetch: other.fetch }),
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const notices: string[] = [];
  let captured: ExtensionContext | undefined;
  const auth = options.auth;
  const extension = (pi: ExtensionAPI): void => {
    pi.on("session_start", (_event, ctx) => {
      captured = ctx;
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
      if (auth !== undefined) {
        ctx.modelRegistry.getApiKeyAndHeaders = async () => auth();
      }
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 16_384 }),
      background: {
        settingsPaths: () => BACKGROUND_OFF_SETTINGS_PATHS,
        clock: options.clock,
        readOpaqueHistoryMode: async () => options.opaqueHistory ?? "preserve",
        xai: {
          readMode: async () => options.mode ?? "server-side",
          fetch: options.lane.fetch,
          capture: { fetch: options.foreground.fetch },
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
    extensionFactories: [extension, ...(options.after ?? [])],
  });
  await loader.reload();
  let manager = options.manager;
  if (manager === undefined) {
    manager = SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "XR-PREFIX-A", timestamp: 0 });
    manager.appendMessage(assistantMessage("XR-PREFIX-B"));
    manager.appendMessage({ role: "user", content: "XR-KEPT-C", timestamp: 0 });
    manager.appendMessage(assistantMessage("XR-KEPT-D"));
  }
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: XAI_MODEL,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const sessionId = manager.getSessionId();
  const bound = manager;
  return {
    session,
    manager: bound,
    dir,
    notices,
    other,
    ctx: () => {
      assert.ok(captured, "session_start ran");
      return captured;
    },
    records: () => laneRecordsOf(bound.getEntries()),
    async dispose(disposeOptions = {}) {
      session.dispose();
      if (disposeOptions.release !== false) releaseXaiSessionCaptures(sessionId);
      if (disposeOptions.keepDir !== true) await rm(dir, { recursive: true, force: true });
    },
  };
}

export function compactionsOf(manager: SessionManager): CompactionEntry[] {
  return manager
    .getBranch()
    .filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

/** Whether a sent request carries the rig's opaque item. */
export function carriesItem(sent: Sent | undefined): boolean {
  return sent?.text.includes(XAI_ITEM.encrypted_content) === true;
}
