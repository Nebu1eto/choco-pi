/**
 * Background text backend: prefix-only prompts, bounded two-pass,
 * cancellation, typed failures, and draft/details compatibility.
 *
 * The prompt check is independent of the backend's own entry-ID assertion:
 * every retained or later entry carries a unique marker string, and no
 * prompt text may contain one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
  CheckpointDetailsSchema,
  isCandidateRecord,
  type PreparationBudget,
  type PreparedCheckpoint,
  type PrepareFailure,
  type ProviderScope,
} from "../src/background/contract.ts";
import {
  freezeSnapshot,
  isSnapshotRefusal,
  type PrefixSnapshot,
} from "../src/background/snapshot.ts";
import {
  assertPrefixOnlyInput,
  classifySummarizerError,
  createTextBackend,
  PostCutInputError,
  type PromptInput,
  type TextBackendOptions,
  type TextSummarizer,
  type TextSummaryRequest,
  type TextSummaryResponse,
} from "../src/background/text-backend.ts";
import {
  parseLocalCompactionDetails,
  parseTextCheckpointDetails,
  type TextCheckpointDetails,
} from "../src/details.ts";
import {
  buildCandidateRecord,
  buildSnapshot,
  persistedCustomEntry,
  reopenedEntry,
} from "./background-fakes.ts";

const SCOPE: ProviderScope = { provider: "fixture", model: "fixture" };

function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const VALID_SUMMARY = [
  "## Goal",
  "Audit modules",
  "## Constraints & Preferences",
  "- None",
  "## Progress",
  "### Done",
  "- Read files",
  "### In Progress",
  "- Auditing",
  "### Blocked",
  "",
  "## Key Decisions",
  "- None",
  "## Next Steps",
  "1. Continue",
  "## Critical Context",
  "- /f/a",
].join("\n");

type Message = SessionMessageEntry["message"];

/** Linear branch builder; every message carries a unique marker. */
class Branch {
  readonly entries: SessionEntry[] = [];
  private counter = 0;
  marker(prefix: string): string {
    return `${prefix}-${this.counter++}-MARKER`;
  }
  private push(message: Message): string {
    const id = `e${this.entries.length}`;
    this.entries.push({
      type: "message",
      id,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    });
    return id;
  }
  user(text: string): string {
    return this.push({ role: "user", content: text, timestamp: 0 });
  }
  assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
    return this.push({
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture",
      usage: usage(0, 0),
      stopReason,
      timestamp: 0,
    });
  }
  calls(ids: readonly string[], text: string): string {
    return this.assistant(
      [
        { type: "thinking", thinking: text, thinkingSignature: "sig" },
        ...ids.map((id) => ({
          type: "toolCall" as const,
          id,
          name: "edit",
          arguments: { path: `/src/${id}.ts` },
        })),
      ],
      "toolUse",
    );
  }
  result(id: string, text: string): string {
    return this.push({
      role: "toolResult",
      toolCallId: id,
      toolName: "edit",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    });
  }
  compaction(summary: string, firstKeptEntryId: string): string {
    const id = `e${this.entries.length}`;
    this.entries.push({
      type: "compaction",
      id,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary,
      firstKeptEntryId,
      tokensBefore: 0,
      details: { readFiles: ["/carried/read.ts"], modifiedFiles: ["/carried/mod.ts"] },
    });
    return id;
  }
}

interface Transcript {
  readonly branch: Branch;
  readonly snapshot: PrefixSnapshot;
  readonly prefixMarkers: readonly string[];
  readonly postCutMarkers: readonly string[];
}

/** Long single-prompt child: one request, many tool batches, then later entries. */
function childTranscript(batches: number, padding: number, laterBatches = 4): Transcript {
  const branch = new Branch();
  const all: { id: string; marker: string }[] = [];
  const add = (id: string, marker: string) => all.push({ id, marker });
  const request = branch.marker("REQUEST");
  add(branch.user(`${request} audit every module`), request);
  for (let index = 0; index < batches; index++) {
    const think = branch.marker("THINK");
    add(branch.calls([`c${index}a`, `c${index}b`], think), think);
    for (const suffix of ["a", "b"]) {
      const out = branch.marker("OUT");
      add(branch.result(`c${index}${suffix}`, `${out} ${"p".repeat(padding)}`), out);
    }
  }
  const frozen = freezeSnapshot(branch.entries, {
    ownerKey: "child-1",
    ownerGeneration: 1,
    providerScope: SCOPE,
    keepRecentTokens: Math.max(50, padding),
    maxKeepTokens: Math.max(50, padding),
    capturedAt: 0,
  });
  if (isSnapshotRefusal(frozen)) assert.fail(`refused: ${frozen.detail}`);
  // The session keeps working after the freeze: D/E land after the snapshot.
  for (let index = 0; index < laterBatches; index++) {
    const think = branch.marker("LATER");
    add(branch.calls([`l${index}`], think), think);
    const out = branch.marker("LATER");
    add(branch.result(`l${index}`, out), out);
  }
  const prefixIds = new Set(frozen.entries.map((entry) => entry.id));
  return {
    branch,
    snapshot: frozen,
    prefixMarkers: all.filter((item) => prefixIds.has(item.id)).map((item) => item.marker),
    postCutMarkers: all.filter((item) => !prefixIds.has(item.id)).map((item) => item.marker),
  };
}

