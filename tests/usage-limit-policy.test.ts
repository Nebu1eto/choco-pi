import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageSnapshot } from "../.pi/extensions/provider-usage.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  CODEX_USAGE_LIMIT_ENTRY,
  getUsageLimitPolicy,
  USAGE_LIMIT_PENDING_ENTRY,
  USAGE_LIMIT_RESOLVED_ENTRY,
} from "../.pi/extensions/lib/usage-limit-contract.ts";
import type {
  ChildSessionProbe,
  GoalRecoveryOwnership,
  OnUsageLimit,
  UsageLimitPendingEntry,
  UsageLimitResolvedEntry,
} from "../.pi/extensions/lib/usage-limit-contract.ts";
import { createUsageLimitPolicy } from "../.pi/extensions/lib/usage-limit.ts";
import type { ModelFallbacks } from "../.pi/extensions/lib/usage-limit.ts";
import {
  MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  registerUsageLimitController,
  REPLAY_GRACE_MS,
  RESET_MARGIN_MS,
  RESUME_MESSAGE,
  USAGE_LIMIT_MESSAGE_TYPE,
} from "../.pi/extensions/usage-limit-policy.ts";
import type {
  TimerHandle,
  UsageLimitHost,
  UsageLimitHostContext,
  UsageLimitHostEvents,
  UsageLimitPreferenceChange,
} from "../.pi/extensions/usage-limit-policy.ts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR_MS = 3_600_000;

const TABLE: ModelFallbacks = {
  tiers: {
    workhorse: {
      primary: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"],
      secondary: ["anthropic/claude-opus-5", "openai-codex/gpt-5.6-sol"],
    },
  },
  lastResort: ["synthetic/hf:moonshotai/Kimi-K3"],
};

type ModelStub = { provider: string; id: string };
type ThinkingLevel = ReturnType<UsageLimitHost<ModelStub, HarnessContext>["getThinkingLevel"]>;
type HarnessContext = UsageLimitHostContext<ModelStub>;
type HostEvents = UsageLimitHostEvents<ModelStub>;
type HostHandlerFor<Name extends keyof HostEvents> = (
  event: HostEvents[Name],
  ctx: HarnessContext,
) => Promise<void> | void;
type HostHandlers = { [Name in keyof HostEvents]?: HostHandlerFor<Name> };
type OnArguments = {
  [Name in keyof HostEvents]: [event: Name, handler: HostHandlerFor<Name>];
}[keyof HostEvents];
type SentMessage = { customType: string; content: string; display: boolean };
type HostEntry = UsageLimitPendingEntry | UsageLimitResolvedEntry;

type Timer = { at: number; callback: () => void; cancelled: boolean; delay: number };

const ANTHROPIC_429 = '429 {"type":"error","error":{"type":"rate_limit_error","message":"limit"}}';
const CODEX_LIMIT = "Codex usage limit reached (plus plan). Resets in ~12m.";
const BILLING = "insufficient_quota: You exceeded your current quota";

const model = (provider: string, id: string): ModelStub => ({ provider, id });
const OPUS = model("anthropic", "claude-opus-5-5");
const SOL = model("openai-codex", "gpt-6-sol");
const SOL_OLD = model("openai-codex", "gpt-5.6-sol");
const KIMI = model("synthetic", "hf:moonshotai/Kimi-K3");

function customEntry(id: string, customType: string, data: RuntimeValue): SessionEntry {
  return { type: "custom", id, parentId: null, timestamp: "", customType, data };
}

/** Holds callers at `wait()` until `release()`; open when not held. */
class Gate {
  private held: Promise<void> | undefined;
  private open: () => void = () => undefined;

  hold(): () => void {
    this.held = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    return () => this.release();
  }

  release(): void {
    this.held = undefined;
    this.open();
  }

  async wait(): Promise<void> {
    if (this.held) await this.held;
  }
}

/**
 * Typed host fixture: implements the controller's `UsageLimitHost` port (the
 * `ExtensionAPI` members it uses) and builds `UsageLimitHostContext` values.
 */
class Harness implements UsageLimitHost<ModelStub, HarnessContext> {
  readonly handlers: HostHandlers = {};
  readonly branch: SessionEntry[] = [];
  readonly sent: SentMessage[] = [];
  readonly notes: string[] = [];
  readonly setModelCalls: string[] = [];
  readonly timers: Timer[] = [];
  readonly refusedModels = new Set<string>();
  /** customType of every appended entry, on whichever branch was current. */
  readonly appended: string[] = [];
  readonly goalOwners: string[] = [];
  readonly accountIds = new Map<string, string>();
  readonly accountLookups: string[] = [];
  readonly preferenceListeners = new Set<(change: UsageLimitPreferenceChange) => void>();
  /** Held: `setModel` awaits authentication before it mutates, like `AgentSession.setModel`. */
  readonly auth = new Gate();
  /** Held: every usage snapshot read waits (corroboration in flight). */
  readonly snapshotGate = new Gate();
  private readonly preferenceGate = new Gate();
  snapshotReads = 0;
  preferences: OnUsageLimit[] = ["none"];
  goal: GoalRecoveryOwnership | undefined;
  probe: ChildSessionProbe | undefined;
  snapshot: ProviderUsageSnapshot | undefined;
  /** Synthetic quota store payload answered to both refresh and read requests. */
  synthetic: RuntimeValue = undefined;
  available: ModelStub[] = [OPUS, SOL, SOL_OLD, KIMI];
  currentModel: ModelStub | undefined = OPUS;
  sessionId = "root-1";
  idle = true;
  clock = T0;
  thinking: ThinkingLevel = "medium";
  private ids = 0;

  readonly events = {
    emit: (_channel: string, payload: RuntimeValue): void => {
      if (
        payload instanceof Object &&
        "respond" in payload &&
        payload.respond instanceof Function
      ) {
        payload.respond(this.synthetic);
      }
    },
  };

