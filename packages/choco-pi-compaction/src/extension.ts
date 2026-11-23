import type { RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import {
  type ModelBudget,
  promptFits,
  resolveMaxTokens,
  selectTailWithinBudget,
} from "./budget.ts";
import type { LocalCompactionDetails } from "./details.ts";
import { formatFileLists, resolveFileLists } from "./file-ops.ts";
import { buildCompactionInput, type CompactionInput } from "./input.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { normalizeSummary } from "./normalize.ts";
import {
  lossAuthorizedFor,
  OPAQUE_GUARD_NOTICE,
  opaqueCheckpointOf,
  opaqueProviderOf,
} from "./opaque-checkpoint.ts";
import { resolveOwner } from "./ownership.ts";
import {
  buildHistoryPassPrompt,
  buildReconciliationPrompt,
  buildSinglePassPrompt,
  COMPACTION_SYSTEM_PROMPT,
} from "./prompt.ts";
import type { SessionStateReader } from "./session-state.ts";
import { CompactionAbortedError, runSummaryCall } from "./summarize.ts";
import type { CompactionMessage } from "./types.ts";
import { combineUsage } from "./usage.ts";
import { readSessionId } from "./shared/session.ts";

export { ANCHOR_ENTRY_TYPE, CANDIDATE_RECORD_TYPE } from "./background/entry-types.ts";
export {
  type AdoptionRoute,
  BACKGROUND_ADOPTION_SIGNAL_SYMBOL,
  type BackgroundAdoptionListener,
  type BackgroundAdoptionNotice,
  type BackgroundAdoptionOwner,
  type BackgroundAdoptionSignal,
  getBackgroundAdoptionSignal,
  readAdoptionIdentity,
} from "./background-host/adoption-signal.ts";
export { registerDefaultBackendFactories } from "./background-host/backends.ts";
export {
  candidateRecordsOf,
  findCommittedAdoption,
  latestCompactionOf,
} from "./background-host/branch.ts";
export type { BackgroundCompactionOptions } from "./background-host/owner-spec.ts";
export { resolveProviderScope } from "./background-host/provider-scope.ts";
export {
  type BackgroundCompaction,
  registerBackgroundCompaction,
} from "./background-host/register.ts";
export type { SessionStateReader } from "./session-state.ts";

const CANCELLED: SessionBeforeCompactResult = { cancel: true };

function failVisibly(ctx: ExtensionContext, reason: string): SessionBeforeCompactResult {
  ctx.ui.notify(`Compaction failed: ${reason}`, "error");
  return CANCELLED;
}

function notifyContained(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.notify(text, "warning");
  } catch (error) {
    if (!(error instanceof Error && isStaleContextError(error))) throw error;
  }
}

interface SummaryOutcome {
  readonly text: string;
  readonly usage: Usage;
  readonly passes: 1 | 2;
}

interface CompactionRun {
  readonly event: SessionBeforeCompactEvent;
  readonly preparation: SessionBeforeCompactEvent["preparation"];
  readonly customInstructions: string | undefined;
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly thinkingLevel: ExtensionContext["thinkingLevel"];
  readonly retry: RetryPolicy | undefined;
  readonly signal: AbortSignal;
  readonly isStale: () => boolean;
}

interface Summarized {
  readonly input: CompactionInput;
  readonly outcome: SummaryOutcome;
}

export interface BeforeCompactHandlerOptions {
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
}

interface OpaqueRefusal {
  readonly kind: "opaque";
  readonly notice: string;
}

export function createBeforeCompactHandler(
  readState: SessionStateReader,
  options: BeforeCompactHandlerOptions = {},
): ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> {
  const lossAuthorized = options.lossAuthorized ?? lossAuthorizedFor;
  return async (event, ctx) => {
    const run = snapshotRun(readState, event, ctx, lossAuthorized);
    if (run === undefined) return undefined;
    if ("kind" in run) {
      notifyContained(ctx, run.notice);
      return CANCELLED;
    }
    if (run.signal.aborted) return CANCELLED;
    let summarized: Summarized | undefined;
    try {
      summarized = await summarizeRun(run);
    } catch (error) {
      if (error instanceof CompactionAbortedError) return CANCELLED;
      if (error instanceof Error && isStaleContextError(error)) return CANCELLED;
      return failVisibly(ctx, error instanceof Error ? error.message : String(error));
    }
    if (summarized === undefined) return CANCELLED;
    return { compaction: buildCompaction(run.preparation, summarized) };
  };
}

function snapshotRun(
  readState: SessionStateReader,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  lossAuthorized: (sessionId: string, entryId: string) => boolean,
): CompactionRun | OpaqueRefusal | undefined {
  const state = readState();
  const owner = resolveOwner(ctx, state.codexCompaction);
  const model = ctx.model;
  if (owner !== "local" || !model) {
    return undefined;
  }
  const generation = state.generation;
  const sessionId = readSessionId(ctx);
  const opaque = opaqueCheckpointOf(event.branchEntries);
  if (
    opaque !== undefined &&
    (sessionId === undefined || !lossAuthorized(sessionId, opaque.entryId))
  ) {
    return {
      kind: "opaque",
      notice: OPAQUE_GUARD_NOTICE(opaqueProviderOf(opaque.owner), opaque.entryId),
    };
  }
  const signal = event.signal;
  return {
    event,
    preparation: event.preparation,
    customInstructions: event.customInstructions,
    model,
    modelRegistry: ctx.modelRegistry,
    thinkingLevel: ctx.thinkingLevel,
    retry: state.retryPolicy,
    signal,
    isStale: () =>
      signal.aborted || readState().generation !== generation || readSessionId(ctx) !== sessionId,
  };
}

