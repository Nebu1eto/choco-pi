/**
 * Provider-neutral text backend for background compaction.
 *
 * It summarizes only the frozen prefix `A..C` of a {@link PrefixSnapshot} and
 * returns a draft whose `firstKeptEntryId` is the first retained entry, so the
 * retained suffix `D/E` stays verbatim. It never sees a retained or later
 * entry: every prompt is built from `snapshot.entries`, and each pass's input
 * entry IDs are asserted against the prefix before the call is made.
 *
 * Preparation never touches session history. Every failure is a typed
 * {@link PrepareFailure}; a draft is returned only after its structure,
 * metadata, and size were validated.
 */
import type { RetryPolicy, StopReason, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { type ModelBudget, RESPONSE_MARGIN_TOKENS } from "../budget.ts";
import {
  parseCarriedFileLists,
  type TextCheckpointDetails,
  validTextCheckpointDetails,
} from "../details.ts";
import { formatFileLists, resolveFileLists } from "../file-ops.ts";
import { normalizeSummary } from "../normalize.ts";
import {
  BACKGROUND_COMPACTION_SYSTEM_PROMPT,
  buildFrozenPrefixPrompt,
  buildFrozenPrefixReconciliationPrompt,
  SUMMARY_SECTION_HEADINGS,
} from "../prompt.ts";
import { estimateTextTokens, serializeMessages } from "../serialize.ts";
import { CompactionAbortedError, runSummaryCall, type SessionThinkingLevel } from "../summarize.ts";
import type { CompactionMessage, EntryIdRange } from "../types.ts";
import { combineUsage } from "../usage.ts";
import type {
  Backend,
  BackgroundUsage,
  CapabilityVerdict,
  FailureReason,
  FrozenSnapshot,
  LegalityVerdict,
  PreparationBudget,
  PreparedCheckpoint,
  PrepareFailure,
  ProviderScope,
} from "./contract.ts";
import {
  type CappedGoverningContent,
  capGoverningContent,
  checkSnapshotLegality,
  collectPrefixEvidence,
  type PrefixEvidence,
  readFirstKeptEntryId,
  type TaggedMessage,
} from "./snapshot.ts";

export const TEXT_BACKEND_ID = "text";

/** Largest delay `setTimeout` honors; longer deadlines are checked by clock only. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One summarization call issued by the backend. */
export interface TextSummaryRequest {
  readonly pass: 1 | 2;
  readonly label: string;
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

/** Raw outcome of one call; the backend validates it before use. */
export interface TextSummaryResponse {
  readonly text: string;
  readonly usage: Usage;
  readonly stopReason: StopReason;
  readonly toolCallCount: number;
}

/** A summarizer bound to one provider; it must never route elsewhere. */
export interface TextSummarizer {
  readonly scope: ProviderScope;
  summarize(request: TextSummaryRequest): Promise<TextSummaryResponse>;
}

/** Exactly what one pass is about to send, for the prefix-only assertion. */
export interface PromptInput {
  readonly pass: 1 | 2;
  /** Entry IDs whose messages are serialized into `promptText`. */
  readonly entryIds: readonly string[];
  readonly systemPrompt: string;
  readonly promptText: string;
}

/** Observer called with each pass's input after the prefix assertion passed. */
type PromptInputHook = (input: PromptInput) => void;

export interface TextBackendOptions {
  /** Summarizer for the session's own provider, or undefined when none is configured. */
  readonly summarize: TextSummarizer | undefined;
  /** Context window and output cap of the summarizer model. */
  readonly budget: ModelBudget;
  readonly id?: string;
  /** Clock for the absolute preparation deadline; defaults to `Date.now`. */
  readonly now?: () => number;
  readonly onPromptInput?: PromptInputHook;
}

/** Raised when a pass would read an entry outside the frozen prefix. */
export class PostCutInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostCutInputError";
  }
}