  on(event: "session_start", handler: HostHandlerFor<"session_start">): () => void;
  on(event: "session_shutdown", handler: HostHandlerFor<"session_shutdown">): () => void;
  on(event: "session_before_tree", handler: HostHandlerFor<"session_before_tree">): () => void;
  on(event: "session_tree", handler: HostHandlerFor<"session_tree">): () => void;
  on(event: "before_agent_start", handler: HostHandlerFor<"before_agent_start">): () => void;
  on(event: "agent_start", handler: HostHandlerFor<"agent_start">): () => void;
  on(event: "model_select", handler: HostHandlerFor<"model_select">): () => void;
  on(event: "agent_settled", handler: HostHandlerFor<"agent_settled">): () => void;
  on(...[event, handler]: OnArguments): () => void {
    switch (event) {
      case "session_start":
        this.handlers.session_start = handler;
        break;
      case "session_shutdown":
        this.handlers.session_shutdown = handler;
        break;
      case "session_before_tree":
        this.handlers.session_before_tree = handler;
        break;
      case "session_tree":
        this.handlers.session_tree = handler;
        break;
      case "before_agent_start":
        this.handlers.before_agent_start = handler;
        break;
      case "agent_start":
        this.handlers.agent_start = handler;
        break;
      case "model_select":
        this.handlers.model_select = handler;
        break;
      case "agent_settled":
        this.handlers.agent_settled = handler;
        break;
    }
    return () => {
      delete this.handlers[event];
    };
  }

  appendEntry(customType: string, data: HostEntry): void {
    this.appended.push(customType);
    this.branch.push(customEntry(`e${++this.ids}`, customType, data));
  }

  sendMessage(message: SentMessage): void {
    this.sent.push(message);
  }

  async setModel(next: ModelStub): Promise<boolean> {
    const key = `${next.provider}/${next.id}`;
    this.setModelCalls.push(key);
    await this.auth.wait();
    if (this.refusedModels.has(key)) return false;
    this.currentModel = next;
    this.thinking = "low";
    await this.fire("model_select", { type: "model_select", model: next, source: "set" });
    return true;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.thinking;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinking = level;
  }

  register(): void {
    registerUsageLimitController(this, {
      now: () => this.clock,
      schedule: (callback, delay) => this.schedule(callback, delay),
      createId: () => `rec-${++this.ids}`,
      readPreference: async () => {
        await this.preferenceGate.wait();
        return this.nextPreference();
      },
      createPolicy: ({ ctx: _ctx, ...options }) =>
        createUsageLimitPolicy({
          ...options,
          fallbacks: TABLE,
          usageSnapshot: async () => {
            this.snapshotReads += 1;
            await this.snapshotGate.wait();
            return this.snapshot;
          },
        }),
      readProbe: () => this.probe,
      readGoalOwnership: (owner) => {
        this.goalOwners.push(owner);
        return this.goal;
      },
      lookupAccountId: async (_ctx, provider) => {
        this.accountLookups.push(provider);
        return this.accountIds.get(provider);
      },
      onPreferenceChange: (listener) => {
        this.preferenceListeners.add(listener);
        return () => this.preferenceListeners.delete(listener);
      },
    });
  }

  /** Holds every preference read until the returned release runs. */
  holdPreference(): () => void {
    return this.preferenceGate.hold();
  }

  /** Writes the preference and notifies subscribers synchronously, like `writeAgentPreference`. */
  changePreference(value: OnUsageLimit): void {
    this.preferences = [value];
    for (const listener of this.preferenceListeners) {
      listener({ key: "agentOnUsageLimit", value });
    }
  }

  private nextPreference(): OnUsageLimit {
    const [first, ...rest] = this.preferences;
    if (rest.length > 0) this.preferences = rest;
    return first ?? "none";
  }

  private schedule(callback: () => void, delay: number): TimerHandle {
    const timer: Timer = { at: this.clock + delay, callback, cancelled: false, delay };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }

  get liveTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  ctx(): HarnessContext {
    const current = (): ModelStub | undefined => this.currentModel;
    return {
      hasUI: true,
      ui: { notify: (message: string) => this.notes.push(message) },
      sessionManager: {
        getSessionId: () => this.sessionId,
        getBranch: () => this.branch,
      },
      modelRegistry: { getAvailable: () => this.available },
      get model() {
        return current();
      },
      scopedModels: [],
      isIdle: () => this.idle,
      hasPendingMessages: () => false,
    };
  }

  async fire<Name extends keyof HostEvents>(name: Name, event: HostEvents[Name]): Promise<void> {
    const handler: HostHandlers[Name] = this.handlers[name];
    assert.ok(handler, `handler ${name} registered`);
    await handler(event, this.ctx());
  }

  /** A user `/model` choice: the host applies the model, then emits `model_select`. */
  async selectModel(next: ModelStub): Promise<void> {
    this.currentModel = next;
    this.thinking = "high";
    await this.fire("model_select", { type: "model_select", model: next, source: "set" });
  }

  start(reason: HostEvents["session_start"]["reason"] = "new"): Promise<void> {
    return this.fire("session_start", { type: "session_start", reason });
  }

  shutdown(reason: HostEvents["session_shutdown"]["reason"]): Promise<void> {
    return this.fire("session_shutdown", { type: "session_shutdown", reason });
  }

  settle(): Promise<void> {
    return this.fire("agent_settled", { type: "agent_settled" });
  }

  pushAssistant(provider: string, id: string, errorMessage?: string): void {
    this.branch.push({
      type: "message",
      id: `m${++this.ids}`,
      parentId: null,
      timestamp: "",
      message: {
        role: "assistant",
        provider,
        model: id,
        api: "test",
        stopReason: errorMessage === undefined ? "stop" : "error",
        errorMessage,
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: this.clock,
      },
    });
  }

