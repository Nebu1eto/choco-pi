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
 * the request before it is transmitted; a local refusal never turns
 * server-side compaction off. Only a provider 4xx that names the compaction
 * item does (later requests send the placeholder summary).
 *
 * Opaque-history guard (D2) at the request boundary: when the checkpoint
 * cannot be replayed (its scope differs from the current model, the payload
 * cannot be rewritten, server-side is off for the session after a provider
 * rejection, or the request is not an xAI transport call) and the user has
 * not authorized the loss, an xAI call is refused locally. For any other
 * provider a pending opaque block is published at `context` time, before the
 * request is built, and the provider-boundary overlay
 * (`installOpaqueBlockProvider`) refuses the request before it is sent (a
 * `before_provider_request` handler cannot stop a request: the host's runner
 * catches throws and sends the payload anyway). A non-xAI request that still
 * reaches `before_provider_request` was not stopped and is journaled as an
 * unauthorized send. Authorized loss sends the placeholder and is journaled.
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
import { normalizeBaseUrl } from "../anthropic/capability.ts";
import { REASONS, ownedReasonOf } from "../background/lane-journal.ts";
import type { AnnouncedRecord } from "../background-host/notices.ts";
import { lossAuthorizedFor, OPAQUE_GUARD_NOTICE } from "../opaque-checkpoint.ts";
import { clearOpaqueBlockOf, setOpaqueBlock } from "../opaque-guard.ts";
import { isStaleContextError } from "../lifecycle.ts";
import {
  bindXaiSessionProjection,
  countCompactionItems,
  currentXaiTransportCall,
  isInstructionItem,
  parseXaiWireBody,
  registerXaiCapture,
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
import type { XaiAnnounce } from "./foreground.ts";

export type XaiReplayRefusalCode =
  | "details-invalid"
  | "payload-unrecognized"
  | "scope-mismatch"
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

type ReplayModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id" | "baseUrl">;

/**
 * Whether the checkpoint was made for the current model (D11): provider,
 * model id and normalized base URL. The auth mode is not compared: it is only
 * known after the credentials resolve, and the transport check enforces the
 * item itself.
 */
export function xaiCheckpointScopeMatches(
  details: Pick<XaiDetails, "scope">,
  model: ReplayModel | undefined,
): boolean {
  if (model === undefined) return false;
  const { scope } = details;
  return (
    scope.provider === model.provider &&
    scope.model === model.id &&
    normalizeBaseUrl(scope.baseUrl) === normalizeBaseUrl(model.baseUrl)
  );
}

export interface XaiReplayDiagnostic {
  readonly kind: "rewritten" | "refused" | "unverifiable";
  readonly sessionId: string;
  readonly entryId: string;
  /** Non-secret item identity (digest prefix and length). */
  readonly item?: string;
  readonly code?: XaiReplayRefusalCode;
}

/** Why the checkpoint cannot be replayed on this request. */
/** `opaque-checkpoint`: the request is not an xAI transport call, so it cannot carry the item. */
/** `disabled`: server-side is off for the session (a provider rejected the item), so it is never replayed. */
export type XaiReplayGuardCode = XaiReplayRefusalCode | "opaque-checkpoint" | "disabled";

/**
 * A request-boundary guard decision for an unreplayable checkpoint:
 * `refused`, an xAI call refused locally; `blocked`, another provider's
 * request published as a pending block; `loss`, the placeholder is sent
 * with the user's authorization.
 */
export interface XaiReplayGuard {
  readonly kind: "refused" | "blocked" | "loss";
  readonly sessionId: string;
  readonly entryId: string;
  readonly code: XaiReplayGuardCode;
}

interface ReplayRewriteOptions {
  readonly onDiagnostic?: (diagnostic: XaiReplayDiagnostic) => void;
  /** Called with the code when the transport check refuses the rewritten request. */
  readonly onRefused?: (code: string) => void;
  readonly onGuard?: (guard: XaiReplayGuard) => void;
  /** Session-scoped loss consent; defaults to the process-global consent slot. */
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
  /** Server-side is off for this session: the checkpoint is unreplayable on every request. */
  readonly disabled?: boolean;
}

/** Clear only this lane's pending block; a Codex block on the same session is kept. */
function clearXaiBlock(sessionId: string): void {
  clearOpaqueBlockOf(sessionId, "xai-native");
}

/** The local refusal text: the exits, never a provider body. */
function guardRefusalMessage(entryId: string): string {
  return OPAQUE_GUARD_NOTICE("xai", entryId);
}

/**
 * `before_provider_request` handler. Rewrites only inside a capturing xAI
 * provider call, where the transport check enforces the result. An
 * unreplayable checkpoint goes through the opaque-history guard.
 */
export function createXaiReplayRewriteHandler(options: ReplayRewriteOptions = {}) {
  const consent = options.lossAuthorized ?? lossAuthorizedFor;
  return (event: BeforeProviderRequestEvent, ctx: ExtensionContext): XaiWireBody | undefined => {
    const lookup = findActiveXaiCheckpoint(ctx.sessionManager.getBranch());
    const sessionId = ctx.sessionManager.getSessionId();
    if (lookup.kind === "none") {
      clearXaiBlock(sessionId);
      return undefined;
    }
    const call = currentXaiTransportCall();
    const entryId = lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId;
    const guard = (kind: XaiReplayGuard["kind"], code: XaiReplayGuardCode): void =>
      options.onGuard?.({ kind, sessionId, entryId, code });
    if (call === undefined) {
      // Another provider (or an uncaptured call): it cannot carry the xAI item.
      if (consent(sessionId, entryId)) {
        clearXaiBlock(sessionId);
        guard("loss", "opaque-checkpoint");
      } else {
        // The provider overlay did not stop this request: it is sent with the placeholder.
        setOpaqueBlock(sessionId, { entryId, owner: "xai-native" });
        guard("blocked", "opaque-checkpoint");
      }
      return undefined;
    }
    clearXaiBlock(sessionId);
    const unreplayable = (code: XaiReplayGuardCode): undefined => {
      if (consent(sessionId, entryId)) {
        guard("loss", code);
        return undefined;
      }
      const message = guardRefusalMessage(entryId);
      call.checks.push(() => ({ ok: false, code, message }));
      guard("refused", code);
      return undefined;
    };
    if (options.disabled === true) return unreplayable("disabled");
    if (lookup.kind === "invalid") return unreplayable("details-invalid");
    const checkpoint = lookup.checkpoint;
    if (!xaiCheckpointScopeMatches(checkpoint.details, ctx.model)) {
      return unreplayable("scope-mismatch");
    }
    const item = itemFingerprint(checkpoint.details.item);
    const outcome = rewriteXaiReplayPayload(event.payload, checkpoint);
    if (!outcome.ok) return unreplayable(outcome.code);
    const onRefused = options.onRefused;
    if (onRefused !== undefined) call.refusalObservers.push(onRefused);
    call.checks.push((request) => verifyXaiReplayTransport(request, checkpoint));
    options.onDiagnostic?.({ kind: "rewritten", sessionId, entryId, item });
    return outcome.payload;
  };
}

// ---------------------------------------------------------------------------
// Binder (capture registration, projection, rewrite, rejection handling)
// ---------------------------------------------------------------------------

const ERROR_BODY_LIMIT = 65_536;
/**
 * Provider error fields that tie a 4xx to the replayed compaction item: the
 * item's encrypted payload, the item itself, its type, or its position.
 */
const ITEM_REJECTION_PATTERN = /encrypted_content|compaction item|type "compaction"|input\[0\]/iu;
const ErrorBodySchema = Type.Object({
  error: Type.Object({
    message: Type.Optional(Type.Unknown()),
    code: Type.Optional(Type.Unknown()),
    param: Type.Optional(Type.Unknown()),
  }),
});
const ErrorFieldSchema = Type.String();

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

/** Whether a provider error body names the compaction item (JSON `error.message|code|param` only). */
function namesCompactionItem(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Value.Check(ErrorBodySchema, parsed)) return false;
  const { message, code, param } = parsed.error;
  return [message, code, param].some(
    (field) => Value.Check(ErrorFieldSchema, field) && ITEM_REJECTION_PATTERN.test(field),
  );
}

