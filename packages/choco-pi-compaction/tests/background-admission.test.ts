/**
 * Background compaction admission on large-window models.
 *
 * Covers the effective input budget, the rendered-prompt estimate and its
 * usage calibration, oversized details, cooldown reporting, the reasoning
 * output reserve, and the provider token-counter override.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { REASONING_SUMMARY_OUTPUT_TOKENS, type ModelBudget } from "../src/budget.ts";
import {
  type BackgroundCompactionSettings,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
  type ModelRef,
  type ProviderScope,
  type TokenCounter,
} from "../src/background/contract.ts";
import { type CoordinatorPort, createCoordinator } from "../src/background/coordinator.ts";
import type { SchedulerClock } from "../src/background/scheduler.ts";
import {
  freezeSnapshot,
  isSnapshotRefusal,
  type PrefixSnapshot,
  renderFrozenPrefixPrompt,
} from "../src/background/snapshot.ts";
import {
  classifySummarizerError,
  createTextBackend,
  type TextSummarizer,
  type TextSummaryRequest,
} from "../src/background/text-backend.ts";
import {
  estimatePromptTokens,
  MAX_TOKENS_PER_CHAR,
  MIN_TOKENS_PER_CHAR,
  usageCalibration,
} from "../src/background/token-estimate.ts";
import { SUMMARY_SECTION_HEADINGS } from "../src/prompt.ts";
import { runSummaryCall, SummaryTruncatedError } from "../src/summarize.ts";
import { FakeBackend, fakeAppendRecordSink } from "./background-fakes.ts";

class Clock implements SchedulerClock {
  time = 0;
  now(): number {
    return this.time;
  }
  setTimer(): () => void {
    return () => {};
  }
}

const SCOPE: ProviderScope = { provider: "fixture", model: "fixture" };
const GLM_WINDOW = 524_288;
const VALID_SUMMARY = SUMMARY_SECTION_HEADINGS.map((heading) => `${heading}\nnone`).join("\n");

function usage(input: number): Usage {
  return {
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  promptTokens = 0,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fixture",
    model: "fixture",
    usage: usage(promptTokens),
    stopReason,
    timestamp: 0,
  };
}

/** Branch builder that chains parent IDs. */
class Branch {
  readonly entries: SessionEntry[] = [];

  add(message: Extract<SessionEntry, { type: "message" }>["message"]): string {
    const id = `entry-${this.entries.length}`;
    this.entries.push({
      type: "message",
      id,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    });
    return id;
  }

  contextEdit(targetId: string): void {
    this.entries.push({
      type: "context_edit",
      id: `entry-${this.entries.length}`,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      targetId,
      replacement: null,
    });
  }
}

/**
 * One user turn of `calls` tool calls with untruncated `resultChars` results,
 * a final reply, and a next user message that stays retained.
 */
function largeToolBranch(calls: number, resultChars: number, finalPromptTokens = 0): Branch {
  const branch = new Branch();
  branch.add({ role: "user", content: "Audit every module", timestamp: 0 });
  for (let index = 0; index < calls; index++) {
    const id = `call-${index}`;
    branch.add(
      assistant(
        [{ type: "toolCall", id, name: "read", arguments: { path: `src/m${index}.ts` } }],
        "toolUse",
      ),
    );
    branch.add({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: `${index}:`.padEnd(resultChars, "x") }],
      isError: false,
      timestamp: 0,
    });
  }
  branch.add(assistant([{ type: "text", text: "Audit done." }], "stop", finalPromptTokens));
  branch.add({ role: "user", content: "Next request", timestamp: 0 });
  return branch;
}

function freeze(entries: readonly SessionEntry[]): PrefixSnapshot {
  const snapshot = freezeSnapshot(entries, {
    ownerKey: "admission",
    ownerGeneration: 1,
    providerScope: SCOPE,
    keepRecentTokens: 0,
    capturedAt: 0,
  });
  assert.ok(!isSnapshotRefusal(snapshot), "a legal cut is frozen");
  return snapshot;
}

const FIXTURE_MODEL: Model<"anthropic-messages"> = {
  id: "fixture",
  name: "Fixture",
  api: "anthropic-messages",
  provider: "fixture",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: GLM_WINDOW,
  maxTokens: 65_536,
};

interface AdmissionFixtureOptions {
  readonly modelBudget?: ModelBudget;
  readonly settings?: Partial<BackgroundCompactionSettings>;
  readonly tokenCounter?: { readonly counter: TokenCounter; readonly model: ModelRef };
}