  /** Advances the fake clock, running due timers and letting their async work finish. */
  async advance(ms: number): Promise<void> {
    this.clock += ms;
    for (const timer of this.liveTimers.filter((entry) => entry.at <= this.clock)) {
      timer.cancelled = true;
      timer.callback();
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await new Promise((done) => setImmediate(done));
  }

  customEntries(customType: string): RuntimeValue[] {
    return this.branch.flatMap((entry) =>
      entry.type === "custom" && entry.customType === customType ? [entry.data] : [],
    );
  }

  resolved(): UsageLimitResolvedEntry[] {
    return this.customEntries(USAGE_LIMIT_RESOLVED_ENTRY).flatMap((data) =>
      isResolved(data) ? [data] : [],
    );
  }

  pending(): UsageLimitPendingEntry[] {
    return this.customEntries(USAGE_LIMIT_PENDING_ENTRY).flatMap((data) =>
      isPending(data) ? [data] : [],
    );
  }
}

function isResolved(value: RuntimeValue): value is UsageLimitResolvedEntry {
  return value !== null && value !== undefined && "outcome" in value && "recoveryId" in value;
}

function isPending(value: RuntimeValue): value is UsageLimitPendingEntry {
  return value !== null && value !== undefined && "attempts" in value && "recoveryId" in value;
}

function exhausted(resetAt: number, observedAt: number): ProviderUsageSnapshot {
  return {
    observedAt,
    windows: [{ label: "5h", percent: 100, qualifier: "used", eventAt: new Date(resetAt) }],
  };
}

function available(observedAt: number): ProviderUsageSnapshot {
  return { observedAt, windows: [{ label: "5h", percent: 20, qualifier: "used" }] };
}

/** Synthetic quota store payload whose request subscription is used up. */
function syntheticExhausted(updatedAt: number, renewsAt: number): RuntimeValue {
  return {
    source: "api",
    updatedAt,
    quotas: {
      subscription: { limit: 100, requests: 100, renewsAt: new Date(renewsAt).toISOString() },
    },
  };
}

async function started(setup: (harness: Harness) => void = () => undefined): Promise<Harness> {
  const harness = new Harness();
  setup(harness);
  harness.register();
  await harness.start();
  return harness;
}

test("session_start registers the owner policy and unregisters the previous owner", async () => {
  const harness = await started();
  assert.ok(getUsageLimitPolicy("root-1"));
  harness.sessionId = "root-2";
  await harness.start("resume");
  assert.equal(getUsageLimitPolicy("root-1"), undefined);
  assert.ok(getUsageLimitPolicy("root-2"));
  await harness.shutdown("quit");
  assert.equal(getUsageLimitPolicy("root-2"), undefined);
});

test("none: notifies and closes the provider without switching or continuing", async () => {
  const harness = await started((h) => {
    h.preferences = ["none"];
    h.sessionId = "none-1";
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(harness.notes.length, 1);
  assert.match(
    harness.notes[0] ?? "",
    /^Anthropic quota limit reached; resets in ~60m\. Use \/model/,
  );
  assert.equal(getUsageLimitPolicy("none-1")?.isClosed("anthropic", "default", T0 + 1), true);
  await harness.settle();
  assert.equal(harness.notes.length, 1, "the same errored entry is handled once");
});

test("fallback: skips a refused candidate, switches, continues, and stops after two switches", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
    h.sessionId = "fallback-1";
  });
  harness.refusedModels.add("openai-codex/gpt-6-sol");
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  assert.deepEqual(harness.setModelCalls, ["openai-codex/gpt-6-sol", "openai-codex/gpt-5.6-sol"]);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.customType, USAGE_LIMIT_MESSAGE_TYPE);
  assert.match(harness.sent[0]?.content ?? "", /Switched to openai-codex\/gpt-5\.6-sol\. Continue/);
  assert.equal(harness.thinking, "medium", "thinking level is re-applied after the switch");

  harness.pushAssistant("openai-codex", "gpt-5.6-sol", CODEX_LIMIT);
  await harness.settle();
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1]?.content ?? "", /Switched to synthetic\/hf:moonshotai\/Kimi-K3/);

  harness.synthetic = syntheticExhausted(harness.clock, harness.clock + HOUR_MS);
  harness.pushAssistant("synthetic", "hf:moonshotai/Kimi-K3", "429: quota");
  await harness.settle();
  assert.equal(harness.sent.length, 2, "third limit does not switch");
  assert.match(harness.notes.at(-1) ?? "", /No fallback model available/);

  harness.pushAssistant("synthetic", "hf:moonshotai/Kimi-K3");
  await harness.settle();
  await harness.advance(HOUR_MS);
  harness.currentModel = OPUS;
  harness.snapshot = exhausted(harness.clock + HOUR_MS, harness.clock);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  assert.equal(harness.sent.length, 3, "a successful settle resets the budget");
});

test("billing never auto-resumes", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.pushAssistant("anthropic", "claude-opus-5-5", BILLING);
  await harness.settle();
  assert.equal(harness.pending().length, 0);
  assert.equal(harness.liveTimers.length, 0);
  assert.equal(harness.sent.length, 0);
  assert.match(harness.notes[0] ?? "", /billing limit reached/);
});

