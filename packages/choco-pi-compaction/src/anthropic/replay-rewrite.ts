import {
  type BeforeProviderRequestEvent,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { arr, compile, lit, obj, str } from "@earendil-works/pi-schema";

import { isJsonRecord } from "../background/contract.ts";
import {
  bindingDigests,
  countCompactionBlocks,
  currentTransportCall,
  type TransportRequest,
  type TransportVerdict,
  type WireBody,
  isWireBody,
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
import { summaryWireText } from "../shared/summary-wire.ts";

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

const claimsAnthropic = compile(obj({ strategy: lit(ANTHROPIC_STRATEGY) }, { open: true })).check;
const isTextBlock = compile(obj({ type: lit("text"), text: str() }, { open: true })).check;
const isStringArray = compile(arr(str())).check;

function findActiveNativeCheckpoint(branch: readonly SessionEntry[]): CheckpointLookup {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "compaction") continue;
    if (!claimsAnthropic(entry.details)) return { kind: "none" };
    if (!isAnthropicDetails(entry.details)) return { kind: "invalid", entryId: entry.id };
    return {
      kind: "active",
      checkpoint: { entryId: entry.id, summary: entry.summary, details: entry.details },
    };
  }
  return { kind: "none" };
}

export function findActiveAnthropicCheckpoint(
  branch: readonly SessionEntry[],
): { readonly entryId: string } | undefined {
  const lookup = findActiveNativeCheckpoint(branch);
  if (lookup.kind === "none") return undefined;
  return { entryId: lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId };
}

function isSummaryMessage(message: WireMessage, text: string): boolean {
  if (message.role !== "user") return false;
  if (!Array.isArray(message.content)) return message.content === text;
  const [only] = message.content;
  return message.content.length === 1 && isTextBlock(only) && only.text === text;
}

function isBlockMessage(message: WireMessage, details: AnthropicDetails): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  const [only] = message.content;
  return message.content.length === 1 && isCompactionBlock(only) && sameBlock(only, details.block);
}

function hasTaskBudgetRemaining(body: WireBody): boolean {
  const config = body.output_config;
  if (!isJsonRecord(config)) return false;
  const budget = config.task_budget;
  return isJsonRecord(budget) && "remaining" in budget;
}

function dropsMismatchedThinking(body: WireBody): boolean {
  const thinking = body.thinking;
  if (!isJsonRecord(thinking)) return false;
  const binding = thinking.block_binding;
  return isJsonRecord(binding) && binding.prefix_mismatch_behavior === "drop_block";
}

type RewriteOutcome =
  | { readonly ok: true; readonly payload: WireBody; readonly requiresDropBlock: boolean }
  | { readonly ok: false; readonly code: ReplayRefusalCode }
  | { readonly ok: "fallback"; readonly code: ReplayRefusalCode };

interface ReplayRewriteOptions {
  readonly onDiagnostic?: (diagnostic: ReplayDiagnostic) => void;
}

export interface ReplayDiagnostic {
  readonly kind: "rewritten" | "refused" | "fallback" | "unverifiable";
  readonly sessionId: string;
  readonly entryId: string;
  readonly block?: string;
  readonly code?: ReplayRefusalCode;
}

function rewriteReplayPayload<T>(payload: T, checkpoint: ActiveNativeCheckpoint): RewriteOutcome {
  if (!isWireBody(payload)) return { ok: false, code: "payload-unrecognized" };
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
  const requiresDropBlock = bindingChanged && details.wire.keptThinking;
  if (requiresDropBlock && !dropsMismatchedThinking(payload)) {
    return { ok: "fallback", code: "binding-mismatch" };
  }
  const blockMessage: WireMessage = {
    role: "assistant",
    content: [structuredClone(details.block)],
  };
  const betas = isStringArray(payload.betas) ? payload.betas : [];
  const next: WireBody = {
    ...payload,
    messages: [blockMessage, ...rest],
    betas: [...new Set([...betas, COMPACT_BETA])],
  };
  return { ok: true, payload: next, requiresDropBlock };
}

function verifyReplayTransport(
  request: TransportRequest,
  checkpoint: ActiveNativeCheckpoint,
  requiresDropBlock: boolean,
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
  if (requiresDropBlock && !dropsMismatchedThinking(request.body)) {
    return { ok: false, code: "binding-mismatch" };
  }
  const summary = summaryWireText(checkpoint.summary);
  if (rest.some((message) => isSummaryMessage(message, summary))) {
    return { ok: false, code: "summary-duplicated" };
  }
  return { ok: true };
}

export function createReplayRewriteHandler(options: ReplayRewriteOptions = {}) {
  return (event: BeforeProviderRequestEvent, ctx: ExtensionContext): WireBody | undefined => {
    const lookup = findActiveNativeCheckpoint(ctx.sessionManager.getBranch());
    if (lookup.kind === "none") return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const call = currentTransportCall();
    if (call === undefined) {
      if (isWireBody(event.payload)) {
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
    if (outcome.ok === "fallback") {
      options.onDiagnostic?.({
        kind: "fallback",
        sessionId,
        entryId: checkpoint.entryId,
        block,
        code: outcome.code,
      });
      return undefined;
    }
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
    const { requiresDropBlock } = outcome;
    call.checks.push((request) => verifyReplayTransport(request, checkpoint, requiresDropBlock));
    options.onDiagnostic?.({ kind: "rewritten", sessionId, entryId: checkpoint.entryId, block });
    return outcome.payload;
  };
}