/** Coordinator over a real frozen snapshot of `entries`, with production admission. */
function admissionFixture(entries: readonly SessionEntry[], options: AdmissionFixtureOptions) {
  const backend = new FakeBackend();
  const sink = fakeAppendRecordSink();
  const port: CoordinatorPort = {
    getBranch: () => entries,
    getBranchKey: () => "branch",
    getProviderScope: () => SCOPE,
    getLatestCompactionEntry: () => null,
    appendAnchor: () => "anchor",
    proposeDraft: () => {},
    findCommittedCandidate: () => undefined,
  };
  let next = 0;
  const coordinator = createCoordinator({
    ownerKey: "admission",
    ownerGeneration: 1,
    isOwnerCurrent: () => true,
    isBackendEnabled: () => true,
    port,
    backends: new Map([[backend.id, backend]]),
    appendRecord: sink.appendRecord,
    settings: {
      ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
      enabled: true,
      text: true,
      ...options.settings,
    },
    clock: new Clock(),
    createCandidateId: () => `candidate-${++next}`,
    modelBudget: options.modelBudget,
    tokenCounter: options.tokenCounter,
    freezeSnapshot(context) {
      const selected = freezeSnapshot(context.entries, {
        ownerKey: context.ownerKey,
        ownerGeneration: context.ownerGeneration,
        providerScope: context.providerScope,
        capturedAt: context.capturedAt,
        keepRecentTokens: 0,
      });
      return isSnapshotRefusal(selected) ? { refused: true, detail: selected.detail } : selected;
    },
  });
  return { coordinator, backend, sink };
}

async function prepareOnce(f: ReturnType<typeof admissionFixture>): Promise<void> {
  assert.equal((await f.coordinator.requestPreparation()).accepted, true);
  await f.coordinator.waitForPreparation();
}

const GLM_BUDGET: ModelBudget = { contextWindow: GLM_WINDOW, maxTokens: 65_536, reasoning: true };

// ---------------------------------------------------------------------------
// A1: large-window admission with default settings
// ---------------------------------------------------------------------------

test("A1: a 524288-window prefix over the old 200k raw estimate is admitted with default settings", async () => {
  // 120 untruncated 20k-char tool results: ~600k raw tokens, ~60k rendered.
  const branch = largeToolBranch(120, 20_000);
  const snapshot = freeze(branch.entries);
  assert.ok(snapshot.tokenEstimate > 515_000, "raw estimate exceeds even the window budget");
  assert.ok(snapshot.promptTokenEstimate < snapshot.tokenEstimate / 4, "rendered prompt truncates");

  const f = admissionFixture(branch.entries, { modelBudget: GLM_BUDGET });
  await prepareOnce(f);
  const status = f.coordinator.status();
  assert.equal(status.state, "ready", `${status.reason}: ${status.detail}`);
  const budget = GLM_WINDOW - REASONING_SUMMARY_OUTPUT_TOKENS - 512;
  assert.equal(f.backend.calls[0]?.budget.maxInputTokens, budget);
  assert.equal(status.admission?.budget, budget);
  assert.equal(status.admission?.source, "chars");
  assert.equal(status.admission?.promptTokens, snapshot.promptTokenEstimate);
  const record = f.sink.records[0];
  assert.deepEqual(record?.admission, {
    promptTokens: snapshot.promptTokenEstimate,
    budget,
    source: "chars",
    ratio: 0.25,
  });
});

// ---------------------------------------------------------------------------
// A2: oversized admission carries a detail and never cools the scope
// ---------------------------------------------------------------------------

test("A2: an admission refusal names prompt and budget and an immediate retry is not quota", async () => {
  const branch = largeToolBranch(120, 20_000);
  const f = admissionFixture(branch.entries, {
    modelBudget: { contextWindow: 32_000, maxTokens: 8_192 },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await prepareOnce(f);
    const status = f.coordinator.status();
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "oversized", `attempt ${attempt} must not report quota/cooling`);
    assert.match(status.detail ?? "", /^prompt \d+ > budget 23296 \(chars\)$/);
  }
  assert.equal(f.backend.calls.length, 0, "no paid call for an oversized prefix");
});

test("A2: every cooled refusal reports cooling with the remaining seconds, not quota", async () => {
  const branch = largeToolBranch(2, 100);
  const f = admissionFixture(branch.entries, { modelBudget: GLM_BUDGET });
  f.backend.result = { ok: false, reason: "auth", retryable: false };
  await prepareOnce(f);
  assert.equal(f.coordinator.status().reason, "auth");
  await prepareOnce(f);
  const status = f.coordinator.status();
  assert.equal(status.reason, "cooling");
  assert.equal(status.detail, "cooling-down 60s");
  assert.equal(f.backend.calls.length, 1);
});