test("auto-resume arms, re-arms while not ready, then continues once ready", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  const firstReset = T0 + HOUR_MS;
  harness.snapshot = exhausted(firstReset, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  assert.equal(pending.resetAt, firstReset);
  assert.equal(pending.attempts, 1);
  assert.equal(harness.liveTimers.length, 1);
  assert.equal(harness.liveTimers[0]?.delay, HOUR_MS + RESET_MARGIN_MS);

  const secondReset = firstReset + 2 * HOUR_MS;
  harness.snapshot = exhausted(secondReset, firstReset + RESET_MARGIN_MS);
  await harness.advance(HOUR_MS + RESET_MARGIN_MS);
  assert.equal(harness.resolved().length, 0);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.liveTimers.length, 1, "re-armed to the new reset");
  assert.equal(harness.liveTimers[0]?.at, secondReset + RESET_MARGIN_MS);

  harness.snapshot = available(secondReset + RESET_MARGIN_MS);
  await harness.advance(2 * HOUR_MS);
  assert.deepEqual(harness.resolved(), [{ recoveryId: pending.recoveryId, outcome: "continued" }]);
  assert.deepEqual(harness.sent, [
    { customType: USAGE_LIMIT_MESSAGE_TYPE, content: RESUME_MESSAGE, display: true },
  ]);
  assert.equal(harness.liveTimers.length, 0);
});

test("auto-resume caps a wait at 24 hours and polls when no reset is known", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.snapshot = exhausted(T0 + 72 * HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  assert.equal(harness.liveTimers[0]?.delay, MAX_WAIT_MS);

  const unknown = await started((h) => {
    h.preferences = ["auto-resume"];
    h.sessionId = "poll-1";
  });
  // An exhausted window without a reset time confirms the limit but gives no wake-up time.
  unknown.snapshot = {
    observedAt: T0,
    windows: [{ label: "5h", percent: 100, qualifier: "used" }],
  };
  unknown.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await unknown.settle();
  assert.equal(unknown.liveTimers[0]?.delay, POLL_INTERVAL_MS);
  for (let poll = 0; poll < 72; poll += 1) await unknown.advance(POLL_INTERVAL_MS);
  assert.equal(unknown.resolved().at(-1)?.outcome, "exhausted");
  assert.equal(unknown.sent.length, 0, "never continues on a timer alone");
  assert.equal(unknown.liveTimers.length, 0);
});

test("a user turn cancels the armed recovery with a durable entry", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  await harness.fire("before_agent_start", { type: "before_agent_start" });
  assert.deepEqual(harness.resolved(), [{ recoveryId: pending.recoveryId, outcome: "cancelled" }]);
  assert.equal(harness.liveTimers.length, 0);
});

test("a child session leaves the controller inert", async () => {
  const contextChild = new Harness();
  contextChild.probe = { isChildSessionContext: () => true, isChildSessionId: () => false };
  contextChild.register();
  assert.equal(
    Object.keys(contextChild.handlers).length,
    0,
    "factory-time probe registers nothing",
  );

  const idChild = new Harness();
  idChild.sessionId = "child-1";
  idChild.preferences = ["fallback"];
  idChild.probe = {
    isChildSessionContext: () => false,
    isChildSessionId: (id) => id === "child-1",
  };
  idChild.register();
  await idChild.start();
  assert.equal(getUsageLimitPolicy("child-1"), undefined);
  idChild.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await idChild.settle();
  assert.equal(idChild.setModelCalls.length, 0);
  assert.equal(idChild.notes.length, 0);
});

test("a paused goal owns recovery: notify only", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
    h.goal = { goalId: "g1", status: "paused", providerLimitResumeScheduled: true };
  });
  harness.pushAssistant("openai-codex", "gpt-6-sol", CODEX_LIMIT);
  await harness.settle();
  assert.equal(harness.setModelCalls.length, 0);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.pending().length, 0);
  assert.match(harness.notes[0] ?? "", /Goal recovery owns the resume/);
});

function pendingEntry(recoveryId: string, resetAt: number): UsageLimitPendingEntry {
  return {
    recoveryId,
    resetAt,
    modelId: "claude-opus-5-5",
    provider: "anthropic",
    accountId: "default",
    attempts: 1,
  };
}

test("replay re-arms only an unresolved pending entry; a passed reset re-checks after the grace", async () => {
  const replayed = new Harness();
  replayed.preferences = ["auto-resume"];
  replayed.register();
  replayed.branch.push(
    {
      type: "custom",
      id: "p1",
      parentId: null,
      timestamp: "",
      customType: USAGE_LIMIT_PENDING_ENTRY,
      data: pendingEntry("old", T0 + HOUR_MS),
    },
    {
      type: "custom",
      id: "r1",
      parentId: null,
      timestamp: "",
      customType: USAGE_LIMIT_RESOLVED_ENTRY,
      data: { recoveryId: "old", outcome: "cancelled" },
    },
    {
      type: "custom",
      id: "p2",
      parentId: null,
      timestamp: "",
      customType: USAGE_LIMIT_PENDING_ENTRY,
      data: pendingEntry("live", T0 + HOUR_MS),
    },
  );
  await replayed.start("startup");
  assert.equal(replayed.liveTimers.length, 1);
  assert.equal(replayed.liveTimers[0]?.at, T0 + HOUR_MS + RESET_MARGIN_MS);

  const past = new Harness();
  past.preferences = ["auto-resume"];
  past.register();
  past.branch.push({
    type: "custom",
    id: "p1",
    parentId: null,
    timestamp: "",
    customType: USAGE_LIMIT_PENDING_ENTRY,
    data: pendingEntry("stale", T0 - 1),
  });
  await past.start("resume");
  assert.equal(past.liveTimers.length, 1, "a passed reset is re-checked, not skipped");
  assert.equal(past.liveTimers[0]?.delay, REPLAY_GRACE_MS);

  const resolvedOnly = new Harness();
  resolvedOnly.preferences = ["auto-resume"];
  resolvedOnly.register();
  resolvedOnly.branch.push(
    {
      type: "custom",
      id: "p1",
      parentId: null,
      timestamp: "",
      customType: USAGE_LIMIT_PENDING_ENTRY,
      data: pendingEntry("done", T0 + HOUR_MS),
    },
    {
      type: "custom",
      id: "r1",
      parentId: null,
      timestamp: "",
      customType: USAGE_LIMIT_RESOLVED_ENTRY,
      data: { recoveryId: "done", outcome: "continued" },
    },
  );
  await resolvedOnly.start("startup");
  assert.equal(resolvedOnly.liveTimers.length, 0);

  const freshSession = new Harness();
  freshSession.preferences = ["auto-resume"];
  freshSession.register();
  freshSession.branch.push({
    type: "custom",
    id: "p1",
    parentId: null,
    timestamp: "",
    customType: USAGE_LIMIT_PENDING_ENTRY,
    data: pendingEntry("new", T0 + HOUR_MS),
  });
  await freshSession.start("new");
  assert.equal(freshSession.liveTimers.length, 0, "only startup/reload/resume replay");
  await freshSession.start("fork");
  assert.equal(freshSession.liveTimers.length, 0, "a fork does not replay");
});