class FakeSummarizer implements TextSummarizer {
  readonly scope: ProviderScope;
  readonly requests: TextSummaryRequest[] = [];
  responses: ((request: TextSummaryRequest) => TextSummaryResponse | Error)[] = [];
  constructor(scope = SCOPE) {
    this.scope = scope;
  }
  summarize(request: TextSummaryRequest): Promise<TextSummaryResponse> {
    this.requests.push(request);
    const respond = this.responses[this.requests.length - 1];
    const outcome = respond
      ? respond(request)
      : {
          text: VALID_SUMMARY,
          usage: usage(100, 20),
          stopReason: "stop" as const,
          toolCallCount: 0,
        };
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

const BUDGET: PreparationBudget = {
  maxInputTokens: 200_000,
  maxOutputTokens: 2_000,
  maxResultBytes: 1_048_576,
  deadlineMs: Number.MAX_SAFE_INTEGER,
  maxAttempts: 2,
};

function backend(summarizer: TextSummarizer | undefined, extra: Partial<TextBackendOptions> = {}) {
  const inputs: PromptInput[] = [];
  const created = createTextBackend({
    summarize: summarizer,
    budget: { contextWindow: 400_000, maxTokens: 8_000 },
    onPromptInput: (input) => inputs.push(input),
    ...extra,
  });
  return { backend: created, inputs };
}

function prepared(
  result: PreparedCheckpoint<TextCheckpointDetails> | PrepareFailure,
): PreparedCheckpoint<TextCheckpointDetails> {
  if ("ok" in result) assert.fail(`unexpected failure ${result.reason}`);
  return result;
}

function expectPrefixOnlyPrompts(
  inputs: readonly PromptInput[],
  transcript: Transcript,
  requests: readonly TextSummaryRequest[],
): void {
  assert.equal(inputs.length, requests.length);
  for (const request of requests) {
    for (const marker of transcript.postCutMarkers) {
      assert.ok(
        !request.promptText.includes(marker),
        `pass ${request.pass} leaked post-cut ${marker}`,
      );
    }
  }
  // Coverage: every pre-cut message reaches exactly one pass. The governing
  // request of a split turn is restated in every pass by design.
  const governing = transcript.snapshot.governingUserRequest?.content;
  for (const marker of transcript.prefixMarkers) {
    const hits = requests.filter((request) => request.promptText.includes(marker)).length;
    if (governing?.includes(marker)) {
      assert.equal(hits, requests.length, `${marker} must reach every pass`);
    } else {
      assert.equal(hits, 1, `${marker} reached ${hits} passes`);
    }
  }
}

test("single pass reads only the frozen prefix and drafts a validated checkpoint", async () => {
  const transcript = childTranscript(12, 40);
  const before = structuredClone(transcript.branch.entries);
  const summarizer = new FakeSummarizer();
  const { backend: text, inputs } = backend(summarizer);
  assert.deepEqual(text.isLegalCut(transcript.snapshot), { legal: true });
  const result = prepared(
    await text.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: BUDGET,
      candidateId: "cand-1",
    }),
  );
  assert.equal(summarizer.requests.length, 1);
  expectPrefixOnlyPrompts(inputs, transcript, summarizer.requests);
  assert.deepEqual(transcript.branch.entries, before, "history untouched");

  const draft = result.draft;
  assert.equal(draft.firstKeptEntryId, transcript.snapshot.firstKeptEntryId);
  assert.notEqual(draft.firstKeptEntryId, null);
  assert.ok(draft.summary.startsWith("## Goal"));
  assert.ok(draft.summary.includes("## Governing Request (split turn)"));
  assert.ok(draft.summary.includes("REQUEST-0-MARKER audit every module"));
  assert.ok(draft.summary.includes("<modified-files>"));
  assert.equal(result.details, draft.details);
  assert.equal(result.details.candidateId, "cand-1");
  assert.equal(result.details.fingerprint, transcript.snapshot.prefixFingerprint);
  assert.equal(result.details.passes, 1);
  assert.equal(result.details.background.splitTurn, true);
  assert.equal(result.details.evidence.tailEntryIds, null);
  assert.deepEqual(result.usage, {
    input: 100,
    output: 20,
    iterations: [{ input: 100, output: 20 }],
  });
  assert.deepEqual(result.reasonCodes, ["prepared"]);

  const request = summarizer.requests[0];
  assert.ok(request?.systemPrompt.includes("UNTRUSTED DATA"));
  assert.ok(request?.systemPrompt.includes("You have no tools"));
  assert.ok(request?.promptText.includes("<governing-request>"));
});