/**
 * Rejection code of a provider response to a replayed request (HTTP 400 or
 * 422 whose JSON error names the compaction item), or undefined: any other
 * status, a non-JSON body, or an error about something else.
 */
export async function xaiReplayRejectionCode(response: Response): Promise<string | undefined> {
  if (response.status !== 400 && response.status !== 422) return undefined;
  let text: string;
  try {
    text = await readBounded(response.clone());
  } catch {
    return undefined;
  }
  return namesCompactionItem(text) ? `provider-${response.status}` : undefined;
}

type SessionSource = Pick<SessionManager, "buildSessionProjection">;

export interface XaiReplayBinderOptions {
  /** Providers whose Responses stream is captured. */
  readonly providers: readonly string[];
  readonly capture?: XaiCapturingOptions;
  readonly session: AnthropicServerSideSession;
  readonly onDiagnostic: (ctx: ExtensionContext, diagnostic: XaiReplayDiagnostic) => void;
  /** Called once per session when a provider rejection turns server-side off. */
  readonly onDisabled: (ctx: ExtensionContext, code: string) => void;
  /** Journal seam for guard decisions; without it the notices are shown directly. */
  readonly announce?: XaiAnnounce;
  /** Session-scoped loss consent; defaults to the process-global consent slot. */
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
  readonly now?: () => number;
}

