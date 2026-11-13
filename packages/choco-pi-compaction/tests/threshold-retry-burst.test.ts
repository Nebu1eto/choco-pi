/**
 * The threshold route asks a lane at most once per context position: the
 * host observes usage at several boundary hooks of one run (turn_end,
 * agent_before_settle, agent_settled), and a failed candidate must not be
 * replaced at each of them. An `unsupported` lane gets no further candidate
 * until the owner is replaced (model or Codex eligibility change), unless the
 * backend reported a retry delay with it (a capture-specific condition such as
 * a Daybreak request): that lane retries at a later position once the delay
 * passed. Offline.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import type { ChildCoordinatorContext } from "../../choco-pi-subagents/src/child-compaction-bridge.ts";
import {
  type Backend,
  type CapabilityVerdict,
  type LegalityVerdict,
  type PrepareFailure,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
} from "../src/background/contract.ts";
import type { LaneRecordInput } from "../src/background/lane-journal.ts";
import { getRegistry, registerBackendFactory } from "../src/background/registry.ts";
import type { SchedulerClock } from "../src/background/scheduler.ts";
import { CODEX_BACKEND_SETTING_ID } from "../src/background/settings.ts";
import { childOwnerSpec, type ChildSpecRuntime } from "../src/background-host/child-provider.ts";
import { createOwnerCore, type OwnerCore } from "../src/background-host/owner-core.ts";
import type { CompactionSessionState } from "../src/session-state.ts";
import { createXaiCapabilityGate } from "../src/xai/capability.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("NETWORK FORBIDDEN");
};
afterEach(() => {
  getRegistry().backendFactories.delete(CODEX_BACKEND_SETTING_ID);
});
test.after(() => {
  globalThis.fetch = originalFetch;
});

const CODEX: Model<Api> = {
  id: "gpt-6-sol",
  name: "gpt-6-sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};

const STATE: CompactionSessionState = {
  generation: 1,
  retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
  codexCompaction: { responsesCompaction: true, additionalProviders: [] },
  compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
};

const USAGE = { tokens: 190_000, contextWindow: 200_000, percent: 95 };

/** A Codex lane whose verdicts the test sets; counts every call that could reach a provider. */
class ScriptedCodexLane implements Backend {
  readonly id = CODEX_BACKEND_SETTING_ID;
  capabilityCalls = 0;
  prepareCalls = 0;
  private readonly verdict: CapabilityVerdict;
  private readonly legality: LegalityVerdict;
  private readonly failure: PrepareFailure;
  constructor(
    verdict: CapabilityVerdict,
    legality: LegalityVerdict,
    failure: PrepareFailure = { ok: false, reason: "unsupported", retryable: false },
  ) {
    this.verdict = verdict;
    this.legality = legality;
    this.failure = failure;
  }
  async capability(): Promise<CapabilityVerdict> {
    this.capabilityCalls += 1;
    return this.verdict;
  }
  isLegalCut(): LegalityVerdict {
    return this.legality;
  }
  async prepare(): ReturnType<Backend["prepare"]> {
    this.prepareCalls += 1;
    return this.failure;
  }
}

/** A clock the test moves by hand; its timers never fire (no failure here is retryable). */
function manualClock(): SchedulerClock & { advance(ms: number): void } {
  let at = 1_000_000;
  return {
    now: () => at,
    setTimer: () => () => {},
    advance: (ms) => {
      at += ms;
    },
  };
}

interface Rig {
  readonly core: OwnerCore;
  readonly session: SessionManager;
  readonly records: LaneRecordInput[];
}

