/**
 * Replay of a committed Anthropic native checkpoint.
 *
 * The host builds every request from the branch: the latest compaction entry
 * becomes a summary `user` message followed by the kept messages. For an
 * `anthropic-compaction-on-demand-v1` checkpoint a `before_provider_request`
 * handler replaces that summary message with the signed block as its own
 * `assistant` message, leaves every kept/new message untouched and appends the
 * compaction beta.
 *
 * The handler chain is last-writer-wins, so the rewrite is never trusted on
 * its own: it registers a transport check on the current capturing provider
 * call and the capturing fetch verifies the serialized body before it leaves
 * the process. If a later handler removed or altered the block (or the beta),
 * or the rewrite itself could not be applied, the request is refused with a
 * reason code instead of being sent without the block.
 */
import {
  type BeforeProviderRequestEvent,
  convertToLlm,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { JsonValueSchema } from "../background/contract.ts";
import {
  bindingDigests,
  countCompactionBlocks,
  currentTransportCall,
  type TransportRequest,
  type TransportVerdict,
  type WireBody,
  WireBodySchema,
  type WireMessage,
} from "./capture.ts";
import {
  ANTHROPIC_STRATEGY,
  type AnthropicDetails,
  blockFingerprint,
  COMPACT_BETA,
  isAnthropicDetails,
  isCompactionBlock,
  sameBlock,
} from "./details.ts";

type ReplayRefusalCode =
  | "details-invalid"
  | "payload-unrecognized"
  | "summary-not-first"
  | "multiple-blocks"
  | "context-management"
  | "task-budget-remaining"
  | "binding-mismatch"
  | "block-missing"
  | "block-altered"
  | "beta-missing"
  | "summary-duplicated";

interface ActiveNativeCheckpoint {
  readonly entryId: string;
  readonly summary: string;
  readonly details: AnthropicDetails;
}

type CheckpointLookup =
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly checkpoint: ActiveNativeCheckpoint }
  | { readonly kind: "invalid"; readonly entryId: string };

const ClaimsAnthropicSchema = Type.Object({ strategy: Type.Literal(ANTHROPIC_STRATEGY) });
const JsonRecordSchema = Type.Record(Type.String(), JsonValueSchema);
const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });

/** The latest compaction entry on the branch decides; older native entries are history. */
function findActiveNativeCheckpoint(branch: readonly SessionEntry[]): CheckpointLookup {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "compaction") continue;
    if (!Value.Check(ClaimsAnthropicSchema, entry.details)) return { kind: "none" };
    if (!isAnthropicDetails(entry.details)) return { kind: "invalid", entryId: entry.id };
    return {
      kind: "active",
      checkpoint: { entryId: entry.id, summary: entry.summary, details: entry.details },
    };
  }
  return { kind: "none" };
}

/** Text the host sends for a compaction summary (public `convertToLlm`). */
function summaryWireText(summary: string): string {
  const [message] = convertToLlm([
    { role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 },
  ]);
  const part =
    message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
  if (part?.type !== "text") throw new Error("Unexpected host compaction summary message");
  return part.text;
}

function isSummaryMessage(message: WireMessage, text: string): boolean {
  if (message.role !== "user") return false;
  if (!Array.isArray(message.content)) return message.content === text;
  const [only] = message.content;
  return message.content.length === 1 && Value.Check(TextBlockSchema, only) && only.text === text;
}

function isBlockMessage(message: WireMessage, details: AnthropicDetails): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  const [only] = message.content;
  return message.content.length === 1 && isCompactionBlock(only) && sameBlock(only, details.block);
}

function hasTaskBudgetRemaining(body: WireBody): boolean {
  const config = body.output_config;
  if (!Value.Check(JsonRecordSchema, config)) return false;
  const budget = config.task_budget;
  return Value.Check(JsonRecordSchema, budget) && "remaining" in budget;
}

type RewriteOutcome =
  | { readonly ok: true; readonly payload: WireBody; readonly bindingChanged: boolean }
  | { readonly ok: false; readonly code: ReplayRefusalCode };

interface ReplayRewriteOptions {
  readonly onDiagnostic?: (diagnostic: ReplayDiagnostic) => void;
}

export interface ReplayDiagnostic {
  readonly kind: "rewritten" | "refused" | "unverifiable";
  readonly sessionId: string;
  readonly entryId: string;
  /** Non-secret block identity (digest prefix and length). */
  readonly block?: string;
  readonly code?: ReplayRefusalCode;
}

/**
 * Pure payload rewrite: block first, kept messages exactly as given, beta
 * appended. `thinking.block_binding` is left exactly as the provider set it.
 * Kept thinking stays bound to the messages the block replaced, so the API
 * rejects it under `prefix_mismatch_behavior: "error"` with a persistent 400
 * (observed live on claude-fable-5-1 with unchanged system and tools); with
 * pi-ai's `drop_block` the stale blocks are dropped server-side instead.
 */