test("the controller's own model_select does not cancel; a user model_select does", async () => {
  const harness = new Harness();
  harness.preferences = ["auto-resume"];
  harness.register();
  harness.branch.push({
    type: "custom",
    id: "p1",
    parentId: null,
    timestamp: "",
    customType: USAGE_LIMIT_PENDING_ENTRY,
    data: pendingEntry("live", T0 + HOUR_MS),
  });
  await harness.start("startup");
  assert.equal(harness.liveTimers.length, 1);
  // First read keeps the armed recovery; the second routes this limit through fallback.
  harness.preferences = ["auto-resume", "fallback"];
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  assert.deepEqual(harness.setModelCalls, ["openai-codex/gpt-6-sol"]);
  assert.equal(harness.resolved().length, 0, "own model_select kept the recovery");
  await harness.fire("model_select", {
    type: "model_select",
    model: OPUS,
    source: "set",
  });
  assert.deepEqual(harness.resolved(), [{ recoveryId: "live", outcome: "cancelled" }]);
});

test("a wake-up after the user changed model cancels instead of continuing", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  harness.currentModel = SOL;
  await harness.advance(HOUR_MS + RESET_MARGIN_MS);
  assert.equal(harness.resolved().at(-1)?.outcome, "cancelled");
  assert.equal(harness.sent.length, 0);
});

test("changing the preference away from auto-resume cancels at the next settle", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  harness.preferences = ["none"];
  await harness.settle();
  assert.equal(harness.resolved().at(-1)?.outcome, "cancelled");
  assert.equal(harness.liveTimers.length, 0);
});

test("a resumed turn that hits the limit again retries at most three times", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    harness.snapshot = exhausted(harness.clock + HOUR_MS, harness.clock);
    harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
    await harness.settle();
    assert.equal(harness.pending().at(-1)?.attempts, attempt);
    harness.snapshot = available(harness.clock + HOUR_MS + RESET_MARGIN_MS);
    await harness.advance(HOUR_MS + RESET_MARGIN_MS);
    assert.equal(harness.sent.length, attempt);
  }
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  harness.snapshot = exhausted(harness.clock + HOUR_MS, harness.clock);
  await harness.settle();
  const pending = harness.pending();
  const resolved = harness.resolved();
  assert.equal(pending.length, 4, "the exhausted attempt gets its own recovery id");
  assert.equal(new Set(pending.map((entry) => entry.recoveryId)).size, 4);
  assert.deepEqual(
    resolved,
    pending.map((entry, index) => ({
      recoveryId: entry.recoveryId,
      outcome: index < 3 ? "continued" : "exhausted",
    })),
    "every recovery id resolves exactly once",
  );
  assert.equal(pending.at(-1)?.attempts, 4);
  assert.equal(harness.liveTimers.length, 0);
  assert.match(harness.notes.at(-1) ?? "", /retries exhausted/);
});

const CANCELLATIONS: readonly { name: string; fire: (harness: Harness) => Promise<void> }[] = [
  { name: "model_select", fire: (harness) => harness.selectModel(SOL) },
  {
    name: "before_agent_start",
    fire: (harness) => harness.fire("before_agent_start", { type: "before_agent_start" }),
  },
  {
    name: "session_before_tree",
    fire: (harness) => harness.fire("session_before_tree", { type: "session_before_tree" }),
  },
  {
    name: "session_tree",
    fire: (harness) => harness.fire("session_tree", { type: "session_tree" }),
  },
];

for (const { name, fire } of CANCELLATIONS) {
  test(`${name} during a settle's preference read arms nothing`, async () => {
    const harness = await started((h) => {
      h.preferences = ["auto-resume"];
    });
    harness.snapshot = exhausted(T0 + HOUR_MS, T0);
    harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
    const release = harness.holdPreference();
    const settling = harness.settle();
    await fire(harness);
    release();
    await settling;
    await harness.flush();
    assert.equal(harness.pending().length, 0);
    assert.equal(harness.liveTimers.length, 0);
    assert.equal(harness.sent.length, 0);
    assert.equal(harness.notes.length, 0);
  });
}

test("fallback: a user model change during the settle prevents setModel", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  const release = harness.holdPreference();
  const settling = harness.settle();
  await harness.selectModel(SOL_OLD);
  release();
  await settling;
  assert.deepEqual(harness.setModelCalls, []);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.notes.length, 0);
});

test("a user turn during a wake-up's preference read prevents the continuation", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  harness.snapshot = available(T0 + HOUR_MS + RESET_MARGIN_MS);
  const release = harness.holdPreference();
  await harness.advance(HOUR_MS + RESET_MARGIN_MS);
  await harness.fire("before_agent_start", { type: "before_agent_start" });
  release();
  await harness.flush();
  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.resolved(), [{ recoveryId: pending.recoveryId, outcome: "cancelled" }]);
});

