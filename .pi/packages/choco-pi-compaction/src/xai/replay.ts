/**
 * Replay of a committed xAI server-side checkpoint.
 *
 * The host builds every request from the branch: the latest compaction entry
 * becomes a summary `user` message (after the system-prompt instruction item)
 * followed by the kept items. For an `xai-responses-compaction-v1` checkpoint a
 * `before_provider_request` handler replaces that summary message with the
 * opaque compaction item as the FIRST input item, followed by the system
 * prompt and every kept/new item unchanged (xAI: the item is the head of the
 * conversation; new items are appended after it, never before).
 *
 * The handler chain is last-writer-wins, so the rewrite is enforced at the
 * capturing transport: the serialized body must carry exactly one compaction
 * item, first and byte-identical, and no summary text. Any mismatch refuses
 * the request before it is transmitted and turns server-side compaction off
 * for the session (later requests send the placeholder summary, later
 * compactions are summarized locally). A provider 4xx that names the
 * compaction item does the same.
 */
import {
  type BeforeProviderRequestEvent,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AnthropicServerSideSession } from "../anthropic/mode.ts";
import {
  bindXaiSessionProjection,
  countCompactionItems,
  currentXaiTransportCall,
  isInstructionItem,
  parseXaiWireBody,
  registerXaiCapture,
  releaseXaiSessionCaptures,
  type XaiCapturingOptions,
  type XaiResponseObserver,
  type XaiTransportRequest,
  type XaiTransportVerdict,
  type XaiWireBody,
  XaiWireBodySchema,
  type XaiWireItem,
} from "./capture.ts";
import {
  isXaiCompactionItem,
  isXaiDetails,
  itemFingerprint,
  sameItem,
  XAI_STRATEGY,
  type XaiDetails,
} from "./details.ts";

export type XaiReplayRefusalCode =
  | "details-invalid"
  | "payload-unrecognized"
  | "summary-not-first"
  | "multiple-items"
  | "previous-response"
  | "item-missing"
  | "item-altered"
  | "item-not-first"
  | "summary-duplicated";

interface ActiveXaiCheckpoint {
  readonly entryId: string;
  readonly summary: string;
  readonly details: XaiDetails;
}

type CheckpointLookup =
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly checkpoint: ActiveXaiCheckpoint }
  | { readonly kind: "invalid"; readonly entryId: string };

const ClaimsXaiSchema = Type.Object({ strategy: Type.Literal(XAI_STRATEGY) });
const SummaryItemSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Tuple([Type.Object({ type: Type.Literal("input_text"), text: Type.String() })]),
});

/** The latest compaction entry on the branch decides; older native entries are history. */
export function findActiveXaiCheckpoint(branch: readonly SessionEntry[]): CheckpointLookup {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "compaction") continue;
    if (!Value.Check(ClaimsXaiSchema, entry.details)) return { kind: "none" };
    if (!isXaiDetails(entry.details)) return { kind: "invalid", entryId: entry.id };
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

function isSummaryItem(item: XaiWireItem | undefined, text: string): boolean {
  return (
    item !== undefined && Value.Check(SummaryItemSchema, item) && item.content[0].text === text
  );
}

function isCheckpointItem(item: XaiWireItem | undefined, details: XaiDetails): boolean {
  return item !== undefined && isXaiCompactionItem(item) && sameItem(item, details.item);
}

type RewriteOutcome =
  | { readonly ok: true; readonly payload: XaiWireBody }
  | { readonly ok: false; readonly code: XaiReplayRefusalCode };

/**
 * The payload as it goes on the wire. The adapter's in-memory params carry
 * `undefined`-valued fields (`prompt_cache_retention`, item `phase`/`id`)
 * that serialization drops; the JSON round trip yields exactly the sent form.
 */
function wireForm<T>(payload: T): XaiWireBody | undefined {
  if (Value.Check(XaiWireBodySchema, payload)) return payload;
  let text: string | undefined;
  try {
    text = JSON.stringify(payload);
  } catch {
    return undefined;
  }
  return text === undefined ? undefined : parseXaiWireBody(text);
}

