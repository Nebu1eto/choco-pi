/**
 * Foreground Anthropic server-side compaction through a real
 * `createAgentSession` (INSTALLED Anthropic adapter, fake transports, no
 * network): the host's own compaction is answered with a signed block, every
 * failure falls back to the local summarizer with a single notice, replay
 * carries the block first with the beta, and a replay rejection turns
 * server-side off for the rest of the session.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type CompactionEntry,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  mapWireToEntries,
  parseBetaHeader,
  parseWireBody,
  releaseSessionCaptures,
  type WireBody,
} from "../src/anthropic/capture.ts";
import { COMPACT_BETA, isAnthropicDetails } from "../src/anthropic/details.ts";
import type { AnthropicCompactionMode } from "../src/anthropic/mode.ts";
import { getCoordinator } from "../src/background/registry.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import registerCompaction from "../src/index.ts";
import { mainOwnerKey } from "../src/ownership.ts";
import { BACKGROUND_OFF_SETTINGS_PATHS } from "./host-harness.ts";

const OAUTH_KEY = "sk-ant-oat01-foreground-non-secret-placeholder";

/** Session IDs the (fake) subagent runner reports as live children. */
const CHILD_IDS = new Set<string>();
Object.defineProperty(globalThis, Symbol.for("pi-subagents:manager"), {
  value: { isChildSessionId: (id: string) => CHILD_IDS.has(id) },
  configurable: true,
});
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
  content: "FOREGROUND synthetic native summary",
  signature: "foreground-synthetic-signature",
};
const NOTICE_PREFIX = "Anthropic server-side compaction";
const BACKGROUND_SUMMARY = [
  "## Goal",
  "FG-BACKGROUND-SUMMARY",
  "## Constraints & Preferences",
  "- None",
  "## Progress",
  "### Done",
  "- Seeded",
  "### In Progress",
  "- Working",
  "### Blocked",
  "",
  "## Key Decisions",
  "- None",
  "## Next Steps",
  "1. Continue",
  "## Critical Context",
  "- None",
].join("\n");

type Frame = JsonObject & { readonly type: string };

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function messageStart(inputTokens = 0): Frame {
  return {
    type: "message_start",
    message: {
      id: "foreground",
      type: "message",
      role: "assistant",
      model: MODEL.id,
      content: [],
      stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  };
}

function laneFrames(options: {
  readonly block?: boolean;
  readonly stopReason: string;
  readonly text?: string;
  readonly inputTokens?: number;
}): Frame[] {
  const frames: Frame[] = [messageStart(options.inputTokens)];
  if (options.block === true) {
    frames.push({ type: "content_block_start", index: 0, content_block: BLOCK });
    frames.push({ type: "content_block_stop", index: 0 });
  } else if (options.text !== undefined) {
    frames.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: options.text },
    });
    frames.push({ type: "content_block_stop", index: 0 });
  }
  frames.push({
    type: "message_delta",
    delta: { stop_reason: options.stopReason, stop_sequence: null },
    usage: {
      input_tokens: options.inputTokens ?? 0,
      output_tokens: 0,
      iterations: [{ type: "compaction", input_tokens: 90, output_tokens: 30 }],
    },
  });
  frames.push({ type: "message_stop" });
  return frames;
}

function compactionResponse(): Response {
  return sse(laneFrames({ block: true, stopReason: "compaction" }));
}

function textResponse(text: string, inputTokens?: number): Response {
  return sse(laneFrames({ text, stopReason: "end_turn", inputTokens }));
}