test("an inferred limit that live data shows has capacity is transient", async () => {
  for (const preference of ["auto-resume", "fallback"] as const) {
    const harness = await started((h) => {
      h.preferences = [preference];
      h.sessionId = `capacity-${preference}`;
    });
    harness.snapshot = available(T0);
    harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
    await harness.settle();
    assert.equal(harness.pending().length, 0);
    assert.equal(harness.liveTimers.length, 0);
    assert.deepEqual(harness.setModelCalls, []);
    assert.equal(harness.sent.length, 0);
    assert.equal(
      getUsageLimitPolicy(`capacity-${preference}`)?.isClosed("anthropic", "default", T0 + 1),
      false,
    );
    assert.match(
      harness.notes[0] ?? "",
      /not a confirmed usage limit \(live usage data shows capacity\)/,
    );
  }
});

test("an inferred limit without usage data falls back but does not auto-resume", async () => {
  const fallback = await started((h) => {
    h.preferences = ["fallback"];
    h.sessionId = "unavailable-fallback";
  });
  fallback.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await fallback.settle();
  assert.deepEqual(fallback.setModelCalls, ["openai-codex/gpt-6-sol"]);
  assert.equal(fallback.sent.length, 1);
  assert.equal(
    getUsageLimitPolicy("unavailable-fallback")?.isClosed("anthropic", "default", T0 + 1),
    true,
  );

  const resume = await started((h) => {
    h.preferences = ["auto-resume"];
    h.sessionId = "unavailable-auto-resume";
  });
  resume.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await resume.settle();
  assert.equal(resume.pending().length, 0);
  assert.equal(resume.liveTimers.length, 0);
  assert.equal(
    getUsageLimitPolicy("unavailable-auto-resume")?.isClosed("anthropic", "default", T0 + 1),
    true,
  );
  assert.match(resume.notes[0] ?? "", /cannot confirm the reset/);
});

test("a parsed limit without usage data closes and may fall back but never auto-resumes", async () => {
  const fallback = await started((h) => {
    h.preferences = ["fallback"];
    h.currentModel = SOL;
    h.sessionId = "parsed-fallback";
  });
  fallback.pushAssistant("openai-codex", "gpt-6-sol", CODEX_LIMIT);
  await fallback.settle();
  assert.deepEqual(fallback.setModelCalls, ["anthropic/claude-opus-5-5"]);
  assert.equal(fallback.sent.length, 1);
  assert.equal(
    getUsageLimitPolicy("parsed-fallback")?.isClosed("openai-codex", "default", T0 + 1),
    true,
  );

  const resume = await started((h) => {
    h.preferences = ["auto-resume"];
    h.currentModel = SOL;
    h.sessionId = "parsed-resume";
  });
  resume.pushAssistant("openai-codex", "gpt-6-sol", CODEX_LIMIT);
  await resume.settle();
  assert.equal(resume.pending().length, 0);
  assert.equal(resume.liveTimers.length, 0);
  assert.equal(resume.sent.length, 0);
  assert.equal(
    getUsageLimitPolicy("parsed-resume")?.isClosed("openai-codex", "default", T0 + 1),
    true,
  );
  assert.match(resume.notes[0] ?? "", /cannot confirm the reset/);
});

test("fallback skips a provider closed under its resolved account id", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback", "fallback"];
    h.currentModel = SOL;
    h.sessionId = "account-1";
    h.accountIds.set("openai-codex", "acct");
  });
  harness.branch.push({
    type: "custom",
    id: "codex-entry",
    parentId: null,
    timestamp: "",
    customType: CODEX_USAGE_LIMIT_ENTRY,
    data: { observedAt: T0, resetAt: T0 + HOUR_MS, accountId: "acct" },
  });
  harness.pushAssistant("openai-codex", "gpt-6-sol", CODEX_LIMIT);
  await harness.settle();
  assert.deepEqual(harness.setModelCalls, ["anthropic/claude-opus-5-5"]);
  const policy = getUsageLimitPolicy("account-1");
  assert.equal(policy?.isClosed("openai-codex", "acct", T0 + 1), true);
  assert.ok(harness.accountLookups.includes("openai-codex"));

  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  assert.deepEqual(
    harness.setModelCalls,
    ["anthropic/claude-opus-5-5", "synthetic/hf:moonshotai/Kimi-K3"],
    "both Codex candidates are closed under account acct",
  );
});

test("goal ownership is read for this root session", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
    h.sessionId = "goal-owner";
  });
  harness.pushAssistant("openai-codex", "gpt-6-sol", CODEX_LIMIT);
  await harness.settle();
  assert.deepEqual(harness.goalOwners, ["goal-owner"]);
});

test("tree navigation resolves the recovery on the old branch before the switch", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  await harness.fire("session_before_tree", { type: "session_before_tree" });
  assert.deepEqual(harness.resolved(), [{ recoveryId: pending.recoveryId, outcome: "cancelled" }]);
  assert.equal(harness.liveTimers.length, 0);

  const appended = harness.appended.length;
  harness.branch.splice(0, harness.branch.length);
  await harness.fire("session_tree", { type: "session_tree" });
  assert.equal(harness.appended.length, appended, "session_tree appends nothing");
  assert.equal(harness.branch.length, 0);
});

test("fallback: a user model choice made while setModel awaits auth is restored afterwards", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
    h.sessionId = "overwrite-1";
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  const releaseAuth = harness.auth.hold();
  const settling = harness.settle();
  await harness.flush();
  assert.deepEqual(harness.setModelCalls, ["openai-codex/gpt-6-sol"], "switch awaits auth");
  await harness.selectModel(KIMI);
  releaseAuth();
  await settling;
  await harness.flush();
  assert.deepEqual(harness.setModelCalls, [
    "openai-codex/gpt-6-sol",
    "synthetic/hf:moonshotai/Kimi-K3",
  ]);
  assert.deepEqual(harness.currentModel, KIMI, "the user's choice wins");
  assert.equal(harness.thinking, "high", "the user's thinking level is re-applied");
  assert.equal(harness.sent.length, 0, "no continuation after a cancelled switch");
});