test("A2: every text-backend oversized failure carries a detail code", async () => {
  const branch = largeToolBranch(40, 400);
  const snapshot = freeze(branch.entries);
  const run = async (
    budget: ModelBudget,
    respond: (request: TextSummaryRequest) => {
      text: string;
      stopReason: "stop" | "length";
    },
    maxResultBytes = 1_048_576,
  ) => {
    const summarizer: TextSummarizer = {
      scope: SCOPE,
      summarize: (request) =>
        Promise.resolve({ ...respond(request), usage: usage(10), toolCallCount: 0 }),
    };
    const backend = createTextBackend({ summarize: summarizer, budget });
    return backend.prepare(snapshot, {
      signal: new AbortController().signal,
      candidateId: "c",
      budget: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000,
        maxResultBytes,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        maxAttempts: 1,
      },
    });
  };
  const ok = () => ({ text: VALID_SUMMARY, stopReason: "stop" as const });
  const cases = [
    { detail: "prefix-over-budget", result: await run({ contextWindow: 1_200, maxTokens: 0 }, ok) },
    { detail: "no-pass-plan", result: await run({ contextWindow: 2_500, maxTokens: 0 }, ok) },
    {
      detail: "summary-truncated",
      result: await run(GLM_BUDGET, () => ({ text: VALID_SUMMARY, stopReason: "length" })),
    },
    { detail: "result-bytes", result: await run(GLM_BUDGET, ok, 64) },
  ];
  for (const { detail, result } of cases) {
    assert.ok("ok" in result, `${detail}: expected a failure`);
    assert.deepEqual(result, { ok: false, reason: "oversized", retryable: false, detail });
  }
});

// ---------------------------------------------------------------------------
// A3: usage calibration
// ---------------------------------------------------------------------------

function calibrationBranch(promptTokens: number) {
  const branch = new Branch();
  branch.add({ role: "user", content: "a".repeat(4_000), timestamp: 0 });
  const replyId = branch.add(assistant([{ type: "text", text: "ok" }], "stop", promptTokens));
  return { branch, replyId };
}

function rangeOf(entries: readonly SessionEntry[]) {
  return entries.flatMap((entry) =>
    entry.type === "message" ? [{ entryId: entry.id, message: entry.message }] : [],
  );
}

test("A3: the ratio is prompt tokens over the characters sent before the reply", () => {
  const { branch } = calibrationBranch(1_500);
  const ratio = usageCalibration({
    entries: branch.entries,
    range: rangeOf(branch.entries),
    baseChars: 0,
  });
  assert.equal(ratio, 1_500 / 4_000);
  assert.equal(
    usageCalibration({
      entries: branch.entries,
      range: rangeOf(branch.entries),
      baseChars: 2_000,
    }),
    1_500 / 6_000,
    "the checkpoint summary counts as sent characters",
  );
});

test("A3: the ratio is clamped to [1/6, 1/2]", () => {
  for (const [tokens, expected] of [
    [10_000, MAX_TOKENS_PER_CHAR],
    [100, MIN_TOKENS_PER_CHAR],
  ] as const) {
    const { branch } = calibrationBranch(tokens);
    assert.equal(
      usageCalibration({ entries: branch.entries, range: rangeOf(branch.entries), baseChars: 0 }),
      expected,
    );
  }
  assert.equal(MIN_TOKENS_PER_CHAR, 1 / 6);
  assert.equal(MAX_TOKENS_PER_CHAR, 1 / 2);
});

test("A3: usage before a later context edit or compaction is invalid", () => {
  const { branch, replyId } = calibrationBranch(1_500);
  branch.contextEdit(replyId);
  assert.equal(
    usageCalibration({ entries: branch.entries, range: rangeOf(branch.entries), baseChars: 0 }),
    undefined,
  );
  const compacted = calibrationBranch(1_500).branch;
  compacted.entries.push({
    type: "compaction",
    id: "checkpoint",
    parentId: compacted.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "summary",
    firstKeptEntryId: "entry-1",
    tokensBefore: 1,
  });
  assert.equal(
    usageCalibration({
      entries: compacted.entries,
      range: rangeOf(compacted.entries),
      baseChars: 0,
    }),
    undefined,
  );
});

test("A3: aborted, errored, and zero usage is skipped for the last valid usage", () => {
  const { branch } = calibrationBranch(1_500);
  branch.add({ role: "user", content: "b".repeat(4_000), timestamp: 0 });
  branch.add(assistant([{ type: "text", text: "" }], "error", 9_000));
  branch.add(assistant([{ type: "text", text: "" }], "aborted", 9_000));
  branch.add(assistant([{ type: "text", text: "zero" }], "stop", 0));
  assert.equal(
    usageCalibration({ entries: branch.entries, range: rangeOf(branch.entries), baseChars: 0 }),
    1_500 / 4_000,
  );
});