async function summarizeRun(run: CompactionRun): Promise<Summarized | undefined> {
  const { model, customInstructions } = run;
  const input = buildCompactionInput(run.event);
  const budget: ModelBudget = {
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
  };
  const maxTokens = resolveMaxTokens(budget, run.preparation.settings);
  const singlePassPrompt = buildSinglePassPrompt({
    history: input.history,
    prefix: input.prefix,
    tail: input.tail,
    previousSummary: input.previousSummary,
    customInstructions,
  });
  const outcome = promptFits(budget, maxTokens, COMPACTION_SYSTEM_PROMPT, singlePassPrompt)
    ? await runSinglePass(run, { promptText: singlePassPrompt, maxTokens })
    : await runTwoPass({
        modelRegistry: run.modelRegistry,
        model,
        budget,
        maxTokens,
        signal: run.signal,
        thinkingLevel: run.thinkingLevel,
        retry: run.retry,
        customInstructions,
        history: input.history,
        prefix: input.prefix,
        tail: input.tail,
        previousSummary: input.previousSummary,
        isStaleAfterCall: run.isStale,
      });
  if (run.isStale()) return undefined;
  return { input, outcome };
}

async function runSinglePass(
  run: CompactionRun,
  request: { readonly promptText: string; readonly maxTokens: number },
): Promise<SummaryOutcome> {
  const single = await runSummaryCall({
    modelRegistry: run.modelRegistry,
    model: run.model,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    promptText: request.promptText,
    maxTokens: request.maxTokens,
    signal: run.signal,
    thinkingLevel: run.thinkingLevel,
    retry: run.retry,
    label: "Summarization",
  });
  return { text: single.text, usage: single.usage, passes: 1 };
}

function buildCompaction(
  preparation: CompactionRun["preparation"],
  summarized: Summarized,
): NonNullable<SessionBeforeCompactResult["compaction"]> {
  const { input, outcome } = summarized;
  const fileLists = resolveFileLists(preparation.fileOps, input.previousDetails);
  const details: LocalCompactionDetails = {
    strategy: "local-reconciled",
    schemaVersion: 1,
    readFiles: fileLists.readFiles,
    modifiedFiles: fileLists.modifiedFiles,
    passes: outcome.passes,
    evidence: {
      historyEntryIds: input.historyEntryIds === null ? null : [...input.historyEntryIds],
      tailEntryIds: input.tailEntryIds === null ? null : [...input.tailEntryIds],
    },
  };
  if (input.previousCheckpointId !== undefined) {
    details.evidence.previousCheckpointId = input.previousCheckpointId;
  }
  return {
    summary: `${normalizeSummary(outcome.text)}${formatFileLists(fileLists)}`,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: outcome.usage,
    details,
  };
}

interface TwoPassRequest {
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly budget: ModelBudget;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly thinkingLevel: ExtensionContext["thinkingLevel"];
  readonly retry: RetryPolicy | undefined;
  readonly customInstructions: string | undefined;
  readonly history: readonly CompactionMessage[];
  readonly prefix: readonly CompactionMessage[];
  readonly tail: readonly CompactionMessage[];
  readonly previousSummary: string | undefined;
  readonly isStaleAfterCall: () => boolean;
}

async function runTwoPass(request: TwoPassRequest): Promise<SummaryOutcome> {
  const historyPrompt = buildHistoryPassPrompt({
    history: request.history,
    prefix: request.prefix,
    previousSummary: request.previousSummary,
    customInstructions: request.customInstructions,
  });
  if (!promptFits(request.budget, request.maxTokens, COMPACTION_SYSTEM_PROMPT, historyPrompt)) {
    throw new Error(
      "compaction history exceeds the model budget; the discarded conversation cannot be summarized",
    );
  }

  const historyPass = await runSummaryCall({
    modelRegistry: request.modelRegistry,
    model: request.model,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    promptText: historyPrompt,
    maxTokens: request.maxTokens,
    signal: request.signal,
    thinkingLevel: request.thinkingLevel,
    retry: request.retry,
    label: "History summarization",
  });
  if (request.isStaleAfterCall()) {
    throw new CompactionAbortedError("History summarization context is no longer current");
  }

  const renderReconciliation = (tail: readonly CompactionMessage[]): string =>
    buildReconciliationPrompt({
      historySummary: historyPass.text,
      tail,
      customInstructions: request.customInstructions,
    });
  const tailUsed = selectTailWithinBudget(
    request.budget,
    request.maxTokens,
    COMPACTION_SYSTEM_PROMPT,
    renderReconciliation,
    request.tail,
  );

  const reconciled = await runSummaryCall({
    modelRegistry: request.modelRegistry,
    model: request.model,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    promptText: renderReconciliation(tailUsed),
    maxTokens: request.maxTokens,
    signal: request.signal,
    thinkingLevel: request.thinkingLevel,
    retry: request.retry,
    label: "Reconciliation summarization",
  });

  return {
    text: reconciled.text,
    usage: combineUsage(historyPass.usage, reconciled.usage),
    passes: 2,
  };
}
