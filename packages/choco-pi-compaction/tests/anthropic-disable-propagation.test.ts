/**
 * Disable propagation (D7) through a real `createAgentSession` (installed
 * Anthropic adapter behind the captured provider stream, fake transports, no
 * network), background on with the Anthropic and text lanes:
 * - a replay rejection cancels the outstanding `anthropic-native` candidate
 *   (`disabled`), threshold work moves to the text lane, and the journal has
 *   one `disable` and one `yield` record;
 * - a ready native candidate prepared before the rejection is never adopted;
 * - a rejection that resolves after a `model_select` rebind belongs to a
 *   stale binding: it neither disables nor journals (F2);
 * - the background lane uses the registration's one capability gate, so a
 *   foreground failure streak cools it too, and a gate cooldown is journaled.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type Api,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CompactionEntry,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { ANTHROPIC_BACKEND_ID } from "../src/anthropic/backend.ts";
import { AnthropicCapabilityGate } from "../src/anthropic/capability.ts";
import { releaseSessionCaptures } from "../src/anthropic/capture.ts";
import { isAnthropicDetails } from "../src/anthropic/details.ts";
import type { CoordinatorStatus } from "../src/background/contract.ts";
import { type LaneRecord, laneRecordsOf } from "../src/background/lane-journal.ts";
import { getCoordinator } from "../src/background/registry.ts";
import { parseBackgroundSettings } from "../src/background/settings.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import { type BackendOwnerSpec, resolveBackends } from "../src/background-host/backends.ts";
import registerCompaction from "../src/index.ts";
import { mainOwnerKey } from "../src/ownership.ts";

const OAUTH_KEY = "sk-ant-oat01-disable-propagation-non-secret-placeholder";
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
const BLOCK = {
  type: "compaction",
  content: "DISABLE synthetic native summary",
  signature: "disable-synthetic-signature",
};
const PADDING = "detail ".repeat(200);
const REJECTION_CODE = "compaction_signature_invalid";

type Frame = JsonObject & { readonly type: string };

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function reply(content: JsonObject, stopReason: string, inputTokens = 0): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "disable",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 90, output_tokens: 30 }],
      },
    },
    { type: "message_stop" },
  ]);
}

function textReply(text: string, inputTokens = 0): Response {
  return reply({ type: "text", text: `${text} ${PADDING}` }, "end_turn", inputTokens);
}

function blockReply(): Response {
  return reply(BLOCK, "compaction");
}

function rejection(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "synthetic signature rejection",
        details: { error_code: REJECTION_CODE },
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

type Respond = (index: number, signal: AbortSignal | undefined) => Response | Promise<Response>;

interface RecordingFetch {
  count: number;
  readonly fetch: typeof globalThis.fetch;
}

function recordingFetch(respond: Respond): RecordingFetch {
  const recording: RecordingFetch = {
    count: 0,
    fetch: async (_input, init) => {
      const index = recording.count;
      recording.count += 1;
      return respond(index, init?.signal ?? undefined);
    },
  };
  return recording;
}

interface Deferred {
  readonly promise: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  readonly foreground: RecordingFetch;
  readonly lane: RecordingFetch;
  readonly summarized: { count: number };
  dispose(): Promise<void>;
}

interface RigOptions {
  readonly foreground: Respond;
  readonly lane: Respond;
  readonly sidecar?: JsonObject;
}

async function createRig(options: RigOptions): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-disable-propagation-"));
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
      ...options.sidecar,
    }),
  );
  const foreground = recordingFetch(options.foreground);
  const lane = recordingFetch(options.lane);
  const summarized = { count: 0 };
  const summarizer: TextSummarizer = {
    scope: { provider: MODEL.provider, model: MODEL.id, baseUrl: MODEL.baseUrl },
    summarize: async () => {
      summarized.count += 1;
      return { text: "## Goal\nDISABLE-TEXT-SUMMARY", usage, stopReason: "stop", toolCallCount: 0 };
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
    models: [MODEL, OTHER_MODEL],
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
          fetch: lane.fetch,
          capture: { fetch: foreground.fetch },
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
  const sessionId = manager.getSessionId();
  return {
    session,
    manager,
    notices,
    foreground,
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

function compactions(manager: SessionManager): CompactionEntry[] {
  return manager
    .getBranch()
    .filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

function records(rig: Rig): LaneRecord[] {
  return laneRecordsOf(rig.manager.getBranch());
}

async function requestNative(rig: Rig): Promise<void> {
  const request = await coordinatorOf(rig).requestPreparation({
    trigger: "manual",
    backendId: ANTHROPIC_BACKEND_ID,
  });
  assert.ok(request.accepted, JSON.stringify(request));
}

function settled(status: CoordinatorStatus): boolean {
  return status.state !== "queued" && status.state !== "preparing";
}

/** Seed turns, commit one native checkpoint, then answer two replayed turns. */
async function seedCheckpoint(rig: Rig): Promise<void> {
  for (let turn = 0; turn < 3; turn++) await rig.session.prompt(`DISABLE-SEED-${turn} ${PADDING}`);
  await requestNative(rig);
  await waitFor("a ready native candidate", () => coordinatorOf(rig).status().state === "ready");
  await rig.session.compact();
  const [entry, ...extra] = compactions(rig.manager);
  assert.equal(extra.length, 0);
  assert.ok(isAnthropicDetails(entry?.details), "a native checkpoint was adopted");
  await rig.session.prompt(`DISABLE-AFTER-0 ${PADDING}`);
  await rig.session.prompt(`DISABLE-AFTER-1 ${PADDING}`);
}

