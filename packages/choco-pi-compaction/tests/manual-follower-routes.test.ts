/**
 * Manual follower routes (D6) through a real `createAgentSession` (captured
 * Anthropic provider stream, fake transports, no network), background on with
 * the Anthropic and text lanes; `/compact` starts a native candidate:
 * - a candidate cancelled by a branch switch stops silently: no text candidate
 *   and no warning;
 * - `auth` stops with one warning and no text retry;
 * - a classified lane failure retries once on the text lane and tells the
 *   user once, naming both lanes; the journal records the failed candidate.
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

import { ANTHROPIC_BACKEND_ID } from "../src/anthropic/backend.ts";
import { releaseSessionCaptures } from "../src/anthropic/capture.ts";
import { laneRecordsOf } from "../src/background/lane-journal.ts";
import { getCoordinator } from "../src/background/registry.ts";
import { TEXT_BACKEND_ID, type TextSummarizer } from "../src/background/text-backend.ts";
import registerCompaction from "../src/index.ts";
import { mainOwnerKey } from "../src/ownership.ts";

const OAUTH_KEY = "sk-ant-oat01-manual-follower-non-secret-placeholder";
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
const PADDING = "detail ".repeat(200);
const NOTICE_PREFIX = "Background compaction: ";
const TEXT_SUMMARY = [
  "## Goal",
  "FOLLOWER-TEXT-SUMMARY",
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

function textReply(text: string): Response {
  const frames: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "follower",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(status: number, error: JsonObject): Response {
  return new Response(JSON.stringify({ type: "error", error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Resolve on `gate`, or reject like fetch when `signal` aborts first. */
function heldUntil(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    void gate.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
  });
}

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
  readonly lane: { count: number };
  readonly summarized: { count: number };
  dispose(): Promise<void>;
}

async function createRig(
  laneRespond: (signal: AbortSignal | undefined) => Response | Promise<Response>,
): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-manual-follower-"));
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
  const lane = { count: 0 };
  const laneFetch: typeof globalThis.fetch = async (_input, init) => {
    lane.count += 1;
    return laneRespond(init?.signal ?? undefined);
  };
  let index = 0;
  const foregroundFetch: typeof globalThis.fetch = async () =>
    textReply(`FOLLOWER-ACK-${index++} ${PADDING}`);
  const summarized = { count: 0 };
  const summarizer: TextSummarizer = {
    scope: { provider: MODEL.provider, model: MODEL.id, baseUrl: MODEL.baseUrl },
    summarize: async () => {
      summarized.count += 1;
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
  for (let turn = 0; turn < 3; turn++) await session.prompt(`FOLLOWER-SEED-${turn} ${PADDING}`);
  const sessionId = manager.getSessionId();
  return {
    session,
    manager,
    notices,
    lane,
    summarized,
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

/** Let pending follower work run to completion. */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The request's start notice ("continuing in the background") is shown once by `/compact`. */
const START_NOTICE = /continuing in the background/u;

/** Outcome notices of the manual request (its start notice excluded, and asserted once). */
function compactionNotices(rig: Rig): string[] {
  const notices = rig.notices.filter((notice) => notice.startsWith(NOTICE_PREFIX));
  assert.equal(notices.filter((notice) => START_NOTICE.test(notice)).length, 1, "one start notice");
  return notices.filter((notice) => !START_NOTICE.test(notice));
}

test(
  "a manual candidate cancelled by a branch switch stops silently without a text retry",
  { timeout: 30_000 },
  async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = await createRig(async (signal) => {
      await heldUntil(held, signal);
      return textReply("unused");
    });
    try {
      assert.equal(await rig.session.compact(), undefined);
      await waitFor("the native request", () => rig.lane.count === 1);
      const status = coordinatorOf(rig).status();
      assert.equal(status.backendId, ANTHROPIC_BACKEND_ID);
      const leaf = rig.manager.getLeafId();
      await rig.session.extensionRunner.emit({
        type: "session_tree",
        newLeafId: leaf,
        oldLeafId: leaf,
      });
      release();
      await waitFor(
        "the cancelled candidate",
        () => coordinatorOf(rig).status().state === "canceled",
      );
      await drain();
      assert.equal(coordinatorOf(rig).status().candidateId, status.candidateId, "no new candidate");
      assert.equal(rig.summarized.count, 0, "no text candidate was requested");
      assert.deepEqual(compactionNotices(rig), [], "no warning for a cancellation");
      const cancels = laneRecordsOf(rig.manager.getBranch()).filter(
        (record) => record.event === "cancel" && record.candidateId === status.candidateId,
      );
      assert.equal(cancels.length, 1, "the cancellation is journaled");
    } finally {
      release();
      await rig.dispose();
    }
  },
);

test("an auth failure stops with one warning and no text retry", { timeout: 30_000 }, async () => {
  const rig = await createRig(() =>
    errorResponse(401, { type: "authentication_error", message: "synthetic" }),
  );
  try {
    assert.equal(await rig.session.compact(), undefined);
    await waitFor("the failed candidate", () => coordinatorOf(rig).status().state === "failed");
    await drain();
    assert.equal(rig.lane.count, 1);
    assert.equal(rig.summarized.count, 0, "the text lane uses the same login: no retry");
    const notices = compactionNotices(rig);
    assert.equal(notices.length, 1, JSON.stringify(rig.notices));
    assert.match(notices[0] ?? "", /auth/u);
  } finally {
    await rig.dispose();
  }
});

test(
  "a classified lane failure retries once on text with one notice naming both lanes",
  { timeout: 30_000 },
  async () => {
    const rig = await createRig(() =>
      errorResponse(400, { type: "invalid_request_error", message: "synthetic incompatible" }),
    );
    try {
      assert.equal(await rig.session.compact(), undefined);
      await waitFor(
        "the text checkpoint",
        () =>
          coordinatorOf(rig).status().state === "installed" &&
          coordinatorOf(rig).status().backendId === TEXT_BACKEND_ID,
      );
      await drain();
      assert.equal(rig.lane.count, 1, "one native attempt");
      assert.equal(rig.summarized.count, 1, "one text retry");
      const failures = coordinatorOf(rig).status().recentFailures ?? [];
      const failed = failures.find((failure) => failure.backendId === ANTHROPIC_BACKEND_ID);
      assert.ok(failed, JSON.stringify(failures));
      const notices = compactionNotices(rig);
      assert.deepEqual(notices, [
        `${NOTICE_PREFIX}checkpoint made by the text lane after the Anthropic lane failed (${failed.reason}${failed.detail ? `: ${failed.detail}` : ""})`,
      ]);
      const fallbacks = laneRecordsOf(rig.manager.getBranch()).filter(
        (record) => record.event === "fallback" && record.candidateId === failed.candidateId,
      );
      assert.equal(fallbacks.length, 1, "the failed native candidate is journaled");
      assert.equal(fallbacks[0]?.route, "manual");
    } finally {
      await rig.dispose();
    }
  },
);