/**
 * Throw unless every entry feeding a pass belongs to the frozen prefix.
 *
 * The first retained entry is checked explicitly: it is the boundary most
 * likely to leak through an off-by-one.
 */
export function assertPrefixOnlyInput(snapshot: FrozenSnapshot, input: PromptInput): void {
  const prefixIds = new Set(snapshot.entries.map((entry) => entry.id));
  const firstKept = readFirstKeptEntryId(snapshot);
  for (const entryId of input.entryIds) {
    if (!prefixIds.has(entryId) || entryId === firstKept) {
      throw new PostCutInputError(
        `pass ${input.pass} would read entry ${entryId}, which is not in the frozen prefix`,
      );
    }
  }
}

function failure(reason: FailureReason, retryable: boolean): PrepareFailure {
  return { ok: false, reason, retryable };
}

/** Two optional scope fields conflict only when both are named and differ. */
function conflicting(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

/**
 * Compatible, not equal: the provider must match, while baseUrl, authMode, and
 * accountScope only must not conflict where both sides name them; model is not compared.
 */
function summarizerScopeCompatible(summarizer: ProviderScope, session: ProviderScope): boolean {
  return (
    summarizer.provider === session.provider &&
    !conflicting(summarizer.baseUrl, session.baseUrl) &&
    !conflicting(summarizer.authMode, session.authMode) &&
    !conflicting(summarizer.accountScope, session.accountScope)
  );
}

/**
 * Map a thrown summarizer error to a typed reason.
 *
 * Provider errors reach here as messages only, so classification is textual.
 * An unrecognized failure produced no usable summary and is reported as
 * `malformed`, retryable.
 */
export function classifySummarizerError(error: Error): PrepareFailure {
  if (error instanceof CompactionAbortedError) return failure("canceled", false);
  const message = error.message;
  if (/\b429\b|rate[ -]?limit|too many requests/iu.test(message)) return failure("429", true);
  if (/\b529\b|overloaded/iu.test(message)) return failure("529", true);
  if (/quota|billing/iu.test(message)) return failure("quota", false);
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authentication|api key/iu.test(message)) {
    return failure("auth", false);
  }
  if (/token cap|context (?:length|window)|too long|maximum context/iu.test(message)) {
    return failure("oversized", false);
  }
  if (/timed? ?out|timeout|deadline/iu.test(message)) return failure("timeout", true);
  return failure("malformed", true);
}

const UsageNumbersSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  totalTokens: Type.Number({ minimum: 0 }),
  cost: Type.Object({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
  }),
});

function validUsage(usage: Usage): boolean {
  if (!Value.Check(UsageNumbersSchema, usage)) return false;
  const numbers = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ];
  return numbers.every((value) => Number.isFinite(value));
}

/** Every required heading present, each once, in order. */
function hasSummaryStructure(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim());
  let previous = -1;
  for (const heading of SUMMARY_SECTION_HEADINGS) {
    const index = lines.indexOf(heading);
    if (index <= previous || lines.lastIndexOf(heading) !== index) return false;
    previous = index;
  }
  return true;
}

/** Usage restricted to the keys a persisted candidate draft accepts. */
function draftUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function promptInputTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function governingAppendix(content: string, truncated: boolean): string {
  const quoted = content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const marker = truncated ? "\n> [truncated]" : "";
  return `\n\n## Governing Request (split turn)\n${quoted}${marker}`;
}

function messagesOf(tagged: readonly TaggedMessage[]): CompactionMessage[] {
  return tagged.map((item) => item.message);
}

function idsOf(tagged: readonly TaggedMessage[]): string[] {
  return [...new Set(tagged.map((item) => item.entryId))];
}

function rangeOf(tagged: readonly TaggedMessage[]): [string, string] | null {
  const first = tagged[0];
  const last = tagged.at(-1);
  return first && last ? [first.entryId, last.entryId] : null;
}

