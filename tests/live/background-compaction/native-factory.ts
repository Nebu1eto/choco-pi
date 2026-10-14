import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  createAnthropicNativeBackend,
  ANTHROPIC_BACKEND_ID,
  resolveEntryCut,
  selectCapture,
} from "../../../.pi/packages/choco-pi-compaction/src/anthropic/backend.ts";
import {
  AnthropicCapabilityGate,
  authModeOf,
} from "../../../.pi/packages/choco-pi-compaction/src/anthropic/capability.ts";
import { capturesFor } from "../../../.pi/packages/choco-pi-compaction/src/anthropic/capture.ts";
import {
  getRegistry,
  registerBackendFactory,
} from "../../../.pi/packages/choco-pi-compaction/src/background/registry.ts";
import { sseResponse, type SseFrame } from "./fake-sse.ts";
import type { Recorder } from "./artifacts.ts";
import { sessionIdForOwner } from "./host-provider.ts";
import { recordLaneRequest, requestOrigin } from "./live-transport.ts";
import { capturingFetch } from "./transport-capture.ts";

/** Synthetic signed block the scripted lane issues; the fake server accepts it on replay. */
const NATIVE_BLOCK = {
  type: "compaction",
  content: "HARNESS-NATIVE-CHECKPOINT",
  signature: "harness-synthetic-native-signature-never-record-verbatim",
} as const;
export const NATIVE_SIGNATURE = NATIVE_BLOCK.signature;
/** The on-demand lane asks for a summary through the top-level `compaction` field. */
const LaneRequestSchema = Type.Object(
  { compaction: Type.Object({ type: Type.Literal("summarize") }) },
  { additionalProperties: true },
);

function compactionFrames(model: Model<"anthropic-messages">): SseFrame[] {
  return [
    {
      type: "message_start",
      message: {
        id: "harness-native-prepare",
        type: "message",
        role: "assistant",
        model: model.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: NATIVE_BLOCK },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "compaction", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 100, output_tokens: 20 }],
      },
    },
    { type: "message_stop" },
  ];
}

/** Scripted lane HTTP response: one signed compaction block with fixed iteration usage. */
function laneResponse(
  recorder: Recorder,
  model: Model<"anthropic-messages">,
  init: RequestInit | undefined,
): Response {
  const body = init?.body;
  if (!Value.Check(Type.String(), body)) throw new Error("Lane did not send serialized payload");
  const parsed: unknown = JSON.parse(body);
  if (!Value.Check(LaneRequestSchema, parsed))
    throw new Error("Lane did not request native compaction");
  recorder.record("native-lane-response", {
    status: 200,
    blockType: "compaction",
    content: NATIVE_BLOCK.content,
    nativeBlockBytes: Buffer.byteLength(NATIVE_BLOCK.signature),
    usage: { input: 100, output: 20 },
    stopReason: "compaction",
  });
  return sseResponse(compactionFrames(model));
}

/**
 * Offline global fetch for the foreground server-side path, whose lane uses
 * production's default transport (global fetch): a native compaction request
 * to the model origin gets the scripted block, everything else goes to
 * `fallback` (the blocker).
 */
export function scriptedLaneFetch(
  recorder: Recorder,
  model: Model<"anthropic-messages">,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const origin = new URL(model.baseUrl).origin;
  return async (input, init) => {
    const body = init?.body;
    if (requestOrigin(input) !== origin || !Value.Check(Type.String(), body))
      return fallback(input, init);
    const parsed: unknown = JSON.parse(body);
    if (!Value.Check(LaneRequestSchema, parsed)) return fallback(input, init);
    recordLaneRequest(recorder, parsed.compaction, init);
    return laneResponse(recorder, model, init);
  };
}

/** Real production backend + installed adapter; only the lane HTTP response is scripted. */
export function installAnthropicFakeFactory(
  recorder: Recorder,
  model: Model<"anthropic-messages">,
  apiKey: string,
): () => void {
  const authMode = authModeOf(apiKey);
  if (!authMode) throw new Error("Native fake fixture lacks explicit auth mode");
  const registry = getRegistry();
  if (registry.backendFactories.has(ANTHROPIC_BACKEND_ID))
    throw new Error("Native factory already registered before harness injection");
  const laneFetch = capturingFetch(
    recorder,
    () => [],
    async (_input, init) => laneResponse(recorder, model, init),
  );
  const factory = registerBackendFactory(ANTHROPIC_BACKEND_ID, (context) => {
    recorder.record("native-factory-created", {
      ownerKey: context.ownerKey,
      ownerGeneration: context.ownerGeneration,
      backendId: ANTHROPIC_BACKEND_ID,
    });
    // Mirrors production's default factory: captures are keyed by raw session ID.
    const sessionId = sessionIdForOwner(context.ownerKey);
    return createAnthropicNativeBackend({
      gate: new AnthropicCapabilityGate({
        enabled: true,
        cooldownMs: 0,
        allowList: [
          { provider: model.provider, model: model.id, baseUrl: model.baseUrl, authMode },
        ],
      }),
      resolveModel: (scope) =>
        scope.provider === model.provider && scope.model === model.id ? model : undefined,
      async resolveAuth() {
        return { ok: true, apiKey, baseUrl: model.baseUrl };
      },
      findCapture: (snapshot) => {
        const captures = capturesFor(sessionId);
        const capture = selectCapture(captures, snapshot.cutEntryId, snapshot.providerScope);
        const resolution = capture ? resolveEntryCut(capture, snapshot.cutEntryId) : undefined;
        recorder.record("native-cut-resolution", {
          cutEntryId: snapshot.cutEntryId,
          captures: captures.length,
          selected: capture !== undefined,
          code: resolution === undefined || resolution.ok ? "legal-or-absent" : resolution.code,
        });
        return capture;
      },
      fetch: laneFetch,
    });
  });
  return () => {
    if (registry.backendFactories.get(ANTHROPIC_BACKEND_ID) === factory)
      registry.backendFactories.delete(ANTHROPIC_BACKEND_ID);
  };
}
