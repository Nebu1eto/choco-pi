import {
  type BeforeProviderRequestEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { compile, lit, obj, opt, str, tuple, unknown } from "@earendil-works/pi-schema";

import type { AnthropicServerSideSession } from "../anthropic/mode.ts";
import { normalizeBaseUrl } from "../anthropic/capability.ts";
import { REASONS, ownedReasonOf } from "../background/lane-journal.ts";
import type { AnnouncedRecord } from "../background-host/notices.ts";
import { lossAuthorizedFor, OPAQUE_GUARD_NOTICE } from "../opaque-checkpoint.ts";
import { clearOpaqueBlockOf, setOpaqueBlock } from "../opaque-guard.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
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
  type XaiWireItem,
  isXaiWireBody,
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
import { summaryWireText } from "../shared/summary-wire.ts";
import { ERROR_BODY_LIMIT, readBoundedText } from "../shared/http.ts";
import { readSessionId } from "../shared/session.ts";

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

const claimsXai = compile(obj({ strategy: lit(XAI_STRATEGY) }, { open: true })).check;
const isSummaryFields = compile(
  obj(
    {
      role: lit("user"),
      content: tuple([obj({ type: lit("input_text"), text: str() }, { open: true })]),
    },
    { open: true },
  ),
).check;

export function findActiveXaiCheckpoint(branch: readonly SessionEntry[]): CheckpointLookup {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "compaction") continue;
    if (!claimsXai(entry.details)) return { kind: "none" };
    if (!isXaiDetails(entry.details)) return { kind: "invalid", entryId: entry.id };
    return {
      kind: "active",
      checkpoint: { entryId: entry.id, summary: entry.summary, details: entry.details },
    };
  }
  return { kind: "none" };
}

function isSummaryItem(item: XaiWireItem | undefined, text: string): boolean {
  return item !== undefined && isSummaryFields(item) && item.content[0].text === text;
}

function isCheckpointItem(item: XaiWireItem | undefined, details: XaiDetails): boolean {
  return item !== undefined && isXaiCompactionItem(item) && sameItem(item, details.item);
}

type RewriteOutcome =
  | { readonly ok: true; readonly payload: XaiWireBody }
  | { readonly ok: false; readonly code: XaiReplayRefusalCode };

function wireForm<T>(payload: T): XaiWireBody | undefined {
  if (isXaiWireBody(payload)) return payload;
  let text: string | undefined;
  try {
    text = JSON.stringify(payload);
  } catch {
    return undefined;
  }
  return text === undefined ? undefined : parseXaiWireBody(text);
}

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
  readonly item?: string;
  readonly code?: XaiReplayRefusalCode;
}

export type XaiReplayGuardCode = XaiReplayRefusalCode | "opaque-checkpoint" | "disabled";

export interface XaiReplayGuard {
  readonly kind: "refused" | "blocked" | "loss";
  readonly sessionId: string;
  readonly entryId: string;
  readonly code: XaiReplayGuardCode;
}

interface ReplayRewriteOptions {
  readonly onDiagnostic?: (diagnostic: XaiReplayDiagnostic) => void;
  readonly onRefused?: (code: string) => void;
  readonly onGuard?: (guard: XaiReplayGuard) => void;
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
  readonly disabled?: boolean;
}

function clearXaiBlock(sessionId: string): void {
  clearOpaqueBlockOf(sessionId, "xai-native");
}

function guardRefusalMessage(entryId: string): string {
  return OPAQUE_GUARD_NOTICE("xai", entryId);
}

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
      if (consent(sessionId, entryId)) {
        clearXaiBlock(sessionId);
        guard("loss", "opaque-checkpoint");
      } else {
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

const ITEM_REJECTION_PATTERN = /encrypted_content|compaction item|type "compaction"|input\[0\]/iu;
const isErrorBody = compile(
  obj(
    {
      error: obj(
        { message: opt(unknown()), code: opt(unknown()), param: opt(unknown()) },
        { open: true },
      ),
    },
    { open: true },
  ),
).check;
const isErrorField = compile(str()).check;

function namesCompactionItem(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isErrorBody(parsed)) return false;
  const { message, code, param } = parsed.error;
  return [message, code, param].some(
    (field) => isErrorField(field) && ITEM_REJECTION_PATTERN.test(field),
  );
}

export async function xaiReplayRejectionCode(response: Response): Promise<string | undefined> {
  if (response.status !== 400 && response.status !== 422) return undefined;
  let text: string;
  try {
    text = await readBoundedText(response.clone(), ERROR_BODY_LIMIT);
  } catch {
    return undefined;
  }
  return namesCompactionItem(text) ? `provider-${response.status}` : undefined;
}

type SessionSource = Pick<SessionManager, "buildSessionProjection">;

export interface XaiReplayBinderOptions {
  readonly providers: readonly string[];
  readonly capture?: XaiCapturingOptions;
  readonly session: AnthropicServerSideSession;
  readonly onDiagnostic: (ctx: ExtensionContext, diagnostic: XaiReplayDiagnostic) => void;
  readonly onDisabled: (ctx: ExtensionContext, code: string) => void;
  readonly announce?: XaiAnnounce;
  readonly lossAuthorized?: (sessionId: string, entryId: string) => boolean;
  readonly now?: () => number;
}

export interface XaiReplayBinder {
  bindSession(sessionId: string, sessionManager: SessionSource): () => void;
  readonly active: () => boolean;
  readonly isBound: (sessionId: string) => boolean;
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
  const bound = new Map<string, object>();
  const announced = new Map<string, Set<string>>();

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
    const disabled = options.session.isDisabled(sessionId);
    const rewritten = createXaiReplayRewriteHandler({
      disabled,
      onDiagnostic: (diagnostic) => options.onDiagnostic(ctx, diagnostic),
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

function refusalCodeOf(code: string): XaiReplayRefusalCode | undefined {
  return isRefusalCode(code) ? code : undefined;
}

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