function copyRange(range: EntryIdRange | null): [string, string] | null {
  return range === null ? null : [range[0], range[1]];
}

interface Limits {
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
}

function resolveLimits(model: ModelBudget, budget: PreparationBudget): Limits | undefined {
  const maxOutputTokens =
    model.maxTokens > 0
      ? Math.min(budget.maxOutputTokens, model.maxTokens)
      : budget.maxOutputTokens;
  const windowLimit =
    model.contextWindow > 0
      ? model.contextWindow - maxOutputTokens - RESPONSE_MARGIN_TOKENS
      : Number.POSITIVE_INFINITY;
  const maxInputTokens = Math.min(budget.maxInputTokens, windowLimit);
  if (!(maxOutputTokens > 0) || !(maxInputTokens > 0)) {
    return undefined;
  }
  return { maxOutputTokens, maxInputTokens };
}

type PassPlan =
  | { readonly kind: "single"; readonly prompt: string; readonly entryIds: readonly string[] }
  | {
      readonly kind: "two";
      readonly firstPrompt: string;
      readonly firstEntryIds: readonly string[];
      readonly evidence: readonly TaggedMessage[];
    };

/**
 * Choose one pass, or a bounded two-pass split of the frozen prefix.
 *
 * The second pass gets the largest newest slice that fits beside a
 * worst-case first-pass draft; the first pass gets the rest and must fit on
 * its own. There is no third pass: a prefix that cannot be covered this way
 * fails as oversized rather than dropping material.
 */
function planPasses(
  evidence: PrefixEvidence,
  governing: string | undefined,
  limits: Limits,
  customInstructions: string | undefined,
): PassPlan | undefined {
  const systemTokens = estimateTextTokens(BACKGROUND_COMPACTION_SYSTEM_PROMPT);
  const fits = (prompt: string): boolean =>
    systemTokens + estimateTextTokens(prompt) <= limits.maxInputTokens;
  const all = [...evidence.history, ...evidence.turnPrefix];
  const single = buildFrozenPrefixPrompt({
    previousSummary: evidence.previousSummary,
    history: messagesOf(evidence.history),
    turnPrefix: messagesOf(evidence.turnPrefix),
    governingRequest: governing,
    scope: "complete",
    customInstructions,
  });
  if (fits(single)) {
    return { kind: "single", prompt: single, entryIds: idsOf(all) };
  }
  if (all.length < 2) {
    return undefined;
  }

  // Worst-case first-pass draft: the output cap at a generous chars/token rate.
  const placeholder = "x".repeat(limits.maxOutputTokens * 5);
  const renderSecond = (slice: readonly TaggedMessage[]): string =>
    buildFrozenPrefixReconciliationPrompt({
      historySummary: placeholder,
      evidence: messagesOf(slice),
      governingRequest: governing,
      customInstructions,
    });
  const baseTokens = systemTokens + estimateTextTokens(renderSecond([]));
  const costs = all.map((item) => estimateTextTokens(serializeMessages([item.message])));
  let start = all.length;
  let total = baseTokens;
  while (start > 1) {
    const cost = costs[start - 1] ?? 0;
    if (total + cost > limits.maxInputTokens) break;
    total += cost;
    start--;
  }
  while (start < all.length && !fits(renderSecond(all.slice(start)))) {
    start++;
  }
  if (start >= all.length) {
    return undefined;
  }
  const older = all.slice(0, start);
  const firstPrompt = buildFrozenPrefixPrompt({
    previousSummary: evidence.previousSummary,
    history: messagesOf(older),
    turnPrefix: [],
    governingRequest: governing,
    scope: "older-part",
    customInstructions,
  });
  if (!fits(firstPrompt)) {
    return undefined;
  }
  return {
    kind: "two",
    firstPrompt,
    firstEntryIds: idsOf(older),
    evidence: all.slice(start),
  };
}

interface PassResult {
  readonly text: string;
  readonly usage: Usage;
}