test("A3: without usage the estimate falls back to chars/4", () => {
  const branch = new Branch();
  branch.add({ role: "user", content: "hello", timestamp: 0 });
  assert.equal(
    usageCalibration({ entries: branch.entries, range: rangeOf(branch.entries), baseChars: 0 }),
    undefined,
  );
  assert.deepEqual(estimatePromptTokens(1_001, undefined), {
    tokens: 251,
    source: "chars",
    ratio: 0.25,
  });
});

test("A3: a frozen snapshot applies the calibrated ratio to the rendered prompt", () => {
  // The final reply measured 300k prompt tokens over ~2.4M raw chars: ratio 0.125 -> clamped 1/6.
  const calibrated = freeze(largeToolBranch(120, 20_000, 300_000).entries);
  assert.equal(calibrated.estimateSource, "usage-calibrated");
  assert.equal(calibrated.estimateRatio, MIN_TOKENS_PER_CHAR);
  const prompt = renderFrozenPrefixPrompt(calibrated);
  assert.equal(
    calibrated.promptTokenEstimate,
    Math.ceil((prompt.system.length + prompt.promptText.length) * MIN_TOKENS_PER_CHAR),
  );
  const measured = freeze(largeToolBranch(120, 20_000, 900_000).entries);
  assert.ok(measured.estimateRatio > MIN_TOKENS_PER_CHAR && measured.estimateRatio < 0.5);
  const unmeasured = freeze(largeToolBranch(120, 20_000).entries);
  assert.equal(unmeasured.estimateSource, "chars");
  assert.ok(measured.promptTokenEstimate > unmeasured.promptTokenEstimate);
});

// ---------------------------------------------------------------------------
// A4: summary truncation and reasoning output headroom
// ---------------------------------------------------------------------------

test("A4: a reasoning model's summary cap rises to the reasoning cap, bounded by the model cap", async () => {
  const snapshot = freeze(largeToolBranch(4, 200).entries);
  const caps = async (budget: ModelBudget): Promise<number | undefined> => {
    const requests: TextSummaryRequest[] = [];
    const backend = createTextBackend({
      summarize: {
        scope: SCOPE,
        summarize: (request) => {
          requests.push(request);
          return Promise.resolve({
            text: VALID_SUMMARY,
            usage: usage(10),
            stopReason: "stop",
            toolCallCount: 0,
          });
        },
      },
      budget,
    });
    const result = await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      candidateId: "c",
      budget: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8_192,
        maxResultBytes: 1_048_576,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        maxAttempts: 1,
      },
    });
    assert.ok(!("ok" in result));
    return requests[0]?.maxTokens;
  };
  assert.equal(REASONING_SUMMARY_OUTPUT_TOKENS, 32_768);
  assert.equal(await caps(GLM_BUDGET), 32_768);
  assert.equal(await caps({ ...GLM_BUDGET, maxTokens: 10_000 }), 10_000);
  assert.equal(await caps({ ...GLM_BUDGET, reasoning: false }), 8_192);
});

test("A4: a length stop from the provider is oversized with summary-truncated", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  const model = FIXTURE_MODEL;
  let sentMaxTokens: number | undefined;
  runtime.registerProvider("fixture", {
    api: "anthropic-messages",
    apiKey: "fixture-key",
    models: [model],
    streamSimple: (_model, _context, options): AssistantMessageEventStream => {
      sentMaxTokens = options?.maxTokens;
      const stream = createAssistantMessageEventStream();
      const message = assistant([{ type: "text", text: "## Goal\npartial" }], "length", 10);
      queueMicrotask(() => stream.push({ type: "done", reason: "length", message }));
      return stream;
    },
  });
  const error = await runSummaryCall({
    modelRegistry: new ModelRegistry(runtime),
    model,
    systemPrompt: "system",
    promptText: "prompt",
    maxTokens: 14_745,
    signal: new AbortController().signal,
    thinkingLevel: "high",
    retry: undefined,
    label: "Background summarization",
  }).then(
    () => assert.fail("a length stop must reject"),
    (cause: unknown) => cause,
  );
  assert.equal(sentMaxTokens, 14_745);
  assert.ok(error instanceof SummaryTruncatedError);
  assert.deepEqual(classifySummarizerError(error), {
    ok: false,
    reason: "oversized",
    retryable: false,
    detail: "summary-truncated",
  });
});

