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
  releaseSessionCaptures,
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
  /** Capture and project `sessionId` and activate replay; returns the unbind. */
  bindSession(sessionId: string, sessionManager: SessionSource): () => void;
  /** Whether a session is bound (replay active). */
  readonly active: () => boolean;
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
  let boundSession: string | undefined;

  const bindSession = (sessionId: string, sessionManager: SessionSource): (() => void) => {
    if (!captureRegistered) {
      captureRegistered = true;
      for (const provider of options.providers) {
        registerAnthropicCapture(pi, provider, options.capture ?? {});
      }
    }
    boundSession = sessionId;
    const unbind = bindSessionProjection(
      sessionId,
      () => sessionManager.buildSessionProjection().entries,
    );
    return () => {
      unbind();
      releaseSessionCaptures(sessionId);
      if (boundSession === sessionId) boundSession = undefined;
    };
  };

  const handler = (
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ): WireBody | undefined => {
    if (boundSession === undefined) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    // Server-side is off for this session: the host's summary text is sent instead.
    if (options.session.isDisabled(sessionId)) return undefined;
    const rewritten = createReplayRewriteHandler({
      onDiagnostic: (diagnostic) => options.onDiagnostic(ctx, diagnostic),
    })(event, ctx);
    if (rewritten !== undefined) {
      currentTransportCall()?.responseObservers.push(rejectionObserver(options, ctx, sessionId));
    }
    return rewritten;
  };

  return { bindSession, active: () => boundSession !== undefined, handler };
}

function rejectionObserver(
  options: AnthropicReplayBinderOptions,
  ctx: ExtensionContext,
  sessionId: string,
): TransportResponseObserver {
  return async (response) => {
    const code = await replayRejectionCode(response);
    if (code === undefined) return;
    if (options.session.disable(sessionId, code)) options.onDisabled(ctx, code);
  };
}