interface PrepareOptions {
  readonly signal: AbortSignal;
  readonly budget: PreparationBudget;
  readonly candidateId: string;
  readonly customInstructions?: string;
}

/** Everything `prepare` resolved synchronously before its first await. */
interface PreparedInputs {
  readonly summarizer: TextSummarizer;
  readonly onPromptInput: PromptInputHook | undefined;
  readonly firstKeptEntryId: string;
  readonly limits: Limits;
  readonly remainingMs: number;
  readonly evidence: PrefixEvidence;
  readonly governing: FrozenSnapshot["governingUserRequest"];
  readonly plan: PassPlan;
  readonly customInstructions: string | undefined;
}

/** Synchronous checks and planning; returns a typed failure instead of starting a call. */
function resolvePrepareInputs(
  options: TextBackendOptions,
  snapshot: FrozenSnapshot,
  request: PrepareOptions,
  now: () => number,
): PreparedInputs | PrepareFailure {
  const summarizer = options.summarize;
  const onPromptInput = options.onPromptInput;
  if (request.signal.aborted) return failure("canceled", false);
  if (!summarizer) return failure("unsupported", false);
  if (!summarizerScopeCompatible(summarizer.scope, snapshot.providerScope))
    return failure("incompatible", false);
  const legality = checkSnapshotLegality(snapshot);
  if (!legality.legal) return failure(legality.reason, false);
  const firstKeptEntryId = readFirstKeptEntryId(snapshot);
  if (firstKeptEntryId === undefined) return failure("incompatible", false);
  const limits = resolveLimits(options.budget, request.budget);
  if (!limits) return failure("oversized", false);
  const remainingMs = request.budget.deadlineMs - now();
  if (!(remainingMs > 0)) return failure("timeout", true);
  const evidence = collectPrefixEvidence(snapshot);
  const governing = snapshot.splitTurn ? snapshot.governingUserRequest : null;
  const plan = planPasses(evidence, governing?.content, limits, request.customInstructions);
  if (!plan) return failure("oversized", false);
  return {
    summarizer,
    onPromptInput,
    firstKeptEntryId,
    limits,
    remainingMs,
    evidence,
    governing,
    plan,
    customInstructions: request.customInstructions,
  };
}

/**
 * Abort scope for one preparation: forwards the caller's signal, arms the
 * absolute deadline timer, and reports cancellation or timeout after each await.
 */
class PreparationDeadline {
  readonly controller = new AbortController();
  private timedOut = false;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly forwardAbort = (): void => this.controller.abort();
  private readonly signal: AbortSignal;
  private readonly deadlineMs: number;
  private readonly now: () => number;

  constructor(options: {
    readonly signal: AbortSignal;
    readonly remainingMs: number;
    readonly deadlineMs: number;
    readonly now: () => number;
  }) {
    this.signal = options.signal;
    this.deadlineMs = options.deadlineMs;
    this.now = options.now;
    this.signal.addEventListener("abort", this.forwardAbort, { once: true });
    this.timer =
      options.remainingMs <= MAX_TIMER_DELAY_MS
        ? setTimeout(() => this.expire(), options.remainingMs)
        : undefined;
  }

  interrupted(): PrepareFailure | undefined {
    if (this.signal.aborted) return failure("canceled", false);
    if (this.timedOut || this.now() >= this.deadlineMs) return failure("timeout", true);
    return undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.forwardAbort);
  }

  private expire(): void {
    this.timedOut = true;
    this.controller.abort();
  }
}

interface PassRunner {
  readonly snapshot: FrozenSnapshot;
  readonly inputs: PreparedInputs;
  readonly deadline: PreparationDeadline;
  readonly maxResultBytes: number;
}

interface PassRequest {
  readonly pass: 1 | 2;
  readonly promptText: string;
  readonly entryIds: readonly string[];
}

const PASS_LABELS = { 1: "Background summarization", 2: "Background reconciliation" } as const;