test("fallback: a switch invalidated without a user model choice is not reverted", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
    h.sessionId = "overwrite-2";
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  const releaseAuth = harness.auth.hold();
  const settling = harness.settle();
  await harness.flush();
  await harness.fire("before_agent_start", { type: "before_agent_start" });
  releaseAuth();
  await settling;
  await harness.flush();
  assert.deepEqual(harness.setModelCalls, ["openai-codex/gpt-6-sol"]);
  assert.equal(harness.sent.length, 0);
});

test("a preference change during corroboration stops the in-flight fallback", async () => {
  const harness = await started((h) => {
    h.preferences = ["fallback"];
    h.sessionId = "pref-inflight";
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  const releaseSnapshot = harness.snapshotGate.hold();
  const settling = harness.settle();
  await harness.flush();
  assert.equal(harness.snapshotReads, 1, "the settle read the preference and awaits corroboration");
  harness.changePreference("none");
  releaseSnapshot();
  await settling;
  await harness.flush();
  assert.deepEqual(harness.setModelCalls, []);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.notes.length, 0);
});

test("a preference change durably cancels an armed auto-resume; other keys do not", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
    h.sessionId = "pref-armed";
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  for (const listener of harness.preferenceListeners) listener({ key: "agentStyle" });
  assert.equal(harness.resolved().length, 0, "an unrelated preference keeps the recovery");
  assert.equal(harness.liveTimers.length, 1);

  harness.changePreference("fallback");
  assert.deepEqual(harness.resolved(), [{ recoveryId: pending.recoveryId, outcome: "cancelled" }]);
  assert.equal(harness.liveTimers.length, 0);
  harness.snapshot = available(T0 + HOUR_MS + RESET_MARGIN_MS);
  await harness.advance(HOUR_MS + RESET_MARGIN_MS);
  assert.equal(harness.sent.length, 0);
});

test("rewriting the armed mode keeps the wait; a different value still cancels", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
    h.sessionId = "pref-same";
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  harness.changePreference("auto-resume");
  assert.equal(harness.resolved().length, 0, "the same value does not cancel");
  assert.equal(harness.liveTimers.length, 1);

  harness.snapshot = available(T0 + HOUR_MS + RESET_MARGIN_MS);
  await harness.advance(HOUR_MS + RESET_MARGIN_MS);
  assert.deepEqual(harness.resolved(), [{ recoveryId: pending.recoveryId, outcome: "continued" }]);
  assert.equal(harness.sent.length, 1);

  harness.snapshot = exhausted(harness.clock + HOUR_MS, harness.clock);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const second = harness.pending().at(-1);
  assert.ok(second);
  harness.changePreference("none");
  assert.deepEqual(harness.resolved().at(-1), {
    recoveryId: second.recoveryId,
    outcome: "cancelled",
  });
  assert.equal(harness.liveTimers.length, 0);
});

test("the root controller tags its classification so its own Codex entry is used", async () => {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
    h.currentModel = SOL;
    h.sessionId = "codex-owner";
  });
  const resetAt = T0 + 2 * HOUR_MS;
  harness.branch.push({
    type: "custom",
    id: "codex-entry-own",
    parentId: null,
    timestamp: "",
    customType: CODEX_USAGE_LIMIT_ENTRY,
    data: { observedAt: T0, resetAt, accountId: "acct" },
  });
  // No window data: only the structured branch entry can confirm the limit.
  harness.pushAssistant("openai-codex", "gpt-6-sol", CODEX_LIMIT);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending, "auto-resume armed from the root's own structured entry");
  assert.equal(pending.resetAt, resetAt);
  assert.equal(pending.accountId, "acct");
});

test("the preference subscription is dropped on session shutdown", async () => {
  const harness = await started((h) => {
    h.sessionId = "pref-shutdown";
  });
  assert.equal(harness.preferenceListeners.size, 1);
  await harness.start("resume");
  assert.equal(harness.preferenceListeners.size, 1, "a session switch keeps one subscription");
  await harness.shutdown("quit");
  assert.equal(harness.preferenceListeners.size, 0);
});

function pendingAt(id: string, data: UsageLimitPendingEntry, recordedAt: number): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date(recordedAt).toISOString(),
    customType: USAGE_LIMIT_PENDING_ENTRY,
    data,
  };
}

async function armedAutoResume(sessionId: string): Promise<{
  harness: Harness;
  pending: UsageLimitPendingEntry;
}> {
  const harness = await started((h) => {
    h.preferences = ["auto-resume"];
    h.sessionId = sessionId;
  });
  harness.snapshot = exhausted(T0 + HOUR_MS, T0);
  harness.pushAssistant("anthropic", "claude-opus-5-5", ANTHROPIC_429);
  await harness.settle();
  const [pending] = harness.pending();
  assert.ok(pending);
  return { harness, pending };
}

const DURABLE_CYCLES = [
  { shutdown: "quit", start: "startup" },
  { shutdown: "reload", start: "reload" },
  { shutdown: "resume", start: "resume" },
] as const;

