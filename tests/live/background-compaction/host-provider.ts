import { getCurrentSystemPrompt, type Model } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  createCapturingStreamSimple,
  parseBetaHeader,
  parseWireBody,
  wireBlocks,
  type WireBody,
} from "../../../.pi/packages/choco-pi-compaction/src/anthropic/capture.ts";
import { CHILD_OWNER_KEY_PREFIX } from "../../../.pi/packages/choco-pi-subagents/src/child-compaction-bridge.ts";
import { errorResponse, fakeResponse, fakeSummary } from "./fake-sse.ts";
import type { HostState, ResponseDispatch } from "./host-state.ts";
import { captureRequestBranch } from "./request-branch.ts";
import { summaryOwner } from "./text-factory.ts";
import { capturingFetch } from "./transport-capture.ts";

const MAIN_PREFIX = "main-session:";
const SUMMARY_MARKER = "context summarization assistant";

export interface OfflineProviderOptions {
  readonly state: HostState;
  readonly model: Model<"anthropic-messages">;
  readonly apiKey: string;
  /** Route through the production capturing provider (Anthropic native replay path). */
  readonly nativeCapture: boolean;
  /** Foreground requests below this index answer with one tool call. */
  readonly toolCycles: number;
}

/** Maps a production owner key to the session whose fake lane serves it. */
export function sessionIdForOwner(ownerKey: string): string {
  if (ownerKey.startsWith(MAIN_PREFIX)) return ownerKey.slice(MAIN_PREFIX.length);
  if (ownerKey.startsWith(CHILD_OWNER_KEY_PREFIX))
    return ownerKey.slice(CHILD_OWNER_KEY_PREFIX.length);
  throw new Error("Unmapped summary owner key");
}

function dispatchFor(
  options: OfflineProviderOptions,
  request: { readonly summary: boolean; readonly streamSessionId: string | undefined },
): ResponseDispatch {
  const { summary, streamSessionId } = request;
  const owner = summaryOwner.getStore();
  const sessionId =
    summary && owner
      ? sessionIdForOwner(owner.ownerKey)
      : (streamSessionId ?? options.state.mainSessionId);
  return { sessionId, summary, index: options.state.nextIndex(sessionId, summary) };
}

const SignedBlockSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("thinking"), Type.Literal("compaction")]),
    signature: Type.String(),
  },
  { additionalProperties: true },
);
const RedactedThinkingSchema = Type.Object(
  { type: Type.Literal("redacted_thinking"), data: Type.String() },
  { additionalProperties: true },
);

function signaturesOf(body: WireBody): string[] {
  return body.messages.flatMap((message) =>
    wireBlocks(message).flatMap((block) => {
      if (Value.Check(SignedBlockSchema, block)) return [block.signature];
      if (Value.Check(RedactedThinkingSchema, block)) return [block.data];
      return [];
    }),
  );
}

/** Fake-server rule mirroring the provider: altered signed blocks are a 400. */
function tamperResponse(state: HostState, body: WireBody | undefined): Response | undefined {
  if (!body) return undefined;
  const unknown = signaturesOf(body).filter((signature) => !state.issuedSignatures.has(signature));
  if (!unknown.length) return undefined;
  state.recorder.record("fake-server-signature-rejected", { count: unknown.length });
  return errorResponse(400, "invalid_request_error", "Harness fake server: signed block mismatch");
}

function thinkingFor(options: OfflineProviderOptions, dispatch: ResponseDispatch) {
  if (!options.model.reasoning || dispatch.summary) return undefined;
  const signature = `harness-fg-sig-${dispatch.sessionId.slice(0, 8)}-${dispatch.index}`;
  options.state.issuedSignatures.add(signature);
  return {
    text: `HARNESS-THINKING-${dispatch.sessionId.slice(0, 8)}-${dispatch.index}`,
    signature,
  };
}

function defaultResponse(options: OfflineProviderOptions, dispatch: ResponseDispatch): Response {
  const childId =
    dispatch.sessionId === options.state.mainSessionId ? undefined : dispatch.sessionId;
  return fakeResponse({
    index: dispatch.index,
    toolCycles: dispatch.summary ? 0 : options.toolCycles,
    childId,
    summaryText: dispatch.summary ? fakeSummary(dispatch.index) : undefined,
    thinking: thinkingFor(options, dispatch),
    modelId: options.model.id,
  });
}

function rememberWire(
  options: OfflineProviderOptions,
  dispatch: ResponseDispatch,
  init: RequestInit | undefined,
) {
  const { state } = options;
  const manager = state.book.manager(dispatch.sessionId);
  const branch = manager ? captureRequestBranch(state.recorder, manager, dispatch) : undefined;
  if (branch) state.requestBranches.push(branch);
  const body = Value.Check(Type.String(), init?.body) ? parseWireBody(init.body) : undefined;
  return { body, branch, betas: parseBetaHeader(new Headers(init?.headers).get("anthropic-beta")) };
}

/** The offline fake server for one request: branch capture, latch, tamper rule, response. */
async function serve(
  options: OfflineProviderOptions,
  dispatch: ResponseDispatch,
  init: RequestInit | undefined,
): Promise<Response> {
  const { state } = options;
  const seen = rememberWire(options, dispatch, init);
  const observer = state.foregroundObserver;
  if (!dispatch.summary && observer) await observer(dispatch);
  state.assertCurrent();
  const response =
    tamperResponse(state, seen.body) ??
    state.responseOverride?.(dispatch) ??
    defaultResponse(options, dispatch);
  if (seen.body && seen.branch)
    state.wire.push({
      ...dispatch,
      body: seen.body,
      betas: seen.betas,
      checkpointId: seen.branch.checkpointId,
      bodyEvidenceRef: seen.branch.bodyEvidenceRef,
      status: response.status,
    });
  return response;
}

/**
 * Registers the offline provider: the installed Anthropic adapter (or the
 * production capturing wrapper) over a scoped capturing fake fetch. Returns a
 * re-register function, since bindExtensions/reload can replace providers.
 */
export function registerOfflineProvider(
  runtime: ModelRuntime,
  options: OfflineProviderOptions,
): () => void {
  const register = () =>
    runtime.registerProvider(options.model.provider, {
      api: options.model.api,
      apiKey: options.apiKey,
      models: [options.model],
      streamSimple: offlineStreamSimple(options),
    });
  register();
  return register;
}

type OfflineStreamSimple = NonNullable<
  Parameters<ModelRuntime["registerProvider"]>[1]["streamSimple"]
>;

/** The provider's stream: the Anthropic adapter over a capturing fake fetch per request. */
function offlineStreamSimple(options: OfflineProviderOptions): OfflineStreamSimple {
  return (_model, context, streamOptions) => {
    const summary = getCurrentSystemPrompt(context.messages).includes(SUMMARY_MARKER);
    const dispatch = dispatchFor(options, { summary, streamSessionId: streamOptions?.sessionId });
    const fakeFetch = capturingFetch(
      options.state.recorder,
      () => options.state.book.sync(dispatch.sessionId),
      async (_input, init) => serve(options, dispatch, init),
      dispatch.sessionId,
    );
    options.state.recorder.record("provider-dispatch", { ...dispatch });
    const stream = options.nativeCapture
      ? createCapturingStreamSimple({ fetch: fakeFetch })
      : anthropicStreamSimple;
    return stream(options.model, context, {
      ...streamOptions,
      apiKey: options.apiKey,
      maxRetries: 0,
      fetch: fakeFetch,
    });
  };
}