test("drafts survive the persisted-record schema and existing manual-path readers", async () => {
  const transcript = childTranscript(8, 40);
  const { backend: text } = backend(new FakeSummarizer());
  const result = prepared(
    await text.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: BUDGET,
      candidateId: "cand-2",
    }),
  );
  assert.ok(Value.Check(CheckpointDetailsSchema, result.details));
  const entry = await reopenedEntry((manager) =>
    manager.appendCompaction(
      result.draft.summary,
      transcript.snapshot.firstKeptEntryId,
      0,
      result.details,
    ),
  );
  assert.ok(entry.type === "compaction", "compaction entry survives session reopen");
  assert.ok(parseTextCheckpointDetails(entry));
  assert.ok(parseLocalCompactionDetails(entry), "manual-path reader still accepts the details");

  const base = buildCandidateRecord();
  const record = {
    ...base,
    candidateId: result.candidateId,
    backendId: result.backendId,
    identity: {
      cutEntryId: transcript.snapshot.cutEntryId,
      prefixFingerprint: transcript.snapshot.prefixFingerprint,
      priorCheckpointId: transcript.snapshot.priorCheckpointId,
      priorCheckpointVersion: transcript.snapshot.priorCheckpointVersion,
      ownerKey: transcript.snapshot.ownerKey,
      ownerGeneration: transcript.snapshot.ownerGeneration,
      providerScope: transcript.snapshot.providerScope,
    },
    checkpoint: result,
  };
  assert.ok(
    isCandidateRecord((await persistedCustomEntry(record)).data),
    "prepared checkpoint is persistable as a candidate record",
  );
});

test("bounded two-pass: pass 2 sees only the pass-1 draft and newest pre-cut evidence", async () => {
  const transcript = childTranscript(40, 400);
  const summarizer = new FakeSummarizer();
  const { backend: text, inputs } = backend(summarizer, {
    budget: { contextWindow: 9_000, maxTokens: 1_000 },
  });
  const pass1Draft = VALID_SUMMARY.replace("Audit modules", "PASS-ONE-DRAFT");
  summarizer.responses = [
    () => ({ text: pass1Draft, usage: usage(300, 30), stopReason: "stop", toolCallCount: 0 }),
  ];
  const result = prepared(
    await text.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: { ...BUDGET, maxOutputTokens: 1_000 },
      candidateId: "cand-3",
    }),
  );
  assert.equal(summarizer.requests.length, 2);
  expectPrefixOnlyPrompts(inputs, transcript, summarizer.requests);
  const second = summarizer.requests[1];
  assert.ok(second?.promptText.includes("PASS-ONE-DRAFT"));
  assert.ok(second?.promptText.includes("<pre-cut-evidence>"));
  assert.ok(!second?.promptText.includes("<conversation>"));
  assert.equal(result.details.passes, 2);
  assert.ok(result.details.background.evidenceEntryIds);
  assert.equal(result.usage.iterations?.length, 2);
  assert.equal(result.usage.input, 400);
});

test("cancellation between passes stops before pass 2 and leaves history intact", async () => {
  const transcript = childTranscript(40, 400);
  const before = structuredClone(transcript.branch.entries);
  const controller = new AbortController();
  const summarizer = new FakeSummarizer();
  summarizer.responses = [
    () => {
      controller.abort();
      return { text: VALID_SUMMARY, usage: usage(1, 1), stopReason: "stop", toolCallCount: 0 };
    },
  ];
  const { backend: text } = backend(summarizer, {
    budget: { contextWindow: 9_000, maxTokens: 1_000 },
  });
  const result = await text.prepare(transcript.snapshot, {
    signal: controller.signal,
    budget: { ...BUDGET, maxOutputTokens: 1_000 },
    candidateId: "cand-4",
  });
  assert.deepEqual(result, { ok: false, reason: "canceled", retryable: false });
  assert.equal(summarizer.requests.length, 1);
  assert.equal(summarizer.requests[0]?.signal.aborted, true, "in-flight signal follows the caller");
  assert.deepEqual(transcript.branch.entries, before);

  const aborted = new AbortController();
  aborted.abort();
  const early = await text.prepare(transcript.snapshot, {
    signal: aborted.signal,
    budget: BUDGET,
    candidateId: "cand-5",
  });
  assert.deepEqual(early, { ok: false, reason: "canceled", retryable: false });
  assert.equal(summarizer.requests.length, 1, "pre-aborted preparation issues no call");
});