/** Pure payload rewrite: item first, then the instruction item, then every other item as given. */
export function rewriteXaiReplayPayload<T>(
  payload: T,
  checkpoint: ActiveXaiCheckpoint,
): RewriteOutcome {
  const body = wireForm(payload);
  if (body === undefined) return { ok: false, code: "payload-unrecognized" };
  return rewriteWireBody(body, checkpoint);
}

function rewriteWireBody(payload: XaiWireBody, checkpoint: ActiveXaiCheckpoint): RewriteOutcome {
  if ("previous_response_id" in payload) return { ok: false, code: "previous-response" };
  const { details } = checkpoint;
  const input = payload.input;
  if (isCheckpointItem(input[0], details)) {
    if (countCompactionItems(input) !== 1) return { ok: false, code: "multiple-items" };
    return { ok: true, payload };
  }
  const instruction = isInstructionItem(input[0]) ? input[0] : undefined;
  const afterInstruction = instruction === undefined ? input : input.slice(1);
  const [summary, ...rest] = afterInstruction;
  if (!isSummaryItem(summary, summaryWireText(checkpoint.summary))) {
    return { ok: false, code: "summary-not-first" };
  }
  if (countCompactionItems(rest) > 0) return { ok: false, code: "multiple-items" };
  const head: XaiWireItem[] = [structuredClone(details.item)];
  if (instruction !== undefined) head.push(instruction);
  return { ok: true, payload: { ...payload, input: [...head, ...rest] } };
}

/** Transport-level check: the serialized request still carries the exact item first, once. */
export function verifyXaiReplayTransport(
  request: Pick<XaiTransportRequest, "body">,
  checkpoint: ActiveXaiCheckpoint,
): XaiTransportVerdict {
  const input = request.body.input;
  const count = countCompactionItems(input);
  if (count === 0) return { ok: false, code: "item-missing" };
  if (!isCheckpointItem(input[0], checkpoint.details)) {
    return {
      ok: false,
      code: input.some((item) => isCheckpointItem(item, checkpoint.details))
        ? "item-not-first"
        : "item-altered",
    };
  }
  if (count !== 1) return { ok: false, code: "multiple-items" };
  if ("previous_response_id" in request.body) return { ok: false, code: "previous-response" };
  const summary = summaryWireText(checkpoint.summary);
  if (input.some((item) => isSummaryItem(item, summary))) {
    return { ok: false, code: "summary-duplicated" };
  }
  return { ok: true };
}

export interface XaiReplayDiagnostic {
  readonly kind: "rewritten" | "refused" | "unverifiable";
  readonly sessionId: string;
  readonly entryId: string;
  /** Non-secret item identity (digest prefix and length). */
  readonly item?: string;
  readonly code?: XaiReplayRefusalCode;
}

interface ReplayRewriteOptions {
  readonly onDiagnostic?: (diagnostic: XaiReplayDiagnostic) => void;
  /** Called with the refusal code when the transport refuses the request. */
  readonly onRefused?: (code: string) => void;
}

/**
 * `before_provider_request` handler. Rewrites only inside a capturing xAI
 * provider call, where the transport check enforces the result; elsewhere it
 * leaves the payload alone and reports `unverifiable`.
 */
export function createXaiReplayRewriteHandler(options: ReplayRewriteOptions = {}) {
  return (event: BeforeProviderRequestEvent, ctx: ExtensionContext): XaiWireBody | undefined => {
    const lookup = findActiveXaiCheckpoint(ctx.sessionManager.getBranch());
    if (lookup.kind === "none") return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const call = currentXaiTransportCall();
    const entryId = lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId;
    if (call === undefined) {
      if (wireForm(event.payload) !== undefined) {
        options.onDiagnostic?.({ kind: "unverifiable", sessionId, entryId });
      }
      return undefined;
    }
    const onRefused = options.onRefused;
    if (onRefused !== undefined) call.refusalObservers.push(onRefused);
    if (lookup.kind === "invalid") {
      call.checks.push(() => ({ ok: false, code: "details-invalid" }));
      options.onDiagnostic?.({ kind: "refused", sessionId, entryId, code: "details-invalid" });
      return undefined;
    }
    const checkpoint = lookup.checkpoint;
    const item = itemFingerprint(checkpoint.details.item);
    const outcome = rewriteXaiReplayPayload(event.payload, checkpoint);
    if (!outcome.ok) {
      const code = outcome.code;
      call.checks.push(() => ({ ok: false, code }));
      options.onDiagnostic?.({ kind: "refused", sessionId, entryId, item, code });
      return undefined;
    }
    call.checks.push((request) => verifyXaiReplayTransport(request, checkpoint));
    options.onDiagnostic?.({ kind: "rewritten", sessionId, entryId, item });
    return outcome.payload;
  };
}

