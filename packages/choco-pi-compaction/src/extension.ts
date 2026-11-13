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
import { isStaleContextError } from "./lifecycle.ts";
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

// Background compaction host integration lives in ./background-host/; this
// module stays the package's entry for both the summarizer and the background
// host API.
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

/**
 * Report a compaction failure and cancel instead of throwing.
 *
 * The extension runner catches whatever a handler throws, records an
 * extension error, and continues (`core/extensions/runner.js` `emit`). The
 * host then runs its own default compaction, which is exactly the summarizer
 * that cannot see the retained tail. Throwing would therefore commit a
 * checkpoint built from stale history without the user being told that the
 * reconciled summary failed. Cancelling keeps the session intact and the
 * notification states why.
 */
function failVisibly(ctx: ExtensionContext, reason: string): SessionBeforeCompactResult {
  ctx.ui.notify(`Compaction failed: ${reason}`, "error");
  return CANCELLED;
}

/** A warning notice; only a stale context (the session is gone) is contained. */
function notifyContained(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.notify(text, "warning");
  } catch (error) {
    if (!(error instanceof Error && isStaleContextError(error))) throw error;
  }
}

/**
 * Session identity, or undefined once this context outlived its session.
 *
 * Only the stale-context failure is contained: any other error from the host
 * is a real defect and must surface.
 */
function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    if (error instanceof Error && isStaleContextError(error)) {
      return undefined;
    }
    throw error;
  }
}

interface SummaryOutcome {
  readonly text: string;
  readonly usage: Usage;
  readonly passes: 1 | 2;
}

/** Host scalars one compaction snapshots before its first await. */
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
  /**
   * Whether losing an opaque checkpoint's provider-held history is authorized
   * for the session (the setting or a consent). Defaults to the process-global
   * consent slot; fails closed (preserve).
   */
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
}

/** The summarizer must not answer: the latest checkpoint is an unauthorized opaque record. */
interface OpaqueRefusal {
  readonly kind: "opaque";
  readonly notice: string;
}

/**
 * Build the `session_before_compact` handler.
 *
 * The host's default summarizer only sees the messages it is about to discard,
 * so completion evidence living in the retained tail never reaches it and the
 * checkpoint can report finished work as still pending. This handler feeds the
 * summarizer the discarded history *and* the retained tail, with the tail
 * marked as the current state.
 *
 * Over an opaque checkpoint (D2) the summarizer would only see its
 * placeholder: unless the loss is authorized, the compaction is cancelled
 * with the exits notice, so neither this summarizer nor the host's default
 * one summarizes a placeholder.
 */
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
      // Abort and stale-context failures cancel quietly; anything else is reported.
      if (error instanceof CompactionAbortedError) return CANCELLED;
      if (error instanceof Error && isStaleContextError(error)) return CANCELLED;
      return failVisibly(ctx, error instanceof Error ? error.message : String(error));
    }
    if (summarized === undefined) return CANCELLED;
    return { compaction: buildCompaction(run.preparation, summarized) };
  };
}

/**
 * Snapshot every host-owned scalar before the first await; undefined when not
 * locally owned, an opaque refusal when the latest checkpoint is an opaque
 * record whose loss is not authorized.
 */
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

/** Summarize in one pass when it fits, else two; undefined when the run went stale. */
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

/** Inputs for the fallback path used when one combined request cannot fit. */
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

/**
 * Summarize the history alone, then reconcile that summary against the tail.
 *
 * Pass 1 compresses the discarded material so pass 2 has room for the retained
 * tail verbatim, which is the evidence that decides each item's real status.
 */
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