test("deadline and oversized input fail before any call", async () => {
  const transcript = childTranscript(40, 400);
  const summarizer = new FakeSummarizer();
  const { backend: late } = backend(summarizer, { now: () => 1_000 });
  assert.deepEqual(
    await late.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: { ...BUDGET, deadlineMs: 1_000 },
      candidateId: "late",
    }),
    { ok: false, reason: "timeout", retryable: true },
  );
  const { backend: tiny } = backend(summarizer, {
    budget: { contextWindow: 2_500, maxTokens: 1_000 },
  });
  assert.deepEqual(
    await tiny.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: { ...BUDGET, maxOutputTokens: 1_000 },
      candidateId: "tiny",
    }),
    { ok: false, reason: "oversized", retryable: false },
  );
  assert.equal(summarizer.requests.length, 0);
});

test("oversized, malformed, empty, truncated, and tool-calling results fail typed", async () => {
  const transcript = childTranscript(10, 40);
  const cases: { name: string; response: TextSummaryResponse | Error; expected: PrepareFailure }[] =
    [
      {
        name: "oversized",
        response: {
          text: `${VALID_SUMMARY}\n${"z".repeat(5_000)}`,
          usage: usage(1, 1),
          stopReason: "stop",
          toolCallCount: 0,
        },
        expected: { ok: false, reason: "oversized", retryable: false },
      },
      {
        name: "missing headings",
        response: { text: "just prose", usage: usage(1, 1), stopReason: "stop", toolCallCount: 0 },
        expected: { ok: false, reason: "malformed", retryable: true },
      },
      {
        name: "empty",
        response: { text: "   ", usage: usage(1, 1), stopReason: "stop", toolCallCount: 0 },
        expected: { ok: false, reason: "malformed", retryable: true },
      },
      {
        name: "length stop",
        response: {
          text: VALID_SUMMARY,
          usage: usage(1, 1),
          stopReason: "length",
          toolCallCount: 0,
        },
        expected: { ok: false, reason: "oversized", retryable: false },
      },
      {
        name: "tool call",
        response: { text: VALID_SUMMARY, usage: usage(1, 1), stopReason: "stop", toolCallCount: 1 },
        expected: { ok: false, reason: "malformed", retryable: true },
      },
      {
        name: "negative usage",
        response: {
          text: VALID_SUMMARY,
          usage: usage(-1, 1),
          stopReason: "stop",
          toolCallCount: 0,
        },
        expected: { ok: false, reason: "malformed", retryable: true },
      },
      {
        name: "rate limited",
        response: new Error("429 Too Many Requests"),
        expected: { ok: false, reason: "429", retryable: true },
      },
    ];
  for (const item of cases) {
    const before = structuredClone(transcript.branch.entries);
    const summarizer = new FakeSummarizer();
    summarizer.responses = [() => item.response];
    const { backend: text } = backend(summarizer);
    const result = await text.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: { ...BUDGET, maxResultBytes: 4_000 },
      candidateId: item.name,
    });
    assert.deepEqual(result, item.expected, item.name);
    assert.deepEqual(transcript.branch.entries, before, `${item.name}: history untouched`);
  }
});

test("capability never routes to another provider", async () => {
  const { backend: none } = backend(undefined);
  assert.deepEqual(await none.capability(SCOPE), { supported: false, reason: "unsupported" });
  const other = new FakeSummarizer({ provider: "other", model: "fixture" });
  const { backend: foreign } = backend(other);
  assert.deepEqual(await foreign.capability(SCOPE), { supported: false, reason: "incompatible" });
  const transcript = childTranscript(8, 40);
  assert.deepEqual(
    await foreign.prepare(transcript.snapshot, {
      signal: new AbortController().signal,
      budget: BUDGET,
      candidateId: "foreign",
    }),
    { ok: false, reason: "incompatible", retryable: false },
  );
  assert.equal(other.requests.length, 0);
  const endpoint = new FakeSummarizer({
    provider: "fixture",
    model: "fixture",
    baseUrl: "https://a.example",
  });
  const { backend: moved } = backend(endpoint);
  assert.deepEqual(await moved.capability({ ...SCOPE, baseUrl: "https://b.example" }), {
    supported: false,
    reason: "incompatible",
  });
  const { backend: same } = backend(new FakeSummarizer());
  assert.deepEqual(await same.capability(SCOPE), { supported: true });
});

