/**
 * One binder for Anthropic native replay, shared by the foreground
 * server-side path and the background `anthropic-native` backend.
 *
 * Binding a session registers the capturing provider stream (once per
 * registration), binds the session projection captures map against, and
 * activates the replay rewrite. A replayed request the provider rejects with a
 * `compaction_*` error code (or the OAuth extra-usage entitlement refusal)
 * turns server-side compaction off for the rest of that session: later
 * requests send the checkpoint's summary text and later compactions are
 * summarized locally.
 */
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  bindSessionProjection,
  type CapturingProviderOptions,
  currentTransportCall,
  registerAnthropicCapture,
  type TransportResponseObserver,
  type WireBody,
} from "./capture.ts";
import type { AnthropicServerSideSession } from "./mode.ts";
import { createReplayRewriteHandler, type ReplayDiagnostic } from "./replay-rewrite.ts";

const ERROR_BODY_LIMIT = 65_536;
const COMPACTION_ERROR_PREFIX = "compaction_";
/** The subscription OAuth refusal observed on full-profile requests (README, live status). */
const OAUTH_ENTITLEMENT_MESSAGE = "Third-party apps now draw from your extra usage";
export const OAUTH_ENTITLEMENT_CODE = "oauth-extra-usage";

const ErrorBodySchema = Type.Object({
  error: Type.Object({
    message: Type.Optional(Type.String()),
    details: Type.Optional(Type.Object({ error_code: Type.Optional(Type.String()) })),
  }),
});

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
 * The rejection code of a provider response to a replayed request, or
 * undefined when the response does not reject the replayed block.
 */
export async function replayRejectionCode(response: Response): Promise<string | undefined> {
  if (response.status !== 400) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBounded(response.clone()));
  } catch {
    return undefined;
  }
  if (!Value.Check(ErrorBodySchema, parsed)) return undefined;
  const code = parsed.error.details?.error_code;
  if (code?.startsWith(COMPACTION_ERROR_PREFIX) === true) return code;
  if (parsed.error.message?.includes(OAUTH_ENTITLEMENT_MESSAGE) === true) {
    return OAUTH_ENTITLEMENT_CODE;
  }
  return undefined;
}

type SessionSource = Pick<SessionManager, "buildSessionProjection">;

export interface AnthropicReplayBinderOptions {
  /** Providers whose Anthropic stream is captured. */
  readonly providers: readonly string[];
  readonly capture?: CapturingProviderOptions;
  readonly session: AnthropicServerSideSession;
  readonly onDiagnostic: (ctx: ExtensionContext, diagnostic: ReplayDiagnostic) => void;
  /** Called once per session when a replay rejection turns server-side off. */
  readonly onDisabled: (ctx: ExtensionContext, code: string) => void;
}

export interface AnthropicReplayBinder {
  /**
   * Capture and project `sessionId` and activate replay for it; returns the
   * unbind. Binding an already bound session replaces its projection source.
   * An unbind never releases the session's captures (D8): a binding that is
   * not renewed (mode off, no checkpoint) keeps them for the next binding of
   * the same session; the host releases them at shutdown and when the session
   * changes (`releaseSessionCaptures`).
   */
  bindSession(sessionId: string, sessionManager: SessionSource): () => void;
  /** Whether any session is bound (replay active). */
  readonly active: () => boolean;
  /** Whether this session is bound. */
  readonly isBound: (sessionId: string) => boolean;
  /** The `before_provider_request` handler; register it last. */
  readonly handler: (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ) => WireBody | undefined;
}

export function createAnthropicReplayBinder(
  pi: ExtensionAPI,
  options: AnthropicReplayBinderOptions,
): AnthropicReplayBinder {
  let captureRegistered = false;
  /** Bound sessions; the token identifies the newest binding of each. */
  const bound = new Map<string, object>();

  const bindSession = (sessionId: string, sessionManager: SessionSource): (() => void) => {
    if (!captureRegistered) {
      captureRegistered = true;
      for (const provider of options.providers) {
        registerAnthropicCapture(pi, provider, options.capture ?? {});
      }
    }
    const token = {};
    bound.set(sessionId, token);
    const unbind = bindSessionProjection(
      sessionId,
      () => sessionManager.buildSessionProjection().entries,
    );
    return () => {
      unbind();
      // A newer binding of the same session keeps its projection; captures are the host's to release.
      if (bound.get(sessionId) !== token) return;
      bound.delete(sessionId);
    };
  };

  const handler = (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ): WireBody | undefined => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!bound.has(sessionId)) return undefined;
    // Server-side is off for this session: the host's summary text is sent instead.
    if (options.session.isDisabled(sessionId)) return undefined;
    const rewritten = createReplayRewriteHandler({
      onDiagnostic: (diagnostic) => options.onDiagnostic(ctx, diagnostic),
    })(event, ctx);
    if (rewritten !== undefined) {
      const binding = { sessionId, token: bound.get(sessionId) };
      currentTransportCall()?.responseObservers.push(
        rejectionObserver(options, ctx, binding, (id) => bound.get(id)),
      );
    }
    return rewritten;
  };

  return {
    bindSession,
    active: () => bound.size > 0,
    isBound: (sessionId) => bound.has(sessionId),
    handler,
  };
}

function rejectionObserver(
  options: AnthropicReplayBinderOptions,
  ctx: ExtensionContext,
  binding: { readonly sessionId: string; readonly token: object | undefined },
  currentToken: (sessionId: string) => object | undefined,
): TransportResponseObserver {
  return async (response) => {
    const code = await replayRejectionCode(response);
    if (code === undefined) return;
    // A rejection that resolves after the session was rebound (model change,
    // mode apply, reload) or unbound belongs to a binding that no longer
    // exists: it neither disables the session nor notifies (the host would
    // drop the stale notice, leaving a silent disable).
    const { sessionId, token } = binding;
    if (token === undefined || currentToken(sessionId) !== token) return;
    if (options.session.disable(sessionId, code)) options.onDisabled(ctx, code);
  };
}