/** Foreground script: answers text with `tokens` of usage; `reject` answers the next request with a replay rejection. */
function foregroundScript() {
  const state = {
    reject: false,
    tokens: 0,
    beforeReject: async (): Promise<void> => undefined,
  };
  const respond: Respond = async (index) => {
    if (state.reject) {
      state.reject = false;
      await state.beforeReject();
      return rejection();
    }
    return textReply(`DISABLE-ACK-${index}`, state.tokens);
  };
  return { state, respond };
}

test(
  "a replay rejection cancels the outstanding native candidate and moves threshold work to text",
  { timeout: 60_000 },
  async () => {
    const script = foregroundScript();
    let hold = deferred();
    const rig = await createRig({
      foreground: script.respond,
      lane: async (_index, signal) => {
        await heldUntil(hold.promise, signal);
        return blockReply();
      },
      sidecar: { prepareAt: 0.5 },
    });
    try {
      hold.release();
      await seedCheckpoint(rig);
      hold = deferred();
      const laneBefore = rig.lane.count;
      await requestNative(rig);
      await waitFor("the held native request", () => rig.lane.count === laneBefore + 1);
      assert.equal(coordinatorOf(rig).status().state, "preparing");

      script.state.reject = true;
      await rig.session.prompt(`DISABLE-REJECTED ${PADDING}`);
      // (a) The outstanding native candidate was cancelled as `disabled`.
      await waitFor("the cancelled candidate", () => settled(coordinatorOf(rig).status()));
      const cancelled = coordinatorOf(rig).status();
      assert.equal(cancelled.state, "canceled", JSON.stringify(cancelled));
      assert.equal(cancelled.reason, "disabled");
      assert.equal(cancelled.backendId, ANTHROPIC_BACKEND_ID);
      // (e) One disable notice.
      const disableNotices = rig.notices.filter((notice) =>
        /server-side compaction is off/u.test(notice),
      );
      assert.equal(disableNotices.length, 1, JSON.stringify(rig.notices));
      assert.ok(disableNotices[0]?.includes(REJECTION_CODE));

      // (b) The next threshold request selects the text lane; no native request is made.
      const laneAfterDisable = rig.lane.count;
      script.state.tokens = 150_000;
      await rig.session.prompt(`DISABLE-HIGH ${PADDING}`);
      await waitFor("the text lane to prepare", () => rig.summarized.count > 0);
      assert.equal(rig.lane.count, laneAfterDisable, "no native request after the disable");
      const thresholdStatus = coordinatorOf(rig).status();
      assert.equal(thresholdStatus.backendId, "text", JSON.stringify(thresholdStatus));

      // (d) One `disable` and one `yield` record for the disabled lane.
      const all = records(rig);
      const disables = all.filter((record) => record.event === "disable");
      assert.equal(disables.length, 1, JSON.stringify(all));
      assert.equal(disables[0]?.provider, "anthropic");
      assert.equal(disables[0]?.route, "replay");
      const yields = all.filter(
        (record) => record.event === "yield" && record.reason === "disabled",
      );
      assert.equal(yields.length, 1, JSON.stringify(all));
      assert.equal(yields[0]?.route, "threshold");
      assert.equal(yields[0]?.to, "text");
      const cancels = all.filter(
        (record) => record.event === "cancel" && record.reason === "disabled",
      );
      assert.equal(cancels.length, 1, "the cancelled candidate is journaled as a cancel");
    } finally {
      hold.release();
      await rig.dispose();
    }
  },
);

