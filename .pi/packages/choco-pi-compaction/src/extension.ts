import type { Usage } from "@earendil-works/pi-ai";
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
import { resolveOwner } from "./ownership.ts";
import {
  buildHistoryPassPrompt,
  buildReconciliationPrompt,
  buildSinglePassPrompt,
  COMPACTION_SYSTEM_PROMPT,
} from "./prompt.ts";
import { CompactionAbortedError, runSummaryCall } from "./summarize.ts";
import type { CompactionMessage } from "./types.ts";
import { combineUsage } from "./usage.ts";

/** Reads the handler's lifetime counter, which a session change increments. */
export type GenerationReader = () => number;

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

/**
 * Build the `session_before_compact` handler.
 *
 * The host's default summarizer only sees the messages it is about to discard,
 * so completion evidence living in the retained tail never reaches it and the
 * checkpoint can report finished work as still pending. This handler feeds the
 * summarizer the discarded history *and* the retained tail, with the tail
 * marked as the current state.
 */
export function createBeforeCompactHandler(
  readGeneration: GenerationReader,
): ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> {
  return async (event, ctx) => {
    // Snapshot every host-owned scalar before the first await.
    const owner = resolveOwner(ctx);
    const model = ctx.model;
    if (owner !== "local" || !model) {
      return undefined;
    }
    const generation = readGeneration();
    const sessionId = readSessionId(ctx);
    const thinkingLevel = ctx.thinkingLevel;
    const modelRegistry = ctx.modelRegistry;
    const signal = event.signal;
    const preparation = event.preparation;
    const customInstructions = event.customInstructions;
    if (signal.aborted) {
      return CANCELLED;
    }

    const isStale = (): boolean =>
      signal.aborted || readGeneration() !== generation || readSessionId(ctx) !== sessionId;

    let outcome: SummaryOutcome;
    let input: CompactionInput;
    try {
      input = buildCompactionInput(event);
      const budget: ModelBudget = {
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      };
      const maxTokens = resolveMaxTokens(budget, preparation.settings);
      const singlePassPrompt = buildSinglePassPrompt({
        history: input.history,
        prefix: input.prefix,
        tail: input.tail,
        previousSummary: input.previousSummary,
        customInstructions,
      });
      if (promptFits(budget, maxTokens, COMPACTION_SYSTEM_PROMPT, singlePassPrompt)) {
        const single = await runSummaryCall({
          modelRegistry,
          model,
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          promptText: singlePassPrompt,
          maxTokens,
          signal,
          thinkingLevel,
          label: "Summarization",
        });
        if (isStale()) {
          return CANCELLED;
        }
        outcome = { text: single.text, usage: single.usage, passes: 1 };
      } else {
        outcome = await runTwoPass({
          modelRegistry,
          model,
          budget,
          maxTokens,
          signal,
          thinkingLevel,
          customInstructions,
          history: input.history,
          prefix: input.prefix,
          tail: input.tail,
          previousSummary: input.previousSummary,
          isStaleAfterCall: isStale,
        });
        if (isStale()) {
          return CANCELLED;
        }
      }
    } catch (error) {
      if (error instanceof CompactionAbortedError) {
        return CANCELLED;
      }
      if (error instanceof Error && isStaleContextError(error)) {
        return CANCELLED;
      }
      return failVisibly(ctx, error instanceof Error ? error.message : String(error));
    }

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
      compaction: {
        summary: `${normalizeSummary(outcome.text)}${formatFileLists(fileLists)}`,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage: outcome.usage,
        details,
      },
    };
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
    label: "Reconciliation summarization",
  });

  return {
    text: reconciled.text,
    usage: combineUsage(historyPass.usage, reconciled.usage),
    passes: 2,
  };
}
