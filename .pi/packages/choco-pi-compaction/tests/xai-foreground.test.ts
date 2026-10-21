/**
 * Foreground xAI server-side compaction through a real `createAgentSession`
 * (INSTALLED openai-responses adapter, fake transports, no network): the
 * host's compaction is answered with an opaque compaction item, replay sends
 * it first (before the system prompt) with no summary text, failures fall back
 * to the local summarizer with a single notice and a cooldown (or, over a
 * committed checkpoint, the opaque guard cancels), and a replay the transport
 * refuses is refused locally without turning server-side off.
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
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import {
  type AgentSession,
  type CompactionEntry,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { buildBackgroundCompactionPreferencesSections } from "../../../extensions/lib/background-compaction-preferences.ts";
import registerCompaction from "../src/index.ts";
import { laneRecordsOf } from "../src/background/lane-journal.ts";
import {
  refreshSessionNativeState,
  sessionNativeRefreshers,
} from "../src/background-host/native-refresh.ts";
import { publishBackgroundCompactionPreferences } from "../src/preferences-section.ts";
import {
  DEFAULT_XAI_COMPACTION_INSTRUCTIONS,
  xaiCompactionInstructions,
} from "../src/xai/backend.ts";
import { waitForBackgroundCompactionPreferenceChanges } from "../src/preferences-section.ts";
import {
  parseXaiWireBody,
  releaseXaiSessionCaptures,
  xaiTransportRefusals,
  type XaiWireBody,
  XaiWireBodySchema,
} from "../src/xai/capture.ts";
import { isXaiDetails, placeholderSummary } from "../src/xai/details.ts";
import type { XaiCompactionMode } from "../src/xai/mode.ts";
import { BACKGROUND_OFF_SETTINGS_PATHS } from "./host-harness.ts";

const API_KEY = "xai-foreground-non-secret-placeholder";

/** Session IDs the (fake) subagent runner reports as live children. */
const CHILD_IDS = new Set<string>();
Object.defineProperty(globalThis, Symbol.for("pi-subagents:manager"), {
  value: { isChildSessionId: (id: string) => CHILD_IDS.has(id) },
  configurable: true,
});
const MODEL: Model<"openai-responses"> = {
  id: "grok-test-1",
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
const ITEM = { type: "compaction", encrypted_content: "xai-foreground-synthetic-opaque" };
const NOTICE_PREFIX = "xAI server-side compaction";

type Frame = JsonObject & { readonly type: string };

function textResponse(text: string): Response {
  const message = { type: "message", id: "msg_fg", role: "assistant" };
  const frames: Frame[] = [
    { type: "response.created", response: { id: "resp_fg", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_fg",
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
        id: "resp_fg",
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

function compactResponse(): Response {
  return new Response(
    JSON.stringify({
      object: "response.compaction",
      id: "cmp_fg",
      created_at: 1,
      model: MODEL.id,
      output: [ITEM],
      usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120, dropped_message_count: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Tool the auto-compaction rig's model calls; each result is a distinct marker. */
const STEP_TOOL = defineTool({
  name: "step",
  label: "step",
  description: "deterministic step",
  parameters: Type.Object({ label: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `XSTEP-RESULT-${params.label}` }], details: {} };
  },
});

/**
 * A `step` function call reporting `inputTokens` of context (drives the host
 * threshold), optionally preceded by assistant text in the same turn: the
 * adapter then replays that turn as two input items (message + function_call).
 */
function toolCallResponse(label: string, inputTokens: number, text?: string): Response {
  const item = {
    type: "function_call",
    id: `fc_${label}`,
    call_id: `call_${label}`,
    name: "step",
    arguments: JSON.stringify({ label }),
  };
  const callIndex = text === undefined ? 0 : 1;
  const message = { type: "message", id: `msg_${label}`, role: "assistant" };
  const textFrames: Frame[] =
    text === undefined
      ? []
      : [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: message.id,
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
        ];
  const frames: Frame[] = [
    { type: "response.created", response: { id: `resp_${label}`, status: "in_progress" } },
    ...textFrames,
    {
      type: "response.output_item.added",
      output_index: callIndex,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: callIndex,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.output_item.done",
      output_index: callIndex,
      item: { ...item, status: "completed" },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${label}`,
        status: "completed",
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1,
          total_tokens: inputTokens + 1,
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

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly text: string;
  readonly body: XaiWireBody | undefined;
}

interface RecordingFetch {
  readonly sent: Sent[];
  readonly fetch: typeof globalThis.fetch;
}

function recordingFetch(respond: (index: number, sent: Sent) => Response): RecordingFetch {
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

/** Foreground: first answer, later recognizable local summaries. */
function textForeground(): RecordingFetch {
  return recordingFetch((index) =>
    textResponse(index === 0 ? "XG-ANSWER" : `XG-LOCAL-SUMMARY-${index}`),
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
  readonly ctx: () => ExtensionContext;
  dispose(): Promise<void>;
}

interface RigOptions {
  readonly foreground: RecordingFetch;
  readonly lane: RecordingFetch;
  readonly mode?: XaiCompactionMode;
  readonly after?: readonly ExtensionFactory[];
  /** Register the session as a subagent child before its extensions bind. */
  readonly child?: boolean;
  /** Host auto-compaction on (threshold at turn ends) and the `step` tool registered. */
  readonly autoCompaction?: boolean;
}

async function createRig(options: RigOptions): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-xai-foreground-"));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider("xai", {
    api: "openai-responses",
    apiKey: API_KEY,
    models: [MODEL],
    // Uncaptured path (choco-pi mode): the installed adapter on the same fake transport.
    streamSimple: (active, context, streamOptions) => {
      assert.equal(active.id, MODEL.id);
      return installedStreamSimple(MODEL, context, {
        ...streamOptions,
        fetch: options.foreground.fetch,
      });
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: options.autoCompaction === true,
      keepRecentTokens: 1,
      reserveTokens: 16_384,
    },
    retry: { enabled: false },
  });
  const notices: string[] = [];
  let captured: ExtensionContext | undefined;
  const extension = (pi: ExtensionAPI): void => {
    if (options.autoCompaction === true) pi.registerTool(STEP_TOOL);
    pi.on("session_start", (_event, ctx) => {
      captured = ctx;
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 16_384 }),
      background: {
        settingsPaths: () => BACKGROUND_OFF_SETTINGS_PATHS,
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
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: "XG-PREFIX-A", timestamp: 0 });
  manager.appendMessage(assistantMessage("XG-PREFIX-B"));
  manager.appendMessage({ role: "user", content: "XG-KEPT-C", timestamp: 0 });
  manager.appendMessage(assistantMessage("XG-KEPT-D"));
  if (options.child === true) CHILD_IDS.add(manager.getSessionId());
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
    ctx: () => {
      assert.ok(captured, "session_start ran");
      return captured;
    },
    async dispose() {
      session.dispose();
      releaseXaiSessionCaptures(sessionId);
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

function roleOf(item: JsonObject | undefined): string | undefined {
  const role = item?.role;
  return Value.Check(Type.String(), role) ? role : undefined;
}

test(
  "server-side success commits the opaque item; replay sends it first, then the system prompt",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XG-GO");
      assert.equal(foreground.sent.length, 1);
      const captured = foreground.sent[0]?.body;
      assert.ok(captured);
      assert.equal(
        roleOf(captured.input[0]),
        "system",
        "the adapter sends the system prompt first",
      );

      const result = await rig.session.compact("XG focus");
      assert.equal(lane.sent.length, 1, "one compact request");
      const request = lane.sent[0];
      assert.equal(request?.url, "https://api.x.ai/v1/responses/compact");
      assert.equal(request?.headers.get("authorization"), `Bearer ${API_KEY}`);
      assert.ok(request?.body);
      assert.equal(request.body.model, MODEL.id);
      assert.equal(request.body.instructions, xaiCompactionInstructions("XG focus"));
      assert.ok(String(request.body.instructions).startsWith(DEFAULT_XAI_COMPACTION_INSTRUCTIONS));
      assert.ok(String(request.body.instructions).endsWith("XG focus"), "custom focus appended");
      assert.notEqual(roleOf(request.body.input[0]), "system", "system prompt not compacted");
      assert.ok(request.text.includes("XG-PREFIX-A"));
      // The compacted prefix is exactly the captured items it came from.
      const prefix = captured.input.slice(1, request.body.input.length + 1);
      assert.deepEqual(request.body.input, prefix);
      assert.equal(foreground.sent.length, 1, "the local summarizer never ran");

      const [entry, ...extra] = compactions(rig.manager);
      assert.ok(entry);
      assert.equal(extra.length, 0);
      assert.ok(isXaiDetails(entry.details));
      assert.deepEqual(entry.details.item, ITEM);
      assert.equal(entry.details.compactionId, "cmp_fg");
      assert.equal(entry.details.cut.firstKeptEntryId, entry.firstKeptEntryId);
      assert.equal(result.summary, placeholderSummary(entry.details.wire.compactedItems));
      assert.equal(result.summary.includes(ITEM.encrypted_content), false);
      assert.deepEqual(noticesOf(rig), []);

      await rig.session.prompt("XG-NEXT");
      const replay = foreground.sent.at(-1);
      assert.ok(replay?.body);
      assert.deepEqual(replay.body.input[0], ITEM, "the item is the head of the input");
      assert.equal(roleOf(replay.body.input[1]), "system", "the current system prompt follows it");
      assert.equal(replay.text.includes("XG-PREFIX-A"), false, "compacted prefix not resent");
      assert.equal(replay.text.includes("xAI server-side compaction checkpoint"), false);
      assert.ok(replay.text.includes("XG-NEXT"));
      assert.equal(replay.body.store, false);
      assert.deepEqual(xaiTransportRefusals(rig.manager.getSessionId()), []);

      // Re-compaction carries the earlier item forward inside the new prefix.
      await rig.session.compact();
      assert.equal(lane.sent.length, 2);
      assert.deepEqual(lane.sent[1]?.body?.input[0], ITEM);
      assert.equal(
        lane.sent[1]?.body?.instructions,
        DEFAULT_XAI_COMPACTION_INSTRUCTIONS,
        "the default is sent when no custom instructions are given",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "an HTTP 4xx falls back to the local summarizer, then cools down without requests; each manual action is told",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(
      () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    );
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XG-GO");
      const first = await rig.session.compact();
      assert.equal(lane.sent.length, 1);
      assert.match(first.summary, /XG-LOCAL-SUMMARY/u, "the local summarizer answered");
      const [entry] = compactions(rig.manager);
      assert.equal(isXaiDetails(entry?.details), false);
      assert.equal(noticesOf(rig).length, 1, "one fallback notice");
      assert.match(noticesOf(rig)[0] ?? "", /incompatible/u);

      await rig.session.prompt("XG-AGAIN");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "the cooled-down scope sends nothing");
      assert.equal(noticesOf(rig).length, 2, "every manual fallback is told");
      const fallbacks = laneRecordsOf(rig.manager.getEntries()).filter(
        (record) => record.event === "fallback" && record.route === "manual",
      );
      assert.equal(fallbacks.length, 2, "one record per manual action");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "two manual no-capture compactions: one notice and one record each",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane });
    const sessionId = rig.manager.getSessionId();
    try {
      const counts: number[] = [];
      for (const prompt of ["XG-ONE", "XG-TWO"]) {
        await rig.session.prompt(prompt);
        releaseXaiSessionCaptures(sessionId);
        const before = noticesOf(rig).length;
        await rig.session.compact();
        counts.push(noticesOf(rig).length - before);
      }
      assert.deepEqual(counts, [1, 1]);
      assert.equal(lane.sent.length, 0, "no capture, no compact request");
      const fallbacks = laneRecordsOf(rig.manager.getEntries()).filter(
        (record) =>
          record.event === "fallback" &&
          record.route === "manual" &&
          record.reason === "no-capture",
      );
      assert.equal(fallbacks.length, 2);
      assert.ok(fallbacks.every((record) => record.noticeAttempted));
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a successful /compact with a focus journals instructions-forwarded silently",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XG-GO");
      await rig.session.compact("keep decisions");
      assert.ok(isXaiDetails(compactions(rig.manager)[0]?.details), "native success");
      const forwarded = laneRecordsOf(rig.manager.getEntries()).filter(
        (record) => record.detail === "instructions-forwarded",
      );
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0]?.noticeAttempted, false, "silent");
      assert.equal(forwarded[0]?.route, "manual");
      assert.equal(forwarded[0]?.provider, "xai");
      assert.deepEqual(noticesOf(rig), []);

      await rig.session.prompt("XG-NEXT");
      await rig.session.compact();
      assert.equal(
        laneRecordsOf(rig.manager.getEntries()).filter(
          (record) => record.detail === "instructions-forwarded",
        ).length,
        1,
        "no record without a focus",
      );
    } finally {
      await rig.dispose();
    }
  },
);

test("choco-pi mode never calls the compact endpoint", { timeout: 30_000 }, async () => {
  const foreground = textForeground();
  const lane = recordingFetch(() => compactResponse());
  const rig = await createRig({ foreground, lane, mode: "choco-pi" });
  try {
    await rig.session.prompt("XG-GO");
    const result = await rig.session.compact();
    assert.equal(lane.sent.length, 0);
    assert.match(result.summary, /XG-LOCAL-SUMMARY/u);
  } finally {
    await rig.dispose();
  }
});

test(
  "a later handler that drops the item is refused at the transport; a local refusal never turns server-side off",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    let hostile = false;
    const stripper: ExtensionFactory = (pi) => {
      pi.on("before_provider_request", (event) => {
        if (!hostile || !Value.Check(XaiWireBodySchema, event.payload)) return undefined;
        return { ...event.payload, input: event.payload.input.slice(1) };
      });
    };
    const rig = await createRig({ foreground, lane, after: [stripper] });
    try {
      await rig.session.prompt("XG-GO");
      await rig.session.compact();
      assert.ok(isXaiDetails(compactions(rig.manager)[0]?.details));
      hostile = true;
      const before = foreground.sent.length;
      await rig.session.prompt("XG-STRIPPED");
      assert.equal(foreground.sent.length, before, "the stripped request was never transmitted");
      assert.deepEqual(
        xaiTransportRefusals(rig.manager.getSessionId()).map((refusal) => refusal.code),
        ["item-missing"],
      );
      assert.equal(
        rig.notices.filter((notice) => /off for this session/u.test(notice)).length,
        0,
        "no disable notice",
      );
      assert.equal(
        rig.notices.filter((notice) => /replay refused \(item-missing\)/u.test(notice)).length,
        1,
        "one refusal notice",
      );

      hostile = false;
      await rig.session.prompt("XG-AFTER");
      const sent = foreground.sent.at(-1);
      assert.ok(sent?.body);
      assert.ok(sent.text.includes(ITEM.encrypted_content), "replay stays on");
      assert.equal(
        sent.text.includes("xAI server-side compaction checkpoint"),
        false,
        "no placeholder sent",
      );

      await rig.session.compact();
      assert.equal(lane.sent.length, 2, "later compactions stay native");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a provider 400 naming the compaction item turns server-side off; the checkpoint is then refused until loss is authorized",
  { timeout: 30_000 },
  async () => {
    let reject = false;
    const foreground = recordingFetch((index) =>
      reject
        ? new Response(JSON.stringify({ error: { message: "invalid compaction item" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        : textResponse(index === 0 ? "XG-ANSWER" : `XG-LOCAL-SUMMARY-${index}`),
    );
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XG-GO");
      await rig.session.compact();
      reject = true;
      await rig.session.prompt("XG-REJECTED");
      assert.equal(noticesOf(rig).length, 1);
      assert.match(noticesOf(rig)[0] ?? "", /provider-400/u);
      reject = false;
      const before = foreground.sent.length;
      await rig.session.prompt("XG-AFTER");
      assert.equal(foreground.sent.length, before, "refused locally: nothing transmitted");
      assert.deepEqual(
        xaiTransportRefusals(rig.manager.getSessionId()).map((refusal) => refusal.code),
        ["disabled"],
      );
      const refused = laneRecordsOf(rig.manager.getEntries()).filter(
        (record) => record.event === "refuse" && record.reason === "disabled",
      );
      assert.equal(refused.length, 1);

      await rig.session.prompt("/compaction-allow-loss");
      await rig.session.prompt("XG-WITH-CONSENT");
      assert.equal(foreground.sent.length, before + 1, "sent once the loss is authorized");
      const sent = foreground.sent.at(-1);
      assert.equal(sent?.text.includes(ITEM.encrypted_content), false, "no item");
      assert.ok(sent?.text.includes("xAI server-side compaction checkpoint"), "placeholder");
      const losses = laneRecordsOf(rig.manager.getEntries()).filter(
        (record) => record.event === "loss" && record.detail === "disabled",
      );
      assert.equal(losses.length, 1);
    } finally {
      await rig.dispose();
    }
  },
);

test("the xAI Preferences row reaches the profile panel and applies in order", async () => {
  const foreground = textForeground();
  const lane = recordingFetch(() => compactResponse());
  const rig = await createRig({ foreground, lane });
  let mode: XaiCompactionMode = "server-side";
  const applied: XaiCompactionMode[] = [];
  const unpublish = publishBackgroundCompactionPreferences({
    enabled: () => true,
    setEnabled: async () => undefined,
    anthropic: { mode: () => "server-side", set: async () => undefined },
    xai: {
      mode: () => mode,
      set: async (next) => {
        applied.push(next);
        mode = next;
      },
    },
  });
  try {
    const [section] = buildBackgroundCompactionPreferencesSections(rig.ctx());
    assert.ok(section);
    const items = section.buildItems();
    assert.deepEqual(
      items.map((item) => item.id),
      ["backgroundCompaction.enabled", "compactionAnthropic", "compactionXai"],
    );
    const row = items.find((item) => item.id === "compactionXai");
    assert.equal(row?.label, "xAI compaction");
    assert.equal(row?.currentValue, "server-side");
    assert.deepEqual(row?.values, ["server-side", "choco-pi"]);
    assert.deepEqual(section.handleChange("compactionXai", "bogus"), { kind: "rebuild" });
    section.handleChange("compactionXai", "choco-pi");
    await waitForBackgroundCompactionPreferenceChanges();
    assert.deepEqual(applied, ["choco-pi"]);
    assert.equal(
      section.buildItems().find((item) => item.id === "compactionXai")?.currentValue,
      "choco-pi",
    );
  } finally {
    unpublish();
    await rig.dispose();
  }
});

test(
  "a subagent child compacts natively and replays its own item; the main session is untouched",
  { timeout: 60_000 },
  async () => {
    const mainForeground = textForeground();
    const mainLane = recordingFetch(() => compactResponse());
    const childForeground = textForeground();
    const childLane = recordingFetch(() => compactResponse());
    const main = await createRig({ foreground: mainForeground, lane: mainLane });
    const child = await createRig({ foreground: childForeground, lane: childLane, child: true });
    try {
      await main.session.prompt("XG-MAIN-GO");
      await child.session.prompt("XG-CHILD-GO");
      await child.session.compact();
      assert.equal(childLane.sent.length, 1, "the child's own compact request");
      assert.ok(childLane.sent[0]?.text.includes("XG-PREFIX-A"));
      assert.ok(isXaiDetails(compactions(child.manager)[0]?.details));
      await child.session.prompt("XG-CHILD-NEXT");
      assert.deepEqual(childForeground.sent.at(-1)?.body?.input[0], ITEM, "child replay");
      assert.deepEqual(xaiTransportRefusals(child.manager.getSessionId()), []);
      assert.deepEqual(noticesOf(child), []);

      assert.equal(mainLane.sent.length, 0, "the main session made no request for the child");
      assert.equal(compactions(main.manager).length, 0);
      await main.session.compact();
      assert.equal(mainLane.sent.length, 1);
      assert.ok(isXaiDetails(compactions(main.manager)[0]?.details));
      assert.deepEqual(noticesOf(main), []);
    } finally {
      await child.dispose();
      await main.dispose();
    }
  },
);

test(
  "the per-session refresh hook restores a reattached child's replay binding",
  { timeout: 60_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane, child: true });
    const sessionId = rig.manager.getSessionId();
    try {
      assert.ok(sessionNativeRefreshers(sessionId).includes("choco-pi-compaction:replay"));
      // Detached state: the session's projection is gone, so captures cannot be mapped.
      releaseXaiSessionCaptures(sessionId);
      await rig.session.prompt("XG-UNMAPPED");
      await rig.session.compact();
      assert.equal(lane.sent.length, 0, "an unmapped capture cannot be compacted natively");
      assert.equal(isXaiDetails(compactions(rig.manager).at(-1)?.details), false);

      await refreshSessionNativeState(sessionId, rig.ctx());
      await rig.session.prompt("XG-REMAPPED");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1, "the restored binding maps the capture again");
      assert.ok(isXaiDetails(compactions(rig.manager).at(-1)?.details));
      await rig.session.prompt("XG-AFTER");
      assert.deepEqual(foreground.sent.at(-1)?.body?.input[0], ITEM, "replayed after refresh");
    } finally {
      await rig.dispose();
    }
    assert.deepEqual(sessionNativeRefreshers(sessionId), [], "disposal unregisters the hook");
  },
);

test(
  "an auth-failed compact request fails the compaction instead of summarizing locally",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(
      () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const rig = await createRig({ foreground, lane });
    try {
      await rig.session.prompt("XG-GO");
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
  "consecutive xAI compactions in a child tool loop advance the cut and never keep a compaction",
  { timeout: 60_000 },
  async () => {
    const TURNS = 4;
    const foreground = recordingFetch((index) =>
      index < TURNS ? toolCallResponse(`t${index}`, 190_000) : textResponse("XG-DONE"),
    );
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane, child: true, autoCompaction: true });
    try {
      await rig.session.prompt("XG-LOOP");
      const branch = rig.manager.getBranch();
      const position = new Map(branch.map((entry, index) => [entry.id, index]));
      const native = compactions(rig.manager).filter((entry) => isXaiDetails(entry.details));
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
        assert.notEqual(firstKept?.type, "compaction");
      }
      for (let index = 2; index < lane.sent.length; index++) {
        const label = `XSTEP-RESULT-t${index - 2}`;
        assert.equal(lane.sent[index]?.text.includes(label), false, `${label} not resent`);
      }
      assert.deepEqual(noticesOf(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);
/** A response that streams nothing more until the request is aborted (a cancelled turn). */
function stalledResponse(signal: AbortSignal | null | undefined): Response {
  const created = {
    type: "response.created",
    response: { id: "resp_stall", status: "in_progress" },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`event: ${created.type}\ndata: ${JSON.stringify(created)}\n\n`),
      );
      signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
        once: true,
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test(
  "xAI turns with text and a tool call compact natively three times across a cancel and resume",
  { timeout: 60_000 },
  async () => {
    const STALL = 2;
    const turns = new Map<number, number>([
      [0, 0],
      [1, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
    const lane = recordingFetch(() => compactResponse());
    const sent: Sent[] = [];
    const foreground: RecordingFetch = {
      sent,
      fetch: async (input, init) => {
        const text = String(init?.body ?? "");
        sent.push({
          url: String(input),
          headers: new Headers(init?.headers),
          text,
          body: parseXaiWireBody(text),
        });
        const index = sent.length - 1;
        if (index === STALL) return stalledResponse(init?.signal);
        const turn = turns.get(index);
        return turn === undefined
          ? textResponse("XG-DONE")
          : toolCallResponse(`t${turn}`, 190_000, `Reading step ${turn} now.`);
      },
    };
    const rig = await createRig({ foreground, lane, child: true, autoCompaction: true });
    try {
      const first = rig.session.prompt("XG-LOOP");
      while (sent.length <= STALL) await new Promise((resolve) => setTimeout(resolve, 5));
      await rig.session.abort();
      await first;
      await rig.session.prompt("XG-RESUME");
      const branch = rig.manager.getBranch();
      const position = new Map(branch.map((entry, index) => [entry.id, index]));
      const all = compactions(rig.manager);
      const native = all.filter((entry) => isXaiDetails(entry.details));
      assert.ok(
        native.length >= 3,
        `three native compactions (got ${native.length} of ${all.length})`,
      );
      assert.equal(native.length, all.length, "no local fallback");
      const kept = native.map((entry) => position.get(entry.firstKeptEntryId) ?? -1);
      for (let index = 1; index < kept.length; index++) {
        assert.ok(
          (kept[index] ?? -1) > (kept[index - 1] ?? -1),
          `firstKeptEntryId advances: ${kept.join(", ")}`,
        );
      }
      const prefixes = native.map((entry) =>
        isXaiDetails(entry.details) ? entry.details.wire.prefixDigest : "",
      );
      assert.equal(new Set(prefixes).size, prefixes.length, "no compacted prefix is sent twice");
      assert.deepEqual(noticesOf(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);
test(
  "a capture from before the newest compaction is never reused; the opaque guard cancels the local fallback",
  { timeout: 60_000 },
  async () => {
    // Request 0 answers; request 1 (after the first compaction) fails, so its
    // capture is unusable and only the pre-compaction capture remains.
    const foreground = recordingFetch((index) =>
      index === 1
        ? new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 })
        : textResponse(`XG-ANSWER-${index}`),
    );
    const lane = recordingFetch(() => compactResponse());
    const rig = await createRig({ foreground, lane, child: true });
    try {
      await rig.session.prompt("XG-GO");
      await rig.session.compact();
      assert.equal(lane.sent.length, 1);
      const [first] = compactions(rig.manager);
      assert.ok(first && isXaiDetails(first.details));
      await rig.session.prompt("XG-FAILS");
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 1, "the stale capture was not sent to the compact endpoint");
      const latest = compactions(rig.manager).at(-1);
      assert.equal(latest?.id, first.id, "no placeholder was summarized");
      assert.ok(
        rig.notices.some((notice) => /opaque xai server-side record/u.test(notice)),
        "the guard names the exits",
      );
    } finally {
      await rig.dispose();
    }
  },
);