test(
  "a ready native candidate prepared before the rejection is never adopted",
  { timeout: 60_000 },
  async () => {
    const script = foregroundScript();
    let hold = deferred();
    const rig = await createRig({
      foreground: script.respond,
      lane: async (_index, signal) => {
        await heldUntil(hold.promise, signal);
        return blockReply();
      },
    });
    try {
      hold.release();
      await seedCheckpoint(rig);
      hold = deferred();
      const laneBefore = rig.lane.count;
      // Frozen while idle (the last answered request holds the cut), answered later.
      await requestNative(rig);
      await waitFor("the held native request", () => rig.lane.count === laneBefore + 1);
      const inFlight: string[] = [];
      // The candidate becomes ready while the rejected request is in flight.
      script.state.beforeReject = async () => {
        try {
          hold.release();
          await waitFor("a ready candidate", () => coordinatorOf(rig).status().state === "ready");
        } catch (cause) {
          inFlight.push(`${String(cause)} ${JSON.stringify(coordinatorOf(rig).status())}`);
        }
      };
      script.state.reject = true;
      await rig.session.prompt(`DISABLE-REJECTED ${PADDING}`);
      assert.deepEqual(inFlight, []);
      assert.equal(rig.lane.count, laneBefore + 1, "the candidate was prepared");
      // The boundary after the rejected turn did not adopt it.
      const status = coordinatorOf(rig).status();
      assert.equal(status.state, "canceled", JSON.stringify(status));
      assert.equal(status.reason, "disabled");
      assert.equal(compactions(rig.manager).length, 1, "only the first checkpoint exists");
      // A later idle input does not adopt it either.
      await rig.session.prompt(`DISABLE-LATER ${PADDING}`);
      assert.equal(compactions(rig.manager).length, 1);
    } finally {
      hold.release();
      await rig.dispose();
    }
  },
);