async function rig(options: {
  readonly lane: ScriptedCodexLane;
  readonly cooldownMs: number;
  readonly clock?: SchedulerClock;
  readonly ownerGeneration?: number;
  readonly session?: SessionManager;
  readonly records?: LaneRecordInput[];
}): Promise<Rig> {
  registerBackendFactory(CODEX_BACKEND_SETTING_ID, () => options.lane);
  const session = options.session ?? SessionManager.inMemory();
  if (options.session === undefined) {
    session.appendMessage({ role: "user", content: "BURST-A", timestamp: 1 });
    appendAssistant(session, "BURST-B", 2);
    session.appendMessage({ role: "user", content: "BURST-C", timestamp: 3 });
  }
  const records = options.records ?? [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  const rt: ChildSpecRuntime = {
    loaded: {
      settings: {
        ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
        enabled: true,
        text: true,
        codexNative: true,
        cooldownMs: options.cooldownMs,
      },
      source: undefined,
      diagnostic: undefined,
    },
    xaiMode: "server-side",
    xaiGate: createXaiCapabilityGate({ cooldownMs: 0 }),
    journal: (record) => {
      records.push(record);
    },
  };
  const sessionId = session.getSessionId();
  const child: ChildCoordinatorContext = {
    ownerKey: `subagent-child:${sessionId}`,
    ownerGeneration: options.ownerGeneration ?? 1,
    childSessionId: sessionId,
    parentSessionId: "parent-session",
    mainSessionFork: false,
    readOnly: false,
    isolated: false,
    sessionManager: session,
    model: CODEX,
    appendRecord: () => {},
    appendAnchor: () => "",
    signal: new AbortController().signal,
  };
  const scope = { provider: CODEX.provider, model: CODEX.id, baseUrl: CODEX.baseUrl };
  const core = await createOwnerCore(
    childOwnerSpec(rt, {
      host: { modelRegistry: new ModelRegistry(modelRuntime), state: STATE },
      child,
      model: CODEX,
      scope,
      report: (message) => assert.fail(message),
    }),
    {
      clock: options.clock,
      createTextSummarizer: () => ({
        scope,
        summarize: async () => assert.fail("a Codex-owned model never prepares on the text lane"),
      }),
    },
  );
  assert.ok(core);
  assert.equal(core.backendId, CODEX_BACKEND_SETTING_ID);
  return { core, session, records };
}

function appendAssistant(session: SessionManager, text: string, timestamp: number): void {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: CODEX.api,
    provider: CODEX.provider,
    model: CODEX.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  });
}

/** One run's boundary hooks: each observes usage after the previous candidate settled. */
async function boundaryHooks(core: OwnerCore, session: SessionManager): Promise<void> {
  for (const hook of ["turn_end", "agent_before_settle", "agent_settled"]) {
    // Extension state entries land between hooks; they do not move the context position.
    session.appendCustomEntry("burst-fixture-state", { hook });
    core.observeUsage(USAGE);
    await core.coordinator.waitForPreparation();
  }
}

function candidateIds(records: readonly LaneRecordInput[]): (string | undefined)[] {
  return records.map((record) => record.candidateId);
}

test("an unsupported lane yields for the owner: one candidate and one record per burst", async () => {
  const lane = new ScriptedCodexLane({ supported: false, reason: "unsupported" }, { legal: true });
  const { core, session, records } = await rig({ lane, cooldownMs: 0 });
  try {
    // Three observations in one tick: the first candidate is still outstanding.
    core.observeUsage(USAGE);
    core.observeUsage(USAGE);
    core.observeUsage(USAGE);
    await core.coordinator.waitForPreparation();
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 1, "exactly one candidate");
    assert.equal(records.length, 1, "exactly one lane record");
    assert.deepEqual(
      records.map(({ route, event, from, reason }) => ({ route, event, from, reason })),
      [{ route: "threshold", event: "fallback", from: "codex-native-v2", reason: "unsupported" }],
    );
    assert.equal(records[0]?.candidateId, core.coordinator.status().candidateId);

    // New messages do not lift the yield: only a replaced owner asks again.
    appendAssistant(session, "BURST-D", 4);
    session.appendMessage({ role: "user", content: "BURST-E", timestamp: 5 });
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 1, "the unsupported lane gets no further candidate");
    assert.equal(records.length, 1);
    assert.equal(lane.prepareCalls, 0, "no candidate reached the provider");
  } finally {
    core.dispose();
  }

  // A model or eligibility change replaces the owner; the new owner asks once.
  const replaced = await rig({ lane, cooldownMs: 0, ownerGeneration: 2, session, records });
  try {
    await boundaryHooks(replaced.core, session);
    assert.equal(lane.capabilityCalls, 2, "the replaced owner asks the lane once");
    assert.equal(records.length, 2);
    assert.notEqual(records[0]?.candidateId, records[1]?.candidateId);
  } finally {
    replaced.core.dispose();
  }
});

test("a refused cut is not retried at the same context position, even with no cooldown", async () => {
  const lane = new ScriptedCodexLane(
    { supported: true },
    { legal: false, reason: "no-legal-cut", detail: "no_state" },
  );
  const { core, session, records } = await rig({ lane, cooldownMs: 0 });
  try {
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 1, "exactly one candidate for the burst");
    assert.deepEqual(
      records.map(({ route, reason, detail }) => ({ route, reason, detail })),
      [{ route: "threshold", reason: "no-legal-cut", detail: "provider-error" }],
      "the unowned refusal code is journaled as provider-error, once",
    );

    // The next run moves the context: the lane may answer again.
    appendAssistant(session, "BURST-D", 4);
    session.appendMessage({ role: "user", content: "BURST-E", timestamp: 5 });
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 2, "one retry for the new context position");
    assert.equal(records.length, 2);
    assert.notEqual(records[0]?.candidateId, records[1]?.candidateId);
    assert.equal(lane.prepareCalls, 0, "a refused cut never reaches the provider");
  } finally {
    core.dispose();
  }
});

