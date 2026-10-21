/**
 * `/compact <focus>` on the Anthropic lane (D9) through a real
 * `createAgentSession` (captured Anthropic provider stream, fake transports,
 * no network), background on with the Anthropic and text lanes:
 * - the native lane is selected first and sends the focus as
 *   `compaction.instructions`;
 * - instructions over the lane's cap fail `oversized` before any request, the
 *   text lane answers, the user gets one folded notice, and the failed
 *   candidate's record carries `instructions-forwarded`.
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
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { ANTHROPIC_BACKEND_ID } from "../src/anthropic/backend.ts";
import { releaseSessionCaptures } from "../src/anthropic/capture.ts";
import { isAnthropicDetails } from "../src/anthropic/details.ts";
import { MAX_COMPACTION_INSTRUCTIONS } from "../src/anthropic/lane-client.ts";
import { laneRecordsOf } from "../src/background/lane-journal.ts";
import { getCoordinator } from "../src/background/registry.ts";
import { TEXT_BACKEND_ID, type TextSummarizer } from "../src/background/text-backend.ts";
import registerCompaction from "../src/index.ts";
import { mainOwnerKey } from "../src/ownership.ts";

const OAUTH_KEY = "sk-ant-oat01-instructions-lane-non-secret-placeholder";
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
  content: "INSTRUCTIONS synthetic native summary",
  signature: "instructions-synthetic-signature",
};
const PADDING = "detail ".repeat(200);
const NOTICE_PREFIX = "Background compaction: ";
const START_NOTICE = /continuing in the background/u;
const TEXT_SUMMARY = [
  "## Goal",
  "INSTRUCTIONS-TEXT-SUMMARY",
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

function reply(content: JsonObject, stopReason: string): Response {
  const frames: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "instructions",
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

const CompactionFieldSchema = Type.Object({
  compaction: Type.Object({
    type: Type.Literal("summarize"),
    instructions: Type.Optional(Type.String()),
  }),
});

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Rig {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly notices: string[];
  readonly laneBodies: unknown[];
  /** Prompt texts of the text lane's summary requests. */
  readonly summarizedPrompts: string[];
  dispose(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-instructions-lane-"));
  const sidecar = join(dir, "background-compaction.json");
  await writeFile(
    sidecar,
    JSON.stringify({
      enabled: true,
      text: true,
      anthropicNative: true,
      prepareAt: 0.99,
      hysteresis: 0,
      reserveTokens: 0,
      retryBaseMs: 0,
      cooldownMs: 0,
      timeoutMs: 20_000,
      maxOutputTokens: 1_000,
    }),
  );
  const laneBodies: unknown[] = [];
  const laneFetch: typeof globalThis.fetch = async (_input, init) => {
    laneBodies.push(JSON.parse(String(init?.body ?? "null")));
    return reply(BLOCK, "compaction");
  };
  let index = 0;
  const foregroundFetch: typeof globalThis.fetch = async () =>
    reply({ type: "text", text: `INSTRUCTIONS-ACK-${index++} ${PADDING}` }, "end_turn");
  const summarizedPrompts: string[] = [];
  const summarizer: TextSummarizer = {
    scope: { provider: MODEL.provider, model: MODEL.id, baseUrl: MODEL.baseUrl },
    summarize: async (request) => {
      summarizedPrompts.push(request.promptText);
      return { text: TEXT_SUMMARY, usage, stopReason: "stop", toolCallCount: 0 };
    },
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
    models: [MODEL],
    streamSimple: () => {
      throw new Error("unwrapped provider stream used");
    },
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
        settingsPaths: () => [sidecar],
        createTextSummarizer: () => summarizer,
        anthropic: {
          readMode: async () => "server-side",
          fetch: laneFetch,
          capture: { fetch: foregroundFetch },
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
  for (let turn = 0; turn < 3; turn++) await session.prompt(`INSTRUCTIONS-SEED-${turn} ${PADDING}`);
  const sessionId = manager.getSessionId();
  return {
    session,
    manager,
    notices,
    laneBodies,
    summarizedPrompts,
    async dispose() {
      session.dispose();
      releaseSessionCaptures(sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function coordinatorOf(rig: Rig): NonNullable<ReturnType<typeof getCoordinator>> {
  const coordinator = getCoordinator(mainOwnerKey(rig.manager.getSessionId()));
  assert.ok(coordinator, "the main owner has a coordinator");
  return coordinator;
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Outcome notices of the manual request (its start notice excluded). */
function outcomeNotices(rig: Rig): string[] {
  return rig.notices.filter(
    (notice) => notice.startsWith(NOTICE_PREFIX) && !START_NOTICE.test(notice),
  );
}

test(
  "/compact focus selects the Anthropic lane and sends the focus as compaction.instructions",
  { timeout: 30_000 },
  async () => {
    const rig = await createRig();
    try {
      assert.equal(await rig.session.compact("focus"), undefined);
      await waitFor(
        "the native checkpoint",
        () => coordinatorOf(rig).status().state === "installed",
      );
      const status = coordinatorOf(rig).status();
      assert.equal(status.backendId, ANTHROPIC_BACKEND_ID);
      assert.equal(rig.laneBodies.length, 1);
      const body = rig.laneBodies[0];
      assert.ok(Value.Check(CompactionFieldSchema, body), JSON.stringify(body));
      assert.equal(body.compaction.instructions, "focus");
      assert.deepEqual(rig.summarizedPrompts, [], "the text lane was not used");
      const latest = rig.manager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(latest?.type === "compaction" && isAnthropicDetails(latest.details));
      await drain();
      assert.deepEqual(outcomeNotices(rig), []);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "oversize instructions fail oversized; the text lane answers with one folded notice",
  { timeout: 30_000 },
  async () => {
    const rig = await createRig();
    try {
      const focus = "f".repeat(MAX_COMPACTION_INSTRUCTIONS + 1);
      assert.equal(await rig.session.compact(focus), undefined);
      await waitFor(
        "the text checkpoint",
        () =>
          coordinatorOf(rig).status().state === "installed" &&
          coordinatorOf(rig).status().backendId === TEXT_BACKEND_ID,
      );
      await drain();
      assert.equal(rig.laneBodies.length, 0, "refused before any lane request");
      assert.equal(rig.summarizedPrompts.length, 1, "one text summary");
      assert.ok(rig.summarizedPrompts[0]?.includes(focus), "the text lane applied the focus");
      assert.deepEqual(outcomeNotices(rig), [
        `${NOTICE_PREFIX}checkpoint made by the text lane after the Anthropic lane failed (oversized)`,
      ]);
      const failed = (coordinatorOf(rig).status().recentFailures ?? []).find(
        (failure) => failure.backendId === ANTHROPIC_BACKEND_ID,
      );
      assert.equal(failed?.reason, "oversized");
      const records = laneRecordsOf(rig.manager.getBranch()).filter(
        (record) => record.candidateId === failed?.candidateId,
      );
      assert.equal(records.length, 1);
      assert.equal(records[0]?.event, "fallback");
      assert.equal(records[0]?.reason, "oversized");
      assert.equal(records[0]?.detail, "instructions-forwarded");
    } finally {
      await rig.dispose();
    }
  },
);