test(
  "a rejection resolved after a model_select rebind neither disables nor journals (F2)",
  { timeout: 60_000 },
  async () => {
    const script = foregroundScript();
    const rig = await createRig({ foreground: script.respond, lane: () => blockReply() });
    try {
      await seedCheckpoint(rig);
      const hold = deferred();
      const sent = deferred();
      script.state.beforeReject = async () => {
        sent.release();
        await hold.promise;
      };
      script.state.reject = true;
      const rejected = rig.session.prompt(`DISABLE-STALE ${PADDING}`);
      await sent.promise;
      // Rebind: a new model is a new owner and a new replay binding.
      await rig.session.setModel(OTHER_MODEL);
      hold.release();
      await rejected;
      assert.equal(
        rig.notices.filter((notice) => /server-side compaction is off/u.test(notice)).length,
        0,
        JSON.stringify(rig.notices),
      );
      assert.equal(
        records(rig).filter((record) => record.event === "disable").length,
        0,
        "no disable record for the stale binding",
      );

      // Back on the checkpoint's model: a fresh rejection on the new binding disables once.
      await rig.session.setModel(MODEL);
      script.state.beforeReject = async () => undefined;
      script.state.reject = true;
      await rig.session.prompt(`DISABLE-FRESH ${PADDING}`);
      assert.equal(
        rig.notices.filter((notice) => /server-side compaction is off/u.test(notice)).length,
        1,
        JSON.stringify(rig.notices),
      );
      assert.equal(records(rig).filter((record) => record.event === "disable").length, 1);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a background lane failure that cools the shared gate journals one cooldown record with its end",
  { timeout: 60_000 },
  async () => {
    const script = foregroundScript();
    const rig = await createRig({
      foreground: script.respond,
      // A refusal is not transient: the first failure starts a cooldown.
      lane: () => reply({ type: "text", text: "no" }, "refusal"),
      sidecar: { cooldownMs: 60_000, text: false },
    });
    try {
      for (let turn = 0; turn < 3; turn++)
        await rig.session.prompt(`DISABLE-SEED-${turn} ${PADDING}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        await requestNative(rig);
        await waitFor("the failed attempt", () => settled(coordinatorOf(rig).status()));
        await rig.session.prompt(`DISABLE-NEXT-${attempt} ${PADDING}`);
      }
      assert.equal(rig.lane.count, 1, "the second request is skipped while cooling");
      const failed = coordinatorOf(rig).status().recentFailures?.[0];
      assert.ok(failed, "the failed attempt is on the status");
      const cooldowns = records(rig).filter((record) => record.event === "cooldown");
      assert.equal(cooldowns.length, 1, JSON.stringify(records(rig)));
      assert.equal(cooldowns[0]?.provider, "anthropic");
      assert.equal(cooldowns[0]?.reason, failed.reason);
      assert.ok((cooldowns[0]?.cooldownUntil ?? 0) > Date.now(), "the cooldown end is recorded");
      assert.equal(
        rig.notices.filter((notice) => /cooling down/u.test(notice)).length,
        1,
        JSON.stringify(rig.notices),
      );
    } finally {
      await rig.dispose();
    }
  },
);

test("the background lane uses the shared gate: a foreground 529 streak cools it too", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  const scope = {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: MODEL.id,
    authMode: "oauth",
  };
  const shared = new AnthropicCapabilityGate({ enabled: true, cooldownMs: 60_000 });
  let disabled = false;
  const spec = (anthropicGate: AnthropicCapabilityGate | undefined): BackendOwnerSpec => ({
    ownerKey: "main:shared-gate",
    ownerGeneration: 1,
    sessionId: "shared-gate-session",
    model: MODEL satisfies Model<Api>,
    modelRegistry: new ModelRegistry(runtime),
    thinkingLevel: "off",
    retryPolicy: undefined,
    codexCompaction: undefined,
    settings: parseBackgroundSettings(
      JSON.stringify({ enabled: true, text: false, anthropicNative: true, cooldownMs: 60_000 }),
      "test",
    ).settings,
    scope,
    allowAnthropic: true,
    allowForeign: false,
    xaiServerSide: false,
    report: () => undefined,
    anthropicDisabled: () => disabled,
    anthropicGate,
  });
  const sharedBackends = await resolveBackends(spec(shared), {});
  const native = sharedBackends.get(ANTHROPIC_BACKEND_ID);
  assert.ok(native, "the native backend resolved");
  assert.deepEqual(await native.capability(scope), { supported: true });
  // The foreground handler records its failures on the same gate instance.
  for (let attempt = 0; attempt < 3; attempt++) shared.recordFailure(scope, "529");
  // The gate reports the cooled reason itself.
  assert.deepEqual(await native.capability(scope), { supported: false, reason: "529" });
  // A private gate (partial test runtimes only) would not have seen the streak.
  const privateBackends = await resolveBackends(spec(undefined), {});
  assert.deepEqual(await privateBackends.get(ANTHROPIC_BACKEND_ID)?.capability(scope), {
    supported: true,
  });
  // A replay-disabled session reports the lane unsupported.
  disabled = true;
  assert.deepEqual(await privateBackends.get(ANTHROPIC_BACKEND_ID)?.capability(scope), {
    supported: false,
    reason: "unsupported",
  });
});