async function runPass(
  runner: PassRunner,
  request: PassRequest,
): Promise<PassResult | PrepareFailure> {
  const { pass, promptText } = request;
  const input: PromptInput = {
    pass,
    entryIds: request.entryIds,
    systemPrompt: BACKGROUND_COMPACTION_SYSTEM_PROMPT,
    promptText,
  };
  assertPrefixOnlyInput(runner.snapshot, input);
  runner.inputs.onPromptInput?.(input);
  const before = runner.deadline.interrupted();
  if (before) return before;
  let response: TextSummaryResponse;
  try {
    response = await runner.inputs.summarizer.summarize({
      pass,
      label: PASS_LABELS[pass],
      systemPrompt: BACKGROUND_COMPACTION_SYSTEM_PROMPT,
      promptText,
      maxTokens: runner.inputs.limits.maxOutputTokens,
      signal: runner.deadline.controller.signal,
    });
  } catch (error) {
    return (
      runner.deadline.interrupted() ??
      (error instanceof Error ? classifySummarizerError(error) : failure("malformed", true))
    );
  }
  return runner.deadline.interrupted() ?? validatePass(response, runner.maxResultBytes);
}

/** Prompt-input and output tokens of one pass. */
interface PassIteration {
  readonly input: number;
  readonly output: number;
}

/** Summary text and accounting produced by the planned passes. */
interface PassOutcome {
  readonly text: string;
  readonly usage: Usage;
  readonly passes: 1 | 2;
  readonly iterations: readonly PassIteration[];
  readonly evidenceRange: [string, string] | null;
}

function iteration(usage: Usage): PassIteration {
  return { input: promptInputTokens(usage), output: usage.output };
}

async function runSinglePass(
  runner: PassRunner,
  plan: Extract<PassPlan, { kind: "single" }>,
): Promise<PassOutcome | PrepareFailure> {
  const result = await runPass(runner, {
    pass: 1,
    promptText: plan.prompt,
    entryIds: plan.entryIds,
  });
  if ("ok" in result) return result;
  return {
    text: result.text,
    usage: result.usage,
    passes: 1,
    iterations: [iteration(result.usage)],
    evidenceRange: null,
  };
}

async function runTwoPasses(
  runner: PassRunner,
  plan: Extract<PassPlan, { kind: "two" }>,
): Promise<PassOutcome | PrepareFailure> {
  const first = await runPass(runner, {
    pass: 1,
    promptText: plan.firstPrompt,
    entryIds: plan.firstEntryIds,
  });
  if ("ok" in first) return first;
  const secondPrompt = buildFrozenPrefixReconciliationPrompt({
    historySummary: first.text,
    evidence: messagesOf(plan.evidence),
    governingRequest: runner.inputs.governing?.content,
    customInstructions: runner.inputs.customInstructions,
  });
  const secondTokens =
    estimateTextTokens(BACKGROUND_COMPACTION_SYSTEM_PROMPT) + estimateTextTokens(secondPrompt);
  if (secondTokens > runner.inputs.limits.maxInputTokens) return failure("oversized", false);
  const second = await runPass(runner, {
    pass: 2,
    promptText: secondPrompt,
    entryIds: idsOf(plan.evidence),
  });
  if ("ok" in second) return second;
  return {
    text: second.text,
    usage: combineUsage(first.usage, second.usage),
    passes: 2,
    iterations: [iteration(first.usage), iteration(second.usage)],
    evidenceRange: rangeOf(plan.evidence),
  };
}

function runPlannedPasses(runner: PassRunner): Promise<PassOutcome | PrepareFailure> {
  const plan = runner.inputs.plan;
  return plan.kind === "single" ? runSinglePass(runner, plan) : runTwoPasses(runner, plan);
}

