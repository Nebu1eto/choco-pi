/**
 * Offline xAI subject for the foreground server-side path: a Grok mirror on
 * the installed openai-responses adapter behind production's xAI capturing
 * stream (`xai/capture.ts`), answered by a scoped fake transport, and a
 * scripted `POST /v1/responses/compact` lane on global fetch (production's
 * compact client uses global fetch when no transport is injected).
 */
import { getCurrentSystemPrompt, type JsonObject, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  countCompactionItems,
  createXaiCapturingStreamSimple,
  isCompactionWireItem,
  isInstructionItem,
  parseXaiWireBody,
} from "../../../.pi/packages/choco-pi-compaction/src/xai/capture.ts";
import type { Recorder } from "./artifacts.ts";
import type { HostState } from "./host-state.ts";
import { requestOrigin } from "./live-transport.ts";

/**
 * Mirrors the installed catalog entry `xai/grok-4.7` (openai-responses at
 * `https://api.x.ai/v1`, 500,000 window), so production's xAI gate admits it
 * by its default policy. Cost is zeroed; transport is the scoped fake only.
 */
export const XAI_GROK_MIRROR: Model<"openai-responses"> = {
  id: "grok-4.7",
  name: "Grok 4.7 (offline mirror)",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500_000,
  maxTokens: 128_000,
};
/** API-key-shaped synthetic credential (xAI keys start `xai-`); never a real key. */
export const FAKE_XAI_KEY = "xai-harness-offline-placeholder";
/** The opaque item the scripted lane returns; protected like a signature. */
export const XAI_HARNESS_ITEM = {
  type: "compaction",
  encrypted_content: "harness-xai-synthetic-opaque-item-never-record-verbatim",
} as const;
const SUMMARY_MARKER = "context summarization assistant";
const COMPACT_PATH = "/responses/compact";

const CompactRequestSchema = Type.Object(
  {
    model: Type.String(),
    input: Type.Array(Type.Unknown()),
    instructions: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type Frame = JsonObject & { readonly type: string };

/** A streamed Responses answer with one text message and fixed usage. */
function textResponse(text: string, index: number): Response {
  const id = `msg_harness_${index}`;
  const message = { type: "message", id, role: "assistant" };
  const frames: Frame[] = [
    { type: "response.created", response: { id: `resp_harness_${index}`, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: id,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...message,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_harness_${index}`,
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** One offline foreground request: recorded (derived fields only), answered with text. */
function serveForeground(
  state: HostState,
  dispatch: { readonly index: number; readonly summary: boolean },
  init: RequestInit | undefined,
): Response {
  const text = Value.Check(Type.String(), init?.body) ? init.body : undefined;
  const body = text === undefined ? undefined : parseXaiWireBody(text);
  const response = textResponse(
    dispatch.summary
      ? `HARNESS-XAI-LOCAL-SUMMARY-${dispatch.index}`
      : `HARNESS-XAI-ACK-${dispatch.index}`,
    dispatch.index,
  );
  state.recorder.record("xai-foreground-request", {
    index: dispatch.index,
    summary: dispatch.summary,
    parsed: body !== undefined,
    inputItems: body?.input.length ?? 0,
    compactionItems: body === undefined ? 0 : countCompactionItems(body.input),
    itemFirst: body !== undefined && isCompactionWireItem(body.input[0]),
    status: response.status,
  });
  if (body !== undefined)
    state.xaiWire.push({
      index: dispatch.index,
      summary: dispatch.summary,
      body,
      status: response.status,
    });
  return response;
}

/**
 * Registers the offline xAI provider: production's capturing Responses stream
 * over the scoped fake transport. Returns a re-register function, since
 * bindExtensions/reload can replace providers.
 */
export function registerOfflineXaiProvider(
  runtime: ModelRuntime,
  options: {
    readonly state: HostState;
    readonly model: Model<"openai-responses">;
    /** More models of the same provider (switch targets), served the same way. */
    readonly extraModels?: readonly Model<"openai-responses">[];
    readonly apiKey: string;
  },
): () => void {
  const { state, model, apiKey } = options;
  const register = () =>
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey,
      models: [model, ...(options.extraModels ?? [])],
      streamSimple: (active, context, streamOptions) => {
        const summary = getCurrentSystemPrompt(context.messages).includes(SUMMARY_MARKER);
        const sessionId = streamOptions?.sessionId ?? state.mainSessionId;
        const dispatch = { index: state.nextIndex(sessionId, summary), summary };
        state.recorder.record("provider-dispatch", { sessionId, ...dispatch });
        const fakeFetch: typeof globalThis.fetch = async (_input, init) =>
          serveForeground(state, dispatch, init);
        return createXaiCapturingStreamSimple({ fetch: fakeFetch })(active, context, {
          ...streamOptions,
          apiKey,
          maxRetries: 0,
          fetch: fakeFetch,
        });
      },
    });
  register();
  return register;
}

/** Scripted `/responses/compact` answer: the harness item with fixed usage. */
function compactResponse(recorder: Recorder, model: Model<"openai-responses">): Response {
  recorder.record("xai-lane-response", { status: 200, outputItems: 1 });
  return new Response(
    JSON.stringify({
      object: "response.compaction",
      id: "cmp_harness",
      created_at: 1,
      model: model.id,
      output: [XAI_HARNESS_ITEM],
      usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120, dropped_message_count: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function requestPath(input: Parameters<typeof globalThis.fetch>[0]): string {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * Offline global fetch for the xAI foreground path: a compact request to the
 * model origin gets the scripted item; everything else goes to `fallback`
 * (the blocker).
 */
export function scriptedXaiCompactFetch(
  state: HostState,
  model: Model<"openai-responses">,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const origin = new URL(model.baseUrl).origin;
  return async (input, init) => {
    const body = init?.body;
    if (
      requestOrigin(input) !== origin ||
      !requestPath(input).endsWith(COMPACT_PATH) ||
      !Value.Check(Type.String(), body)
    )
      return fallback(input, init);
    const parsed: unknown = JSON.parse(body);
    if (!Value.Check(CompactRequestSchema, parsed)) return fallback(input, init);
    const wire = parseXaiWireBody(body);
    state.xaiLane.push({
      model: parsed.model,
      instructions: parsed.instructions,
      inputItems: parsed.input.length,
    });
    state.recorder.record("xai-lane-request", {
      model: parsed.model,
      inputItems: parsed.input.length,
      leadingInstruction: wire !== undefined && isInstructionItem(wire.input[0]),
      hasInstructions: parsed.instructions !== undefined,
    });
    return compactResponse(state.recorder, model);
  };
}