function errorResponse(status: number, error: JsonObject): Response {
  return new Response(JSON.stringify({ type: "error", error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Tool the auto-compaction rig's model calls; each result is a distinct marker. */
const STEP_TOOL = defineTool({
  name: "step",
  label: "step",
  description: "deterministic step",
  parameters: Type.Object({ label: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `STEP-RESULT-${params.label}` }], details: {} };
  },
});

/** A `step` tool call reporting `inputTokens` of context (drives the host threshold). */
function toolUseResponse(label: string, inputTokens: number): Response {
  return sse([
    messageStart(inputTokens),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${label}`, name: "step", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ label }) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

interface Sent {
  readonly headers: Headers;
  readonly text: string;
  readonly body: WireBody | undefined;
  readonly signal: AbortSignal | undefined;
}

interface RecordingFetch {
  readonly sent: Sent[];
  readonly fetch: typeof globalThis.fetch;
}

function recordingFetch(respond: (index: number, sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const recording: RecordingFetch = {
    sent,
    fetch: async (_input, init) => {
      const text = String(init?.body ?? "");
      const entry: Sent = {
        headers: new Headers(init?.headers),
        text,
        body: parseWireBody(text),
        signal: init?.signal ?? undefined,
      };
      sent.push(entry);
      return respond(sent.length - 1, entry);
    },
  };
  return recording;
}

const CompactionFieldSchema = Type.Object({
  compaction: Type.Object({
    type: Type.Literal("summarize"),
    instructions: Type.Optional(Type.String()),
  }),
});

function laneCompaction(
  sent: Sent | undefined,
): { type: string; instructions?: string } | undefined {
  const body = sent?.body;
  return Value.Check(CompactionFieldSchema, body) ? body.compaction : undefined;
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage,
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

interface RigOptions {
  readonly foreground: RecordingFetch;
  readonly lane: RecordingFetch;
  readonly mode?: AnthropicCompactionMode;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly keepRecentTokens?: number;
  /** Register the session as a subagent child before its extensions bind. */
  readonly child?: boolean;
  /** Host auto-compaction on (threshold at turn ends) and the `step` tool registered. */
  readonly autoCompaction?: boolean;
  /** Background sidecar file and injected text summarizer. */
  readonly background?: {
    readonly sidecar: (dir: string) => Promise<string>;
    readonly summarizer: TextSummarizer;
  };
}

async function createRig(options: RigOptions): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-anthropic-foreground-"));
  const sidecar = await options.background?.sidecar(dir);
  const summarizer = options.background?.summarizer;
  const model: Model<"anthropic-messages"> = {
    ...MODEL,
    baseUrl: options.baseUrl ?? MODEL.baseUrl,
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
    apiKey: options.apiKey ?? OAUTH_KEY,
    models: [model],
    // Uncaptured path (choco-pi mode): the installed adapter on the same fake transport.
    streamSimple: (active, context, streamOptions) => {
      assert.equal(active.id, model.id);
      return installedStreamSimple(model, context, {
        ...streamOptions,
        fetch: options.foreground.fetch,
      });
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: options.autoCompaction === true,
      keepRecentTokens: options.keepRecentTokens ?? 1,
      reserveTokens: 16_384,
    },
    retry: { enabled: false },
  });
  const notices: string[] = [];
  const extension = (pi: ExtensionAPI): void => {
    if (options.autoCompaction === true) pi.registerTool(STEP_TOOL);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 16_384 }),
      background: {
        settingsPaths: () => (sidecar === undefined ? BACKGROUND_OFF_SETTINGS_PATHS : [sidecar]),
        createTextSummarizer: summarizer === undefined ? undefined : () => summarizer,
        anthropic: {
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
    extensionFactories: [extension],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: "FG-PREFIX-A", timestamp: 0 });
  manager.appendMessage(assistantMessage("FG-PREFIX-B"));
  manager.appendMessage({ role: "user", content: "FG-KEPT-C", timestamp: 0 });
  manager.appendMessage(assistantMessage("FG-KEPT-D"));
  if (options.child === true) CHILD_IDS.add(manager.getSessionId());
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
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
      CHILD_IDS.delete(sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function compactions(manager: SessionManager): CompactionEntry[] {
  return manager
    .getBranch()
    .filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

function noticesOf(rig: Rig): string[] {
  return rig.notices.filter((notice) => notice.startsWith(NOTICE_PREFIX));
}

/** Foreground: every request answers with text; the local summary is recognizable. */
function textForeground(): RecordingFetch {
  return recordingFetch((index) =>
    textResponse(index === 0 ? "FG-ANSWER" : `FG-LOCAL-SUMMARY-${index}`),
  );
}

test(
  "server-side success commits the signed block with details; replay sends it first with the beta",
  {
    timeout: 30_000,
  },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactionResponse());
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("FG-GO");
      assert.equal(foreground.sent.length, 1);
      const result = await rig.session.compact("FG custom focus");
      assert.equal(lane.sent.length, 1, "one lane request");
      assert.deepEqual(laneCompaction(lane.sent[0]), {
        type: "summarize",
        instructions: "FG custom focus",
      });
      assert.ok(
        parseBetaHeader(lane.sent[0]?.headers.get("anthropic-beta") ?? null).includes(COMPACT_BETA),
      );
      assert.equal(foreground.sent.length, 1, "the local summarizer never ran");
      assert.equal(result.summary, BLOCK.content);
      const [entry, ...extra] = compactions(rig.manager);
      assert.ok(entry);
      assert.equal(extra.length, 0, "exactly one compaction");
      assert.ok(isAnthropicDetails(entry.details), "details recognized by replay");
      assert.deepEqual(entry.details.block, BLOCK);
      assert.equal(entry.details.cut.firstKeptEntryId, entry.firstKeptEntryId);
      assert.deepEqual(noticesOf(rig), []);

      await rig.session.prompt("FG-NEXT");
      const replay = foreground.sent.at(-1);
      assert.ok(replay?.body);
      assert.deepEqual(replay.body.messages[0], { role: "assistant", content: [BLOCK] });
      assert.ok(parseBetaHeader(replay.headers.get("anthropic-beta")).includes(COMPACT_BETA));
      assert.equal(replay.text.includes(JSON.stringify(BLOCK.content)), true);
      assert.ok(replay.text.includes("FG-NEXT"));
      assert.equal(
        replay.body.messages.filter((message) => JSON.stringify(message).includes("compaction"))
          .length,
        1,
        "exactly one block",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a host cut inside the captured request maps to the legal wire cut before it",
  {
    timeout: 30_000,
  },
  async () => {
    const foreground = recordingFetch((index) => textResponse(`FG-ANSWER-${index}`));
    const lane = recordingFetch(() => compactionResponse());
    const rig = await createRig({ foreground, lane, keepRecentTokens: 100 });
    try {
      await rig.session.prompt("FG-GO");
      // A long prompt: the host keeps it (and the short answer after it) and cuts before it.
      const next = `FG-NEXT ${"detail ".repeat(800)}`;
      await rig.session.prompt(next);
      await rig.session.compact();
      const [entry] = compactions(rig.manager);
      assert.ok(entry && isAnthropicDetails(entry.details));
      const kept = rig.manager.getEntry(entry.firstKeptEntryId);
      assert.ok(kept?.type === "message" && kept.message.role === "user");
      assert.ok(
        JSON.stringify(kept.message).includes("FG-NEXT"),
        "the host's own first kept entry",
      );
      const laneBody = lane.sent[0]?.body;
      assert.ok(laneBody);
      assert.equal(laneBody.messages.at(-1)?.role, "assistant", "prefix ends before the kept user");
      assert.ok(lane.sent[0]?.text.includes("FG-ANSWER-0"));
      assert.equal(lane.sent[0]?.text.includes("FG-NEXT"), false, "nothing after the cut");

      await rig.session.prompt("FG-THIRD");
      const replay = foreground.sent.at(-1);
      assert.ok(replay?.body);
      assert.deepEqual(replay.body.messages[0], { role: "assistant", content: [BLOCK] });
      assert.equal(replay.body.messages[1]?.role, "user");
      assert.ok(JSON.stringify(replay.body.messages[1]).includes("FG-NEXT"));
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a ready background candidate is adopted instead of the server-side request",
  {
    timeout: 30_000,
  },
  async () => {
    let summarized = 0;
    // Held until the run ends, so no boundary adopts it and the host compaction must.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const summarizer: TextSummarizer = {
      scope: { provider: MODEL.provider, model: MODEL.id, baseUrl: MODEL.baseUrl },
      summarize: async () => {
        summarized += 1;
        await released;
        return {
          text: BACKGROUND_SUMMARY,
          usage,
          stopReason: "stop",
          toolCallCount: 0,
        };
      },
    };
    // Low usage arms the background owner; the next, high usage crosses its threshold.
    const foreground = recordingFetch((index) =>
      textResponse(`FG-ANSWER-${index}`, index === 0 ? 1_000 : 180_000),
    );
    const lane = recordingFetch(() => compactionResponse());
    const rig = await createRig({
      foreground,
      lane,
      background: {
        sidecar: async (dir) => {
          const path = join(dir, "background-compaction.json");
          await writeFile(path, JSON.stringify({ enabled: true, text: true }));
          return path;
        },
        summarizer,
      },
    });
    try {
      await rig.session.prompt("FG-GO");
      await rig.session.prompt("FG-HIGH");
      release();
      const ownerKey = mainOwnerKey(rig.manager.getSessionId());
      const deadline = Date.now() + 5_000;
      while (getCoordinator(ownerKey)?.status().state !== "ready") {
        assert.ok(
          Date.now() < deadline,
          `background candidate not ready: ${JSON.stringify(getCoordinator(ownerKey)?.status())} ${JSON.stringify(rig.notices)} ${JSON.stringify(rig.session.getContextUsage())}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(summarized > 0, true);
      await rig.session.compact();
      assert.equal(lane.sent.length, 0, "no server-side request");
      const [entry, ...extra] = compactions(rig.manager);
      assert.ok(entry);
      assert.equal(extra.length, 0);
      assert.ok(entry.summary.includes("FG-BACKGROUND-SUMMARY"));
      assert.equal(isAnthropicDetails(entry.details), false);
      assert.deepEqual(noticesOf(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);

interface FailureCase {
  readonly name: string;
  readonly lane: (index: number, sent: Sent) => Response | Promise<Response>;
}

const FAILURES: readonly FailureCase[] = [
  {
    name: "end_turn without a block",
    lane: () => sse(laneFrames({ text: "x", stopReason: "end_turn" })),
  },
  { name: "refusal", lane: () => sse(laneFrames({ stopReason: "refusal" })) },
  { name: "max_tokens", lane: () => sse(laneFrames({ stopReason: "max_tokens" })) },
  { name: "tool_use", lane: () => sse(laneFrames({ stopReason: "tool_use" })) },
  {
    name: "compaction stop without a block",
    lane: () => sse(laneFrames({ stopReason: "compaction" })),
  },
  {
    name: "lane HTTP 500",
    lane: () => errorResponse(500, { type: "api_error", message: "synthetic" }),
  },
  {
    name: "lane 400 compaction error",
    lane: () =>
      errorResponse(400, {
        type: "invalid_request_error",
        message: "synthetic",
        details: { error_code: "compaction_unavailable" },
      }),
  },
];

for (const item of FAILURES) {
  test(
    `fallback: ${item.name} -> local summary and a single notice`,
    { timeout: 30_000 },
    async () => {
      const foreground = textForeground();
      const lane = recordingFetch(item.lane);
      const rig = await createRig({ foreground, lane });
      try {
        await rig.session.prompt("FG-GO");
        await rig.session.compact();
        assert.equal(lane.sent.length, 1, "one lane attempt");
        assert.equal(foreground.sent.length, 2, "the local summarizer answered");
        const [entry, ...extra] = compactions(rig.manager);
        assert.ok(entry);
        assert.equal(extra.length, 0, "exactly one compaction");
        assert.equal(isAnthropicDetails(entry.details), false);
        assert.ok(entry.summary.includes("FG-LOCAL-SUMMARY"));
        assert.equal(noticesOf(rig).length, 1);
        // A `/compact` is a user action: its fallback is told every time (D6/U-ANTH 8).
        await rig.session.prompt("FG-AGAIN");
        await rig.session.compact();
        assert.equal(compactions(rig.manager).length, 2);
        assert.equal(noticesOf(rig).length, 2, "one notice per /compact");
      } finally {
        await rig.dispose();
      }
    },
  );
}

test(
  "fallback: gate cooldown skips the lane and still summarizes locally",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => sse(laneFrames({ stopReason: "refusal" })));
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("FG-GO");
      await rig.session.compact();
      await rig.session.prompt("FG-AGAIN");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "cooling down: no second lane request");
      assert.equal(compactions(rig.manager).length, 2);
      assert.equal(noticesOf(rig).length, 2, "each /compact fallback is told");
      // The cooling gate reports the reason that cooled it.
      assert.equal(noticesOf(rig)[1], noticesOf(rig)[0]);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "fallback: cancellation during the lane request commits nothing and notices once",
  {
    timeout: 30_000,
  },
  async () => {
    const foreground = textForeground();
    let rigRef: Rig | undefined;
    const lane = recordingFetch(async (_index, sent) => {
      rigRef?.session.abortCompaction();
      if (sent.signal?.aborted !== true) {
        await new Promise<void>((resolve) =>
          sent.signal?.addEventListener("abort", () => resolve()),
        );
      }
      throw new DOMException("aborted", "AbortError");
    });
    const rig = await createRig({ foreground, lane });
    rigRef = rig;
    try {
      await rig.session.prompt("FG-GO");
      await assert.rejects(rig.session.compact());
      assert.equal(lane.sent.length, 1);
      assert.equal(foreground.sent.length, 1, "no local summary after cancellation");
      assert.equal(compactions(rig.manager).length, 0);
      assert.equal(noticesOf(rig).length, 1);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "not admitted: API key, foreign endpoint and choco-pi mode stay local without a notice",
  {
    timeout: 60_000,
  },
  async () => {
    const cases: readonly { readonly name: string; readonly options: Partial<RigOptions> }[] = [
      { name: "api key", options: { apiKey: "sk-ant-api03-foreground-placeholder" } },
      { name: "foreign base URL", options: { baseUrl: "https://proxy.invalid" } },
      { name: "choco-pi mode", options: { mode: "choco-pi" } },
    ];
    for (const item of cases) {
      const foreground = textForeground();
      const lane = recordingFetch(() => compactionResponse());
      const rig = await createRig({ foreground, lane, ...item.options });
      try {
        await rig.session.prompt("FG-GO");
        await rig.session.compact();
        assert.equal(lane.sent.length, 0, `${item.name}: no lane request`);
        assert.equal(foreground.sent.length, 2, `${item.name}: local summary`);
        assert.equal(compactions(rig.manager).length, 1, item.name);
        assert.deepEqual(noticesOf(rig), [], `${item.name}: silent`);
      } finally {
        await rig.dispose();
      }
    }
  },
);

test(
  "a replay 400 with a compaction_ error code disables server-side for the session",
  {
    timeout: 30_000,
  },
  async () => {
    let reject = false;
    const foreground = recordingFetch((index) => {
      if (reject) {
        reject = false;
        return errorResponse(400, {
          type: "invalid_request_error",
          message: "synthetic signature rejection",
          details: { error_code: "compaction_signature_invalid" },
        });
      }
      return textResponse(index === 0 ? "FG-ANSWER" : `FG-LOCAL-SUMMARY-${index}`);
    });
    const lane = recordingFetch(() => compactionResponse());
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("FG-GO");
      await rig.session.compact();
      assert.ok(isAnthropicDetails(compactions(rig.manager)[0]?.details));
      reject = true;
      await rig.session.prompt("FG-REJECTED");
      const rejected = foreground.sent.at(-1);
      assert.deepEqual(rejected?.body?.messages[0], { role: "assistant", content: [BLOCK] });
      const disabled = noticesOf(rig);
      assert.equal(disabled.length, 1);
      assert.ok(disabled[0]?.includes("compaction_signature_invalid"));

      // Later requests carry the summary text, not the block or the beta.
      await rig.session.prompt("FG-AFTER");
      const after = foreground.sent.at(-1);
      assert.ok(after?.body);
      assert.equal(after.text.includes(BLOCK.signature), false);
      assert.equal(
        parseBetaHeader(after.headers.get("anthropic-beta")).includes(COMPACT_BETA),
        false,
      );
      assert.ok(after.text.includes(BLOCK.content), "summary text sent instead");

      // Later compactions are local, with no lane request and no new notice.
      const laneBefore = lane.sent.length;
      await rig.session.compact();
      assert.equal(lane.sent.length, laneBefore);
      const latest = compactions(rig.manager).at(-1);
      assert.equal(isAnthropicDetails(latest?.details), false);
      assert.equal(noticesOf(rig).length, 1);
    } finally {
      await rig.dispose();
    }
  },
);
test(
  "a subagent child compacts natively with its own session state; the main session is untouched",
  { timeout: 60_000 },
  async () => {
    let rejectChild = false;
    const childForeground = recordingFetch((index) => {
      if (rejectChild) {
        rejectChild = false;
        return errorResponse(400, {
          type: "invalid_request_error",
          message: "synthetic signature rejection",
          details: { error_code: "compaction_signature_invalid" },
        });
      }
      return textResponse(index === 0 ? "FG-ANSWER" : `FG-LOCAL-SUMMARY-${index}`);
    });
    const childLane = recordingFetch(() => compactionResponse());
    const mainForeground = textForeground();
    const mainLane = recordingFetch(() => compactionResponse());
    const main = await createRig({ foreground: mainForeground, lane: mainLane });
    const child = await createRig({ foreground: childForeground, lane: childLane, child: true });
    try {
      await child.session.prompt("FG-CHILD-GO");
      const result = await child.session.compact();
      assert.equal(childLane.sent.length, 1, "the child's own lane request");
      assert.equal(result.summary, BLOCK.content);
      assert.ok(isAnthropicDetails(compactions(child.manager)[0]?.details));
      // The child's replay binding sends its own checkpoint first.
      await child.session.prompt("FG-CHILD-NEXT");
      assert.deepEqual(childForeground.sent.at(-1)?.body?.messages[0], {
        role: "assistant",
        content: [BLOCK],
      });
      // A rejection turns server-side off for the child only.
      rejectChild = true;
      await child.session.prompt("FG-CHILD-REJECTED");
      assert.equal(noticesOf(child).length, 1);
      await child.session.compact();
      assert.equal(childLane.sent.length, 1, "the disabled child summarizes locally");

      assert.equal(mainLane.sent.length, 0, "the child never used the main session's lane");
      await main.session.prompt("FG-MAIN-GO");
      await main.session.compact();
      assert.equal(mainLane.sent.length, 1, "the main session still compacts natively");
      assert.ok(isAnthropicDetails(compactions(main.manager)[0]?.details));
      assert.deepEqual(noticesOf(main), []);
    } finally {
      await child.dispose();
      await main.dispose();
    }
  },
);

test(
  "an auth-failed lane request fails the compaction instead of summarizing locally",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() =>
      errorResponse(401, { type: "authentication_error", message: "synthetic" }),
    );
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("FG-GO");
      await assert.rejects(rig.session.compact(), /cancelled/u);
      assert.equal(lane.sent.length, 1);
      assert.equal(foreground.sent.length, 1, "no local summary after an auth failure");
      assert.equal(compactions(rig.manager).length, 0);
      const notices = noticesOf(rig);
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /auth/u);
    } finally {
      await rig.dispose();
    }
  },
);
test(
  "consecutive native compactions in a child tool loop advance the cut and shrink the window",
  { timeout: 60_000 },
  async () => {
    const TURNS = 4;
    // Each tool turn reports a context over the host threshold, so the host
    // compacts at every turn end, between a tool result and the next request.
    const foreground = recordingFetch((index) =>
      index < TURNS ? toolUseResponse(`t${index}`, 190_000) : textResponse("FG-DONE", 10),
    );
    const lane = recordingFetch(() => compactionResponse());
    const rig = await createRig({ foreground, lane, child: true, autoCompaction: true });
    try {
      await rig.session.prompt("FG-LOOP");
      const branch = rig.manager.getBranch();
      const position = new Map(branch.map((entry, index) => [entry.id, index]));
      const native = compactions(rig.manager).filter((entry) => isAnthropicDetails(entry.details));
      assert.ok(native.length >= 3, `three native compactions in a row (got ${native.length})`);
      const kept = native.map((entry) => position.get(entry.firstKeptEntryId) ?? -1);
      for (let index = 1; index < kept.length; index++) {
        assert.ok(
          (kept[index] ?? -1) > (kept[index - 1] ?? -1),
          `firstKeptEntryId advances: ${kept.join(", ")}`,
        );
      }
      for (const entry of native) {
        const firstKept = branch.find((candidate) => candidate.id === entry.firstKeptEntryId);
        assert.notEqual(
          firstKept?.type,
          "compaction",
          "a compaction never keeps a compaction entry",
        );
      }
      // Each lane request summarizes the newest window: an earlier tool result
      // already summarized is not sent again, and no two requests repeat a cut.
      const cuts = native.map((entry) =>
        isAnthropicDetails(entry.details) ? entry.details.cut.cutEntryId : "",
      );
      assert.equal(new Set(cuts).size, cuts.length, `distinct cuts: ${cuts.join(", ")}`);
      for (let index = 2; index < lane.sent.length; index++) {
        const label = `STEP-RESULT-t${index - 2}`;
        assert.equal(lane.sent[index]?.text.includes(label), false, `${label} not resent`);
      }
      assert.equal(foreground.sent.at(-1)?.text.includes("STEP-RESULT-t0"), false);
      assert.deepEqual(noticesOf(rig), []);

      // A session that already retains an older compaction entry (written
      // before this fix) still maps: the invisible entry carries no wire key.
      const [older, newer] = native.slice(-2);
      assert.ok(older && newer);
      const mapping = mapWireToEntries(
        [],
        [
          {
            sourceEntry: newer,
            messages: rig.manager.buildSessionProjection().entries[0]?.messages ?? [],
          },
          { sourceEntry: older, messages: [] },
        ],
      );
      assert.equal(mapping.projection[0]?.keyed, true, "the newest block is keyed");
      assert.equal(mapping.projection[1]?.keyed, false, "an invisible older block is not");
    } finally {
      await rig.dispose();
    }
  },
);
test(
  "a capture from before the newest compaction is never reused to compact again",
  { timeout: 60_000 },
  async () => {
    const foreground = recordingFetch((index) =>
      index === 1
        ? errorResponse(500, { type: "api_error", message: "synthetic outage" })
        : textResponse(`FG-ANSWER-${index}`),
    );
    const lane = recordingFetch(() => compactionResponse());
    const rig = await createRig({ foreground, lane, child: true });
    try {
      await rig.session.prompt("FG-GO");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1);
      const [first] = compactions(rig.manager);
      assert.ok(first && isAnthropicDetails(first.details));
      await rig.session.prompt("FG-FAILS");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "the stale capture was not sent to the lane");
      const latest = compactions(rig.manager).at(-1);
      assert.notEqual(latest?.id, first.id);
      assert.equal(isAnthropicDetails(latest?.details), false, "the local summarizer answered");
    } finally {
      await rig.dispose();
    }
  },
);