// ---------------------------------------------------------------------------
// Binder (capture registration, projection, rewrite, rejection handling)
// ---------------------------------------------------------------------------

const ERROR_BODY_LIMIT = 65_536;
/** Provider error text that ties a 4xx to the replayed compaction item. */
const ITEM_REJECTION_PATTERN = /compact|encrypted_content/iu;

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < ERROR_BODY_LIMIT) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * Rejection code of a provider response to a replayed request, or undefined
 * when the response does not reject the compaction item.
 */
export async function xaiReplayRejectionCode(response: Response): Promise<string | undefined> {
  if (response.status !== 400 && response.status !== 422) return undefined;
  let text: string;
  try {
    text = await readBounded(response.clone());
  } catch {
    return undefined;
  }
  return ITEM_REJECTION_PATTERN.test(text) ? `provider-${response.status}` : undefined;
}

type SessionSource = Pick<SessionManager, "buildSessionProjection">;

export interface XaiReplayBinderOptions {
  /** Providers whose Responses stream is captured. */
  readonly providers: readonly string[];
  readonly capture?: XaiCapturingOptions;
  readonly session: AnthropicServerSideSession;
  readonly onDiagnostic: (ctx: ExtensionContext, diagnostic: XaiReplayDiagnostic) => void;
  /** Called once per session when a refusal or rejection turns server-side off. */
  readonly onDisabled: (ctx: ExtensionContext, code: string) => void;
}

export interface XaiReplayBinder {
  bindSession(sessionId: string, sessionManager: SessionSource): () => void;
  readonly active: () => boolean;
  /** The `before_provider_request` handler; register it last. */
  readonly handler: (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ) => XaiWireBody | undefined;
}

export function createXaiReplayBinder(
  pi: ExtensionAPI,
  options: XaiReplayBinderOptions,
): XaiReplayBinder {
  let captureRegistered = false;
  let boundSession: string | undefined;

  const disable = (ctx: ExtensionContext, sessionId: string, code: string): void => {
    if (options.session.disable(sessionId, code)) options.onDisabled(ctx, code);
  };

  const bindSession = (sessionId: string, sessionManager: SessionSource): (() => void) => {
    if (!captureRegistered) {
      captureRegistered = true;
      for (const provider of options.providers) {
        registerXaiCapture(pi, provider, options.capture ?? {});
      }
    }
    boundSession = sessionId;
    const unbind = bindXaiSessionProjection(
      sessionId,
      () => sessionManager.buildSessionProjection().entries,
    );
    return () => {
      unbind();
      releaseXaiSessionCaptures(sessionId);
      if (boundSession === sessionId) boundSession = undefined;
    };
  };

  const handler = (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ): XaiWireBody | undefined => {
    if (boundSession === undefined) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    // Server-side is off for this session: the host's placeholder summary is sent instead.
    if (options.session.isDisabled(sessionId)) return undefined;
    const rewritten = createXaiReplayRewriteHandler({
      onDiagnostic: (diagnostic) => options.onDiagnostic(ctx, diagnostic),
      onRefused: (code) => disable(ctx, sessionId, code),
    })(event, ctx);
    if (rewritten !== undefined) {
      currentXaiTransportCall()?.responseObservers.push(rejectionObserver(ctx, sessionId, disable));
    }
    return rewritten;
  };

  return { bindSession, active: () => boundSession !== undefined, handler };
}

function rejectionObserver(
  ctx: ExtensionContext,
  sessionId: string,
  disable: (ctx: ExtensionContext, sessionId: string, code: string) => void,
): XaiResponseObserver {
  return async (response) => {
    const code = await xaiReplayRejectionCode(response);
    if (code !== undefined) disable(ctx, sessionId, code);
  };
}