test("after a provider-error refusal the owner waits for the cooldown before a later position", async () => {
  const clock = manualClock();
  const lane = new ScriptedCodexLane(
    { supported: true },
    { legal: false, reason: "no-legal-cut", detail: "no_state" },
  );
  const cooldownMs = 60_000;
  const { core, session, records } = await rig({ lane, cooldownMs, clock });
  try {
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 1);
    appendAssistant(session, "BURST-D", 4);
    session.appendMessage({ role: "user", content: "BURST-E", timestamp: 5 });
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 1, "the owner's cooldown holds at a new position");
    clock.advance(cooldownMs - 1);
    core.observeUsage(USAGE);
    await core.coordinator.waitForPreparation();
    assert.equal(lane.capabilityCalls, 1, "still cooling one millisecond before the end");
    clock.advance(1);
    await boundaryHooks(core, session);
    assert.equal(lane.capabilityCalls, 2, "one candidate once the cooldown ended");
    assert.equal(new Set(candidateIds(records)).size, 2);
    assert.equal(records.length, 2, "one record per candidate");
  } finally {
    core.dispose();
  }
});

/** Position the session past the last observed context: a new user turn. */
function nextTurn(session: SessionManager, label: string, timestamp: number): void {
  appendAssistant(session, `${label}-REPLY`, timestamp);
  session.appendMessage({ role: "user", content: label, timestamp: timestamp + 1 });
}

// Review finding: the Codex lane answers a Daybreak capture (`access_programs`) with
// `unsupported` and a 60 s retry delay; Daybreak can be switched off within the same
// owner, so that answer must not bar the lane for the owner's lifetime.
test("an unsupported answer with a retry delay retries at a later position once the delay passed", async () => {
  const clock = manualClock();
  const retryAfterMs = 60_000;
  const lane = new ScriptedCodexLane(
    { supported: true },
    { legal: true },
    { ok: false, reason: "unsupported", retryable: false, retryAfterMs },
  );
  // No configured cooldown: only the reported delay holds the lane back.
  const { core, session, records } = await rig({ lane, cooldownMs: 0, clock });
  try {
    core.observeUsage(USAGE);
    core.observeUsage(USAGE);
    await core.coordinator.waitForPreparation();
    await boundaryHooks(core, session);
    assert.equal(lane.prepareCalls, 1, "exactly one candidate for the burst");
    assert.equal(core.coordinator.status().retryAfterMs, retryAfterMs, "the status carries it");

    nextTurn(session, "DAYBREAK-B", 10);
    await boundaryHooks(core, session);
    assert.equal(lane.prepareCalls, 1, "the reported delay holds at a new position");
    clock.advance(retryAfterMs - 1);
    core.observeUsage(USAGE);
    await core.coordinator.waitForPreparation();
    assert.equal(lane.prepareCalls, 1, "still cooling one millisecond before the delay ends");
    clock.advance(1);
    await boundaryHooks(core, session);
    assert.equal(lane.prepareCalls, 2, "one candidate at the new position after the delay");

    clock.advance(retryAfterMs);
    await boundaryHooks(core, session);
    assert.equal(lane.prepareCalls, 2, "not asked again at the same context position");
    assert.equal(records.length, 2, "one record per candidate");
    assert.equal(new Set(candidateIds(records)).size, 2);
    assert.deepEqual(
      records.map(({ event, reason }) => ({ event, reason })),
      [
        { event: "fallback", reason: "unsupported" },
        { event: "fallback", reason: "unsupported" },
      ],
    );
  } finally {
    core.dispose();
  }
});

test("an unsupported answer without a retry delay is never retried for the owner", async () => {
  const clock = manualClock();
  const lane = new ScriptedCodexLane({ supported: true }, { legal: true });
  const { core, session, records } = await rig({ lane, cooldownMs: 0, clock });
  try {
    await boundaryHooks(core, session);
    assert.equal(lane.prepareCalls, 1);
    assert.equal(core.coordinator.status().retryAfterMs, undefined);
    for (const [index, label] of ["PLAIN-B", "PLAIN-C"].entries()) {
      clock.advance(3_600_000);
      nextTurn(session, label, 10 + index * 2);
      await boundaryHooks(core, session);
    }
    assert.equal(lane.prepareCalls, 1, "the lane yields for the owner's lifetime");
    assert.equal(records.length, 1);
  } finally {
    core.dispose();
  }
});