/** Final summary: normalized text, governing appendix for a split turn, then file lists. */
function composeSummary(
  text: string,
  capped: CappedGoverningContent | undefined,
  fileLists: ReturnType<typeof resolveFileLists>,
): string {
  const appendix = capped ? governingAppendix(capped.content, capped.truncated) : "";
  return normalizeSummary(text) + appendix + formatFileLists(fileLists);
}

function checkpointDetails(
  snapshot: FrozenSnapshot,
  inputs: PreparedInputs,
  context: {
    readonly candidateId: string;
    readonly outcome: PassOutcome;
    readonly fileLists: ReturnType<typeof resolveFileLists>;
    readonly capped: CappedGoverningContent | undefined;
  },
): TextCheckpointDetails {
  const { governing, evidence } = inputs;
  const { capped, fileLists } = context;
  const details: TextCheckpointDetails = {
    strategy: "local-reconciled",
    schemaVersion: 1,
    readFiles: fileLists.readFiles,
    modifiedFiles: fileLists.modifiedFiles,
    passes: context.outcome.passes,
    evidence: {
      historyEntryIds: copyRange(evidence.summarizedEntryIds),
      tailEntryIds: null,
    },
    candidateId: context.candidateId,
    fingerprint: snapshot.prefixFingerprint,
    background: {
      schemaVersion: 1,
      mode: "frozen-prefix",
      cutEntryId: snapshot.cutEntryId,
      firstKeptEntryId: inputs.firstKeptEntryId,
      splitTurn: snapshot.splitTurn,
      governingRequest:
        governing && capped
          ? { entryId: governing.entryId, content: capped.content, truncated: capped.truncated }
          : null,
      priorCheckpointId: snapshot.priorCheckpointId,
      priorCheckpointVersion: snapshot.priorCheckpointVersion,
      evidenceEntryIds: context.outcome.evidenceRange,
    },
  };
  if (snapshot.priorCheckpointId !== null)
    details.evidence.previousCheckpointId = snapshot.priorCheckpointId;
  return details;
}

function totalUsage(outcome: PassOutcome): BackgroundUsage {
  const iterations = outcome.iterations.map((item) => ({ ...item }));
  return {
    input: iterations.reduce((sum, item) => sum + item.input, 0),
    output: iterations.reduce((sum, item) => sum + item.output, 0),
    iterations,
  };
}

/** Assemble, validate, and size-check the checkpoint built from the pass outcome. */
function buildCheckpoint(
  snapshot: FrozenSnapshot,
  inputs: PreparedInputs,
  context: {
    readonly backendId: string;
    readonly request: PrepareOptions;
    readonly outcome: PassOutcome;
  },
): PreparedCheckpoint<TextCheckpointDetails> | PrepareFailure {
  const { request, outcome } = context;
  const previous = inputs.evidence.previousCheckpoint;
  const carried = previous ? parseCarriedFileLists(previous) : undefined;
  const fileLists = resolveFileLists(snapshot.fileOps, carried);
  const capped = inputs.governing ? capGoverningContent(inputs.governing.content) : undefined;
  const details = checkpointDetails(snapshot, inputs, {
    candidateId: request.candidateId,
    outcome,
    fileLists,
    capped,
  });
  if (!validTextCheckpointDetails(details)) return failure("malformed", false);
  const draft = {
    type: "compaction" as const,
    summary: composeSummary(outcome.text, capped, fileLists),
    firstKeptEntryId: inputs.firstKeptEntryId,
    details,
    usage: draftUsage(outcome.usage),
  };
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > request.budget.maxResultBytes)
    return failure("oversized", false);
  return {
    candidateId: request.candidateId,
    backendId: context.backendId,
    schemaVersion: 1,
    draft,
    details,
    usage: totalUsage(outcome),
    reasonCodes: ["prepared"],
  };
}