// ---------------------------------------------------------------------------
// Token counter contract: override and fallback
// ---------------------------------------------------------------------------

class FakeCounter implements TokenCounter {
  readonly inputs: Parameters<TokenCounter["countTokens"]>[0][] = [];
  private readonly count: number | undefined;
  constructor(count: number | undefined) {
    this.count = count;
  }
  countTokens(input: Parameters<TokenCounter["countTokens"]>[0]): Promise<number | undefined> {
    this.inputs.push(input);
    return Promise.resolve(this.count);
  }
}

test("a provider count overrides the estimate in both directions", async () => {
  const branch = largeToolBranch(120, 20_000);
  const small = { contextWindow: 32_000, maxTokens: 8_192 };
  const admits = new FakeCounter(1_000);
  const admitted = admissionFixture(branch.entries, {
    modelBudget: small,
    tokenCounter: { counter: admits, model: FIXTURE_MODEL },
  });
  await prepareOnce(admitted);
  assert.equal(admitted.coordinator.status().state, "ready");
  assert.deepEqual(admitted.sink.records[0]?.admission, {
    promptTokens: 1_000,
    budget: 23_296,
    source: "counted",
  });
  const sent = admits.inputs[0];
  assert.ok(sent);
  assert.equal(sent.model, FIXTURE_MODEL);
  const snapshot = freeze(branch.entries);
  assert.deepEqual(
    { system: sent.system, promptText: sent.promptText },
    renderFrozenPrefixPrompt(snapshot),
  );

  const refuses = admissionFixture(largeToolBranch(2, 100).entries, {
    modelBudget: small,
    tokenCounter: { counter: new FakeCounter(50_000), model: FIXTURE_MODEL },
  });
  await prepareOnce(refuses);
  assert.equal(refuses.coordinator.status().reason, "oversized");
  assert.equal(refuses.coordinator.status().detail, "prompt 50000 > budget 23296 (counted)");
});

test("an undefined count falls back to the estimate; the setting disables counting", async () => {
  const branch = largeToolBranch(120, 20_000);
  const small = { contextWindow: 32_000, maxTokens: 8_192 };
  const fallback = admissionFixture(branch.entries, {
    modelBudget: small,
    tokenCounter: { counter: new FakeCounter(undefined), model: FIXTURE_MODEL },
  });
  await prepareOnce(fallback);
  assert.match(fallback.coordinator.status().detail ?? "", /\(chars\)$/);

  const disabledCounter = new FakeCounter(1_000);
  const disabled = admissionFixture(branch.entries, {
    modelBudget: small,
    settings: { countTokens: false },
    tokenCounter: { counter: disabledCounter, model: FIXTURE_MODEL },
  });
  await prepareOnce(disabled);
  assert.equal(disabled.coordinator.status().reason, "oversized");
  assert.equal(disabledCounter.inputs.length, 0);
});

test("a counter diagnostic is recorded on admission and named in an oversized refusal", async () => {
  const noting: TokenCounter = {
    countTokens: (input) => {
      input.onDiagnostic?.("count-tokens: http 500");
      return Promise.resolve(undefined);
    },
  };
  const branch = largeToolBranch(120, 20_000);
  const admitted = admissionFixture(branch.entries, {
    modelBudget: GLM_BUDGET,
    tokenCounter: { counter: noting, model: FIXTURE_MODEL },
  });
  await prepareOnce(admitted);
  assert.equal(admitted.coordinator.status().state, "ready");
  assert.equal(admitted.sink.records[0]?.admission?.detail, "count-tokens: http 500");
  assert.equal(admitted.sink.records[0]?.admission?.source, "chars");

  const refused = admissionFixture(branch.entries, {
    modelBudget: { contextWindow: 32_000, maxTokens: 8_192 },
    tokenCounter: { counter: noting, model: FIXTURE_MODEL },
  });
  await prepareOnce(refused);
  assert.equal(refused.coordinator.status().reason, "oversized");
  assert.match(refused.coordinator.status().detail ?? "", /\(chars; count-tokens: http 500\)$/);

  const counted: TokenCounter = {
    countTokens: (input) => {
      input.onDiagnostic?.("count-tokens: ignored");
      return Promise.resolve(1_000);
    },
  };
  const ok = admissionFixture(branch.entries, {
    modelBudget: GLM_BUDGET,
    tokenCounter: { counter: counted, model: FIXTURE_MODEL },
  });
  await prepareOnce(ok);
  assert.equal(
    ok.sink.records[0]?.admission?.detail,
    undefined,
    "a count carries no fallback note",
  );
});