function rewriteReplayPayload<T>(payload: T, checkpoint: ActiveNativeCheckpoint): RewriteOutcome {
  if (!Value.Check(WireBodySchema, payload)) return { ok: false, code: "payload-unrecognized" };
  const details = checkpoint.details;
  const [first, ...rest] = payload.messages;
  if (first === undefined) return { ok: false, code: "summary-not-first" };
  const alreadyRewritten = isBlockMessage(first, details);
  if (!alreadyRewritten && !isSummaryMessage(first, summaryWireText(checkpoint.summary))) {
    return { ok: false, code: "summary-not-first" };
  }
  if (countCompactionBlocks(rest) > 0) return { ok: false, code: "multiple-blocks" };
  if ("context_management" in payload) return { ok: false, code: "context-management" };
  if (hasTaskBudgetRemaining(payload)) return { ok: false, code: "task-budget-remaining" };
  const digests = bindingDigests(payload);
  const bindingChanged =
    digests.systemDigest !== details.wire.systemDigest ||
    digests.toolsDigest !== details.wire.toolsDigest;
  // Kept thinking is only valid while system and non-deferred tools match.
  if (bindingChanged && details.wire.keptThinking) return { ok: false, code: "binding-mismatch" };
  const blockMessage: WireMessage = {
    role: "assistant",
    content: [structuredClone(details.block)],
  };
  const betas = Value.Check(Type.Array(Type.String()), payload.betas) ? payload.betas : [];
  const next: WireBody = {
    ...payload,
    messages: [blockMessage, ...rest],
    betas: [...new Set([...betas, COMPACT_BETA])],
  };
  return { ok: true, payload: next, bindingChanged };
}

/** Transport-level check: the serialized request must still carry the exact block first. */
function verifyReplayTransport(
  request: TransportRequest,
  checkpoint: ActiveNativeCheckpoint,
): TransportVerdict {
  const messages = request.body.messages;
  const [first, ...rest] = messages;
  if (first === undefined || !isBlockMessage(first, checkpoint.details)) {
    return {
      ok: false,
      code: countCompactionBlocks(messages) === 0 ? "block-missing" : "block-altered",
    };
  }
  if (countCompactionBlocks(messages) !== 1) return { ok: false, code: "multiple-blocks" };
  if (!request.betas.includes(COMPACT_BETA)) return { ok: false, code: "beta-missing" };
  if ("context_management" in request.body) return { ok: false, code: "context-management" };
  if (hasTaskBudgetRemaining(request.body)) return { ok: false, code: "task-budget-remaining" };
  const summary = summaryWireText(checkpoint.summary);
  if (rest.some((message) => isSummaryMessage(message, summary))) {
    return { ok: false, code: "summary-duplicated" };
  }
  return { ok: true };
}

/**
 * `before_provider_request` handler. Rewrites only inside a capturing provider
 * call, where the transport check can enforce the result; elsewhere it leaves
 * the payload alone and reports `unverifiable`.
 */
export function createReplayRewriteHandler(options: ReplayRewriteOptions = {}) {
  return (event: BeforeProviderRequestEvent, ctx: ExtensionContext): WireBody | undefined => {
    const lookup = findActiveNativeCheckpoint(ctx.sessionManager.getBranch());
    if (lookup.kind === "none") return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const call = currentTransportCall();
    if (call === undefined) {
      if (Value.Check(WireBodySchema, event.payload)) {
        options.onDiagnostic?.({
          kind: "unverifiable",
          sessionId,
          entryId: lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId,
        });
      }
      return undefined;
    }
    if (lookup.kind === "invalid") {
      call.checks.push(() => ({ ok: false, code: "details-invalid" }));
      options.onDiagnostic?.({
        kind: "refused",
        sessionId,
        entryId: lookup.entryId,
        code: "details-invalid",
      });
      return undefined;
    }
    const checkpoint = lookup.checkpoint;
    const block = blockFingerprint(checkpoint.details.block);
    const outcome = rewriteReplayPayload(event.payload, checkpoint);
    if (!outcome.ok) {
      const code = outcome.code;
      call.checks.push(() => ({ ok: false, code }));
      options.onDiagnostic?.({
        kind: "refused",
        sessionId,
        entryId: checkpoint.entryId,
        block,
        code,
      });
      return undefined;
    }
    call.checks.push((request) => verifyReplayTransport(request, checkpoint));
    options.onDiagnostic?.({ kind: "rewritten", sessionId, entryId: checkpoint.entryId, block });
    return outcome.payload;
  };
}