test("prior checkpoint semantics: previous summary and carried file lists", async () => {
  const branch = new Branch();
  branch.user("old");
  branch.assistant([{ type: "text", text: "o".repeat(400) }], "stop");
  const kept = branch.user("kept request");
  branch.assistant([{ type: "text", text: "k".repeat(400) }], "stop");
  const prior = branch.compaction("PRIOR-CHECKPOINT-SUMMARY", kept);
  branch.user("new request");
  branch.calls(["n1"], "reasoning");
  branch.result("n1", "n".repeat(2000));
  branch.assistant([{ type: "text", text: "done" }], "stop");
  branch.user("latest");
  branch.assistant([{ type: "text", text: "l".repeat(400) }], "stop");
  const frozen = freezeSnapshot(branch.entries, {
    ownerKey: "main",
    ownerGeneration: 1,
    providerScope: SCOPE,
    keepRecentTokens: 100,
    capturedAt: 0,
  });
  if (isSnapshotRefusal(frozen)) assert.fail(frozen.detail);
  assert.equal(frozen.priorCheckpointId, prior);
  const summarizer = new FakeSummarizer();
  const { backend: text } = backend(summarizer);
  const result = prepared(
    await text.prepare(frozen, {
      signal: new AbortController().signal,
      budget: BUDGET,
      candidateId: "cand-prior",
    }),
  );
  const prompt = summarizer.requests[0]?.promptText ?? "";
  assert.ok(prompt.includes('<previous-summary historical="true">\nPRIOR-CHECKPOINT-SUMMARY'));
  assert.ok(prompt.includes("kept request"), "prior checkpoint's retained range is summarized");
  assert.ok(!prompt.includes("o".repeat(400)), "already-summarized entries are not re-read");
  assert.equal(result.details.evidence.previousCheckpointId, prior);
  assert.equal(result.details.background.priorCheckpointVersion, 1);
  assert.ok(result.details.readFiles.includes("/carried/read.ts"));
  assert.ok(result.details.modifiedFiles.includes("/carried/mod.ts"));
  assert.ok(result.details.modifiedFiles.includes("/src/n1.ts"));
});

test("prompt-input assertion rejects any post-cut entry", () => {
  const transcript = childTranscript(6, 40);
  const prefixId = transcript.snapshot.cutEntryId;
  const input = (entryIds: readonly string[]): PromptInput => ({
    pass: 1,
    entryIds,
    systemPrompt: "",
    promptText: "",
  });
  assert.doesNotThrow(() => assertPrefixOnlyInput(transcript.snapshot, input([prefixId])));
  assert.throws(
    () => assertPrefixOnlyInput(transcript.snapshot, input([transcript.snapshot.firstKeptEntryId])),
    PostCutInputError,
  );
  const later = transcript.branch.entries.at(-1)?.id ?? "";
  assert.throws(
    () => assertPrefixOnlyInput(transcript.snapshot, input([later])),
    PostCutInputError,
  );
});

test("snapshots without a first retained entry are refused, not repaired", async () => {
  const summarizer = new FakeSummarizer();
  const { backend: text } = backend(summarizer);
  const foreign = buildSnapshot({ providerScope: SCOPE });
  assert.equal(text.isLegalCut(foreign).legal, false);
  const result = await text.prepare(foreign, {
    signal: new AbortController().signal,
    budget: BUDGET,
    candidateId: "foreign-snapshot",
  });
  assert.ok("ok" in result && result.ok === false);
  assert.equal(summarizer.requests.length, 0);
});

test("error classification covers provider failure classes", () => {
  assert.equal(classifySummarizerError(new Error("529 overloaded_error")).reason, "529");
  assert.equal(classifySummarizerError(new Error("401 Unauthorized")).reason, "auth");
  assert.equal(classifySummarizerError(new Error("insufficient quota")).reason, "quota");
  assert.equal(classifySummarizerError(new Error("request timed out")).reason, "timeout");
  assert.equal(
    classifySummarizerError(
      new Error("Summarization failed: generation hit the token cap and the summary is incomplete"),
    ).reason,
    "oversized",
  );
  assert.deepEqual(classifySummarizerError(new Error("socket hang up")), {
    ok: false,
    reason: "malformed",
    retryable: true,
  });
});