export interface XaiReplayBinder {
  /**
   * Capture and project `sessionId` and activate replay for it; returns the
   * unbind. Rebinding a bound session replaces its projection source; no
   * unbind releases captures (the host releases them at shutdown and when a
   * session start binds a different session).
   */
  bindSession(sessionId: string, sessionManager: SessionSource): () => void;
  readonly active: () => boolean;
  readonly isBound: (sessionId: string) => boolean;
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
  /** Bound sessions; the token identifies the newest binding of each. */
  const bound = new Map<string, object>();
  /** Guard decisions already announced per session (once per checkpoint, kind and code). */
  const announced = new Map<string, Set<string>>();

  /** Disable only for the binding the request started on; a stale rejection does nothing. */
  const disable = (
    ctx: ExtensionContext,
    binding: { readonly sessionId: string; readonly token: object | undefined },
    code: string,
  ): void => {
    if (binding.token === undefined || bound.get(binding.sessionId) !== binding.token) return;
    if (options.session.disable(binding.sessionId, code)) options.onDisabled(ctx, code);
  };

  const bindSession = (sessionId: string, sessionManager: SessionSource): (() => void) => {
    if (!captureRegistered) {
      captureRegistered = true;
      for (const provider of options.providers) {
        registerXaiCapture(pi, provider, options.capture ?? {});
      }
    }
    const token = {};
    bound.set(sessionId, token);
    const unbind = bindXaiSessionProjection(
      sessionId,
      () => sessionManager.buildSessionProjection().entries,
    );
    return () => {
      unbind();
      if (bound.get(sessionId) !== token) return;
      bound.delete(sessionId);
      announced.delete(sessionId);
      clearXaiBlock(sessionId);
    };
  };

  const onGuard = (ctx: ExtensionContext, guard: XaiReplayGuard): void => {
    const key = `${guard.kind}|${guard.entryId}|${guard.code}`;
    let keys = announced.get(guard.sessionId);
    if (keys === undefined) {
      keys = new Set();
      announced.set(guard.sessionId, keys);
    }
    if (keys.has(key)) return;
    keys.add(key);
    announceGuard(ctx, guard, options);
  };

  const handler = (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ): XaiWireBody | undefined => {
    const sessionId = ctx.sessionManager.getSessionId();
    const token = bound.get(sessionId);
    if (token === undefined) return undefined;
    const binding = { sessionId, token };
    // Server-side off for this session (a provider rejected the item): the checkpoint is
    // unreplayable, so the guard refuses the request unless the loss is authorized.
    const disabled = options.session.isDisabled(sessionId);
    const rewritten = createXaiReplayRewriteHandler({
      disabled,
      onDiagnostic: (diagnostic) => options.onDiagnostic(ctx, diagnostic),
      // A local transport refusal is reported, never a disable: only the provider's rejection disables.
      onRefused: (code) => onTransportRefused(ctx, binding, code),
      onGuard: (guard) => onGuard(ctx, guard),
      lossAuthorized: options.lossAuthorized,
    })(event, ctx);
    if (rewritten !== undefined) {
      currentXaiTransportCall()?.responseObservers.push(rejectionObserver(ctx, binding, disable));
    }
    return rewritten;
  };

  const consent = options.lossAuthorized ?? lossAuthorizedFor;
  /**
   * Publish or clear this lane's pending block before a request is built: a
   * request that cannot go through an xAI capture cannot carry the item, so
   * without authorized loss the provider overlay must refuse it. A captured
   * xAI request is guarded by its transport check instead (no block).
   */
  const publishBlock = (ctx: ExtensionContext): void => {
    const sessionId = readSessionId(ctx);
    if (sessionId === undefined || !bound.has(sessionId)) return;
    const lookup = findActiveXaiCheckpoint(readBranch(ctx) ?? []);
    const model = ctx.model;
    const captured =
      model !== undefined &&
      model.api === "openai-responses" &&
      options.providers.includes(model.provider);
    if (lookup.kind === "none" || captured) {
      clearXaiBlock(sessionId);
      return;
    }
    const entryId = lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId;
    if (consent(sessionId, entryId)) clearXaiBlock(sessionId);
    else setOpaqueBlock(sessionId, { entryId, owner: "xai-native" });
  };
  pi.on("model_select", (_event, ctx) => publishBlock(ctx));
  pi.on("context", (_event, ctx) => {
    publishBlock(ctx);
    return undefined;
  });