for (const cycle of DURABLE_CYCLES) {
  test(`shutdown(${cycle.shutdown}) keeps the wait durable and start(${cycle.start}) re-arms it`, async () => {
    const { harness, pending } = await armedAutoResume(`durable-${cycle.shutdown}`);
    assert.equal(
      pending.sessionId,
      `durable-${cycle.shutdown}`,
      "the pending entry names its writer",
    );
    await harness.shutdown(cycle.shutdown);
    assert.deepEqual(harness.resolved(), [], "shutdown writes no resolved entry");
    assert.equal(harness.liveTimers.length, 0, "shutdown stops the timer");

    await harness.start(cycle.start);
    assert.equal(harness.liveTimers.length, 1);
    assert.equal(harness.liveTimers[0]?.at, T0 + HOUR_MS + RESET_MARGIN_MS);
    harness.snapshot = available(T0 + HOUR_MS + RESET_MARGIN_MS);
    await harness.advance(HOUR_MS + RESET_MARGIN_MS);
    assert.deepEqual(harness.resolved(), [
      { recoveryId: pending.recoveryId, outcome: "continued" },
    ]);
    assert.deepEqual(harness.sent, [
      { customType: USAGE_LIMIT_MESSAGE_TYPE, content: RESUME_MESSAGE, display: true },
    ]);
  });
}

test("a new process replays the persisted wait of the same session", async () => {
  const { harness, pending } = await armedAutoResume("restart-1");
  await harness.shutdown("quit");
  const restarted = new Harness();
  restarted.preferences = ["auto-resume"];
  restarted.sessionId = "restart-1";
  restarted.branch.push(...harness.branch);
  restarted.register();
  await restarted.start("startup");
  assert.equal(restarted.liveTimers.length, 1);
  assert.equal(restarted.liveTimers[0]?.at, T0 + HOUR_MS + RESET_MARGIN_MS);
  assert.equal(restarted.pending().at(-1)?.recoveryId, pending.recoveryId);
});

test("a replayed reset that already passed continues after the grace delay", async () => {
  const harness = new Harness();
  harness.preferences = ["auto-resume"];
  harness.branch.push(
    pendingAt(
      "p1",
      { ...pendingEntry("passed", T0 - HOUR_MS), sessionId: "root-1" },
      T0 - 2 * HOUR_MS,
    ),
  );
  harness.register();
  await harness.start("startup");
  assert.equal(harness.liveTimers.length, 1);
  assert.equal(harness.liveTimers[0]?.delay, REPLAY_GRACE_MS);
  harness.snapshot = available(T0 + REPLAY_GRACE_MS);
  await harness.advance(REPLAY_GRACE_MS - 1);
  assert.equal(harness.sent.length, 0, "nothing fires before the grace delay");
  await harness.advance(1);
  assert.deepEqual(harness.resolved(), [{ recoveryId: "passed", outcome: "continued" }]);
  assert.deepEqual(harness.sent, [
    { customType: USAGE_LIMIT_MESSAGE_TYPE, content: RESUME_MESSAGE, display: true },
  ]);
});

test("replayed polling stays bounded from the original reset across restarts", async () => {
  const harness = new Harness();
  harness.preferences = ["auto-resume"];
  const { resetAt: _resetAt, ...unknownReset } = pendingEntry("unknown", T0);
  harness.branch.push(pendingAt("p1", unknownReset, T0 - 7 * HOUR_MS));
  harness.register();
  await harness.start("startup");
  assert.equal(harness.liveTimers[0]?.delay, REPLAY_GRACE_MS, "an unknown reset gets one check");
  harness.snapshot = {
    observedAt: T0,
    windows: [{ label: "5h", percent: 100, qualifier: "used" }],
  };
  await harness.advance(REPLAY_GRACE_MS);
  assert.deepEqual(harness.resolved(), [{ recoveryId: "unknown", outcome: "exhausted" }]);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.liveTimers.length, 0);
});

test("replay resolves cancelled when the preference is no longer auto-resume", async () => {
  const harness = new Harness();
  harness.preferences = ["none"];
  harness.branch.push(pendingAt("p1", pendingEntry("stale-pref", T0 + HOUR_MS), T0));
  harness.register();
  await harness.start("startup");
  assert.deepEqual(harness.resolved(), [{ recoveryId: "stale-pref", outcome: "cancelled" }]);
  assert.equal(harness.liveTimers.length, 0);
  await harness.advance(HOUR_MS + RESET_MARGIN_MS);
  assert.equal(harness.sent.length, 0);
});

test("a cancellation or shutdown during replay's preference read is respected", async () => {
  const userTurn = new Harness();
  userTurn.preferences = ["auto-resume"];
  userTurn.branch.push(pendingAt("p1", pendingEntry("turn", T0 + HOUR_MS), T0));
  userTurn.register();
  let release = userTurn.holdPreference();
  let starting = userTurn.start("startup");
  await userTurn.flush();
  await userTurn.fire("before_agent_start", { type: "before_agent_start" });
  release();
  await starting;
  assert.deepEqual(userTurn.resolved(), [{ recoveryId: "turn", outcome: "cancelled" }]);
  assert.equal(userTurn.liveTimers.length, 0);

  const quit = new Harness();
  quit.preferences = ["none"];
  quit.branch.push(pendingAt("p1", pendingEntry("quit", T0 + HOUR_MS), T0));
  quit.register();
  release = quit.holdPreference();
  starting = quit.start("startup");
  await quit.flush();
  await quit.shutdown("quit");
  release();
  await starting;
  assert.deepEqual(quit.resolved(), [], "a detached replay writes nothing");
  assert.equal(quit.liveTimers.length, 0);
});

test("a pending entry written by another session (fork/clone copy) does not replay", async () => {
  const harness = new Harness();
  harness.preferences = ["auto-resume"];
  harness.sessionId = "fork-1";
  harness.branch.push(
    pendingAt("p1", { ...pendingEntry("parent", T0 + HOUR_MS), sessionId: "parent-1" }, T0),
  );
  harness.register();
  for (const reason of ["startup", "reload", "resume"] as const) {
    await harness.start(reason);
    assert.equal(harness.liveTimers.length, 0, reason);
  }
  assert.deepEqual(harness.resolved(), []);
});