async function prepareTextCheckpoint(
  options: TextBackendOptions,
  context: { readonly backendId: string; readonly now: () => number },
  snapshot: FrozenSnapshot,
  request: PrepareOptions,
): Promise<PreparedCheckpoint<TextCheckpointDetails> | PrepareFailure> {
  // Snapshot every input before the first await.
  const inputs = resolvePrepareInputs(options, snapshot, request, context.now);
  if ("ok" in inputs) return inputs;
  const deadline = new PreparationDeadline({
    signal: request.signal,
    remainingMs: inputs.remainingMs,
    deadlineMs: request.budget.deadlineMs,
    now: context.now,
  });
  try {
    const runner = { snapshot, inputs, deadline, maxResultBytes: request.budget.maxResultBytes };
    const outcome = await runPlannedPasses(runner);
    if ("ok" in outcome) return outcome;
    return buildCheckpoint(snapshot, inputs, { backendId: context.backendId, request, outcome });
  } finally {
    deadline.dispose();
  }
}

function textCapability(
  summarizer: TextSummarizer | undefined,
  scope: ProviderScope,
): CapabilityVerdict {
  if (!summarizer) return { supported: false, reason: "unsupported" };
  if (!summarizerScopeCompatible(summarizer.scope, scope))
    return { supported: false, reason: "incompatible" };
  return { supported: true };
}

/** Create the text backend; register it under {@link TEXT_BACKEND_ID}. */
export function createTextBackend(options: TextBackendOptions): Backend<TextCheckpointDetails> {
  const context = { backendId: options.id ?? TEXT_BACKEND_ID, now: options.now ?? Date.now };
  return {
    id: context.backendId,
    capability: (scope) => Promise.resolve(textCapability(options.summarize, scope)),
    isLegalCut: (snapshot): LegalityVerdict => checkSnapshotLegality(snapshot),
    prepare: (snapshot, request) => prepareTextCheckpoint(options, context, snapshot, request),
  };
}

/**
 * Validate one pass's raw response: transport status and metadata first, then
 * the summary's structure and size. Semantics are the model's responsibility.
 */
function validatePass(
  response: TextSummaryResponse,
  maxResultBytes: number,
): PassResult | PrepareFailure {
  switch (response.stopReason) {
    case "stop":
      break;
    case "length":
      return failure("oversized", false);
    case "aborted":
      return failure("canceled", false);
    default:
      return failure("malformed", true);
  }
  if (response.toolCallCount > 0 || !validUsage(response.usage)) {
    return failure("malformed", true);
  }
  const text = response.text.trim();
  if (text.length === 0 || !hasSummaryStructure(text)) {
    return failure("malformed", true);
  }
  if (Buffer.byteLength(text, "utf8") > maxResultBytes) {
    return failure("oversized", false);
  }
  return { text, usage: response.usage };
}

/** Dependencies of the production summarizer bound to the session's model. */
interface ModelSummarizerDeps {
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly thinkingLevel: SessionThinkingLevel | undefined;
  readonly retry: RetryPolicy | undefined;
}

/**
 * Summarizer that calls the session's own model through `runSummaryCall`.
 *
 * `runSummaryCall` already rejects truncated, empty, errored, and tool-calling
 * responses by throwing; those errors are classified by the backend.
 */
export function createModelSummarizer(deps: ModelSummarizerDeps): TextSummarizer {
  const scope: ProviderScope = {
    provider: deps.model.provider,
    model: deps.model.id,
  };
  if (deps.model.baseUrl.length > 0) {
    scope.baseUrl = deps.model.baseUrl;
  }
  return {
    scope,
    summarize: async (request) => {
      const result = await runSummaryCall({
        modelRegistry: deps.modelRegistry,
        model: deps.model,
        systemPrompt: request.systemPrompt,
        promptText: request.promptText,
        maxTokens: request.maxTokens,
        signal: request.signal,
        thinkingLevel: deps.thinkingLevel,
        retry: deps.retry,
        label: request.label,
      });
      return { text: result.text, usage: result.usage, stopReason: "stop", toolCallCount: 0 };
    },
  };
}
