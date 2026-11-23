import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";

import {
  bindSessionProjection,
  type CapturingProviderOptions,
  currentTransportCall,
  type NativeProviderLookup,
  registerAnthropicCapture,
  type TransportResponseObserver,
  type WireBody,
} from "./capture.ts";
import type { AnthropicServerSideSession } from "./mode.ts";
import { createReplayRewriteHandler, type ReplayDiagnostic } from "./replay-rewrite.ts";
import { ERROR_BODY_LIMIT, readBoundedText } from "../shared/http.ts";

const COMPACTION_ERROR_PREFIX = "compaction_";
const OAUTH_ENTITLEMENT_MESSAGE = "Third-party apps now draw from your extra usage";
export const OAUTH_ENTITLEMENT_CODE = "oauth-extra-usage";

const open = { open: true } as const;
const isErrorBody = compile(
  obj(
    {
      error: obj(
        {
          message: opt(str()),
          details: opt(obj({ error_code: opt(str()) }, open)),
        },
        open,
      ),
    },
    open,
  ),
).check;

export async function replayRejectionCode(response: Response): Promise<string | undefined> {
  if (response.status !== 400) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(response.clone(), ERROR_BODY_LIMIT));
  } catch {
    return undefined;
  }
  if (!isErrorBody(parsed)) return undefined;
  const code = parsed.error.details?.error_code;
  if (code?.startsWith(COMPACTION_ERROR_PREFIX) === true) return code;
  if (parsed.error.message?.includes(OAUTH_ENTITLEMENT_MESSAGE) === true) {
    return OAUTH_ENTITLEMENT_CODE;
  }
  return undefined;
}

type SessionSource = Pick<SessionManager, "buildSessionProjection">;

export interface AnthropicReplayBinderOptions {
  readonly providers: readonly string[];
  readonly capture?: CapturingProviderOptions;
  readonly session: AnthropicServerSideSession;
  readonly onDiagnostic: (ctx: ExtensionContext, diagnostic: ReplayDiagnostic) => void;
  readonly onDisabled: (ctx: ExtensionContext, code: string) => void;
}

export interface AnthropicReplayBinder {
  bindSession(
    sessionId: string,
    sessionManager: SessionSource,
    registry?: NativeProviderLookup,
  ): () => void;
  readonly active: () => boolean;
  readonly isBound: (sessionId: string) => boolean;
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
  const bound = new Map<string, object>();

  const bindSession = (
    sessionId: string,
    sessionManager: SessionSource,
    registry?: NativeProviderLookup,
  ): (() => void) => {
    if (!captureRegistered) {
      captureRegistered = true;
      for (const provider of options.providers) {
        registerAnthropicCapture(pi, provider, options.capture ?? {}, registry);
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
    const { sessionId, token } = binding;
    if (token === undefined || currentToken(sessionId) !== token) return;
    if (options.session.disable(sessionId, code)) options.onDisabled(ctx, code);
  };
}