  const onTransportRefused = (
    ctx: ExtensionContext,
    binding: { readonly sessionId: string; readonly token: object },
    code: string,
  ): void => {
    if (bound.get(binding.sessionId) !== binding.token) return;
    const lookup = findActiveXaiCheckpoint(readBranch(ctx) ?? []);
    if (lookup.kind !== "active") return;
    options.onDiagnostic(ctx, {
      kind: "refused",
      sessionId: binding.sessionId,
      entryId: lookup.checkpoint.entryId,
      code: refusalCodeOf(code),
    });
  };

  return {
    bindSession,
    active: () => bound.size > 0,
    isBound: (sessionId) => bound.has(sessionId),
    handler,
  };
}

function rejectionObserver(
  ctx: ExtensionContext,
  binding: { readonly sessionId: string; readonly token: object },
  disable: (
    ctx: ExtensionContext,
    binding: { readonly sessionId: string; readonly token: object | undefined },
    code: string,
  ) => void,
): XaiResponseObserver {
  return async (response) => {
    const code = await xaiReplayRejectionCode(response);
    if (code !== undefined) disable(ctx, binding, code);
  };
}

const REFUSAL_CODES: ReadonlySet<string> = new Set<XaiReplayRefusalCode>([
  "details-invalid",
  "payload-unrecognized",
  "scope-mismatch",
  "summary-not-first",
  "multiple-items",
  "previous-response",
  "item-missing",
  "item-altered",
  "item-not-first",
  "summary-duplicated",
]);

function isRefusalCode(code: string): code is XaiReplayRefusalCode {
  return REFUSAL_CODES.has(code);
}

/** A transport refusal code as a replay code (`body-unreadable` and foreign codes stay unnamed). */
function refusalCodeOf(code: string): XaiReplayRefusalCode | undefined {
  return isRefusalCode(code) ? code : undefined;
}

/** The session id, or undefined once the context outlived its session. */
function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return undefined;
    throw cause;
  }
}

/** The branch, or undefined once the context outlived its session. */
function readBranch(ctx: ExtensionContext): SessionEntry[] | undefined {
  try {
    return ctx.sessionManager.getBranch();
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return undefined;
    throw cause;
  }
}

const GUARD_PREFIX = "xAI server-side compaction";

function showNotice(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.notify(text, "warning");
  } catch (cause) {
    if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
  }
}

/** One guard decision: journaled (when wired) and notified, policy `always`. */
function announceGuard(
  ctx: ExtensionContext,
  guard: XaiReplayGuard,
  options: Pick<XaiReplayBinderOptions, "announce" | "now">,
): void {
  const { kind, sessionId, entryId, code } = guard;
  const exits = OPAQUE_GUARD_NOTICE("xai", entryId);
  let text: string;
  let record: AnnouncedRecord;
  const base = {
    at: (options.now ?? Date.now)(),
    sessionId,
    provider: "xai",
    route: "replay",
    from: "xai-native",
    checkpointEntryId: entryId,
  } as const;
  if (kind === "refused") {
    text = `${GUARD_PREFIX}: request not sent (${code}); ${exits}`;
    record = { ...base, event: "refuse", reason: ownedReasonOf(code) } as const;
  } else if (kind === "blocked") {
    text = `${GUARD_PREFIX}: a request to a model other than the checkpoint's xAI model could not be stopped before it was sent; only the placeholder summary was sent. ${exits}`;
    record = {
      ...base,
      event: "loss",
      reason: REASONS.opaqueCheckpoint,
      detail: "unauthorized-send",
    } as const;
  } else {
    text = `${GUARD_PREFIX}: checkpoint ${entryId} cannot be replayed on this request (${code}); loss is authorized, so only its placeholder summary is sent.`;
    record = { ...base, event: "loss", reason: REASONS.loss, detail: code } as const;
  }
  if (options.announce !== undefined) {
    options.announce(ctx, record, text, "warning", "always");
    return;
  }
  showNotice(ctx, text);
}
