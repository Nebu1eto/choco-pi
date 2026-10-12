import { isDeepStrictEqual } from "node:util";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  countCompactionBlocks,
  transportRefusals,
  wireBlocks,
  type WireBlock,
  type WireMessage,
} from "../../../../.pi/packages/choco-pi-compaction/src/anthropic/capture.ts";
import {
  COMPACT_BETA,
  isAnthropicDetails,
  type AnthropicDetails,
} from "../../../../.pi/packages/choco-pi-compaction/src/anthropic/details.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import type { WireRequest } from "../host-state.ts";
import { replyPrompt, stepsPrompt } from "./prompts.ts";
import { evidence, type Host, type Scenario } from "./types.ts";
import { awaitPreparation, requestPreparation, type PreparationHandle } from "./workload.ts";

const CAPTURE_REQUEST = "HARNESS-NATIVE-CAPTURE-REQUEST";
const TAIL_REQUEST = "HARNESS-NATIVE-TAIL";

interface Checkpoint {
  readonly id: string;
  readonly details: AnthropicDetails;
}

/** The pre-checkpoint request whose shape matches the persisted capture, and the first replay. */
interface ReplayPair {
  readonly checkpoint: Checkpoint;
  readonly source: WireRequest;
  readonly post: WireRequest;
  readonly branchRef: number;
}

const BindingSchema = Type.Object({ block_binding: Type.Object({}) });
const BehaviorSchema = Type.Object({
  block_binding: Type.Object({ prefix_mismatch_behavior: Type.String() }),
});
const SignatureSchema = Type.Object({ signature: Type.String() });
const LaneUsageSchema = Type.Object(
  { usage: Type.Object({ input: Type.Number(), output: Type.Number() }) },
  { additionalProperties: true },
);

/** Live: asks for visible reasoning so the kept tail carries signed thinking. */
function withThinking(host: Host, prompt: string): string {
  if (host.mode === "fake") return prompt;
  return `${prompt}\nBefore each tool call, think briefly about which label comes next.`;
}

function isThinking(block: WireBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function thinkingBlocks(messages: readonly WireMessage[]): WireBlock[] {
  return messages.flatMap((message) => wireBlocks(message).filter(isThinking));
}

/** `cache_control` is a prompt-caching annotation the adapter moves to the last message. */
function contentOf(message: WireMessage) {
  return {
    role: message.role,
    blocks: wireBlocks(message).map((block) =>
      Object.fromEntries(Object.entries(block).filter(([key]) => key !== "cache_control")),
    ),
  };
}

function findCheckpoint(host: Host): Checkpoint | undefined {
  const entry = host.manager.getBranch().findLast((item) => item.type === "compaction");
  if (!entry || entry.type !== "compaction") return undefined;
  const details: unknown = entry.details;
  return isAnthropicDetails(details) ? { id: entry.id, details } : undefined;
}

function findReplayPair(host: Host, sessionId: string): ReplayPair | undefined {
  const checkpoint = findCheckpoint(host);
  if (!checkpoint) return undefined;
  const requests = host.wire.filter((item) => item.sessionId === sessionId && !item.summary);
  const post = requests.find((item) => item.checkpointId === checkpoint.id);
  const source = requests.findLast(
    (item) =>
      item.checkpointId === undefined &&
      item.body.messages.length === checkpoint.details.wire.capturedLength,
  );
  if (!post || !source) return undefined;
  return { checkpoint, source, post, branchRef: host.snapshot() };
}

/** "none": no binding on the wire; "absent": binding without a behavior. */
function bindingBehavior(post: WireRequest): string {
  const thinking = post.body.thinking;
  if (Value.Check(BehaviorSchema, thinking)) return thinking.block_binding.prefix_mismatch_behavior;
  return Value.Check(BindingSchema, thinking) ? "absent" : "none";
}

function observe<T>(
  description: string,
  actual: T,
  expected: T,
  evidenceRefs: number[],
): Observation {
  return { description, actual, expected, evidenceRefs };
}

function nativeBlockObservations(pair: ReplayPair): Observation[] {
  const { post, checkpoint, branchRef } = pair;
  const first = post.body.messages[0];
  const refs = [post.bodyEvidenceRef, branchRef];
  return [
    observe(
      "One compaction block on the replay",
      countCompactionBlocks(post.body.messages),
      1,
      refs,
    ),
    observe(
      "messages[0] first block equals the persisted block exactly",
      first !== undefined && isDeepStrictEqual(wireBlocks(first)[0], checkpoint.details.block),
      true,
      refs,
    ),
    observe("Replay carries the compaction beta", post.betas.includes(COMPACT_BETA), true, refs),
  ];
}

function replayObservations(pair: ReplayPair): Observation[] {
  const { details } = pair.checkpoint;
  const refs = [pair.source.bodyEvidenceRef, pair.post.bodyEvidenceRef, pair.branchRef];
  const prefix = pair.source.body.messages.slice(0, details.wire.prefixLength).map(contentOf);
  const tail = pair.source.body.messages.slice(details.wire.prefixLength).map(contentOf);
  const replayed = pair.post.body.messages.slice(1).map(contentOf);
  return [
    observe(
      "No frozen-prefix message survives on the replay",
      prefix.some((message) => replayed.some((other) => isDeepStrictEqual(message, other))),
      false,
      refs,
    ),
    observe("Kept tail equals the captured tail", replayed.slice(0, tail.length), tail, refs),
  ];
}

function bindingObservations(pair: ReplayPair): Observation[] {
  const { details } = pair.checkpoint;
  const refs = [pair.source.bodyEvidenceRef, pair.post.bodyEvidenceRef];
  const tail = pair.source.body.messages.slice(details.wire.prefixLength);
  const replayedTail = pair.post.body.messages.slice(1, 1 + tail.length);
  return [
    observe(
      "Kept thinking forces block binding prefix_mismatch_behavior=error",
      bindingBehavior(pair.post),
      details.wire.keptThinking ? "error" : bindingBehavior(pair.post),
      refs,
    ),
    observe("Kept tail carries thinking", thinkingBlocks(tail).length > 0, true, refs),
    observe(
      "Kept thinking blocks are byte-exact",
      thinkingBlocks(replayedTail),
      thinkingBlocks(tail),
      refs,
    ),
  ];
}

function usageObservations(host: Host, pair: ReplayPair): Observation[] {
  const lane = host.recorder.records.findLast(
    (record) => record.kind === "native-lane-response" && Value.Check(LaneUsageSchema, record.data),
  );
  if (!lane || !Value.Check(LaneUsageSchema, lane.data)) return [];
  const usage = pair.checkpoint.details.laneUsage;
  return [
    observe(
      "Persisted lane usage equals lane-reported usage",
      { input: usage.input, output: usage.output },
      lane.data.usage,
      [lane.sequence, pair.branchRef],
    ),
  ];
}

/** Signatures stay in memory only; the leak check scans recorded artifacts for them. */
function protectedSignatures(pair: ReplayPair): string[] {
  const signed = thinkingBlocks(pair.source.body.messages).flatMap((block) =>
    Value.Check(SignatureSchema, block) ? [block.signature] : [],
  );
  return [pair.checkpoint.details.block.signature, ...signed];
}

async function promptRecordingError(host: Host, text: string): Promise<void> {
  try {
    await host.session.prompt(text);
  } catch (error) {
    host.recorder.record("tools-mutation-prompt-error", {
      name: error instanceof Error ? error.name : "Unknown",
    });
  }
}

/** Negative: activate one more registered tool; production must refuse the replay. */
async function toolsMutation(host: Host, sessionId: string): Promise<Observation | undefined> {
  const { pi } = host.parent();
  const active = pi.getActiveTools();
  const extra = pi.getAllTools().find((tool) => !active.includes(tool.name));
  if (!extra) return undefined;
  const before = transportRefusals(sessionId).length;
  pi.setActiveTools([...active, extra.name]);
  const ref = host.recorder.record("tools-mutation", { added: extra.name });
  await promptRecordingError(
    host,
    replyPrompt(host, "HARNESS-NATIVE-TOOLS-MUTATED", "HARNESS-NATIVE-MUTATED-ACK"),
  );
  if (!host.isCurrent()) throw new Error("Owner disposed during negative subcase");
  const refused = transportRefusals(sessionId).length > before;
  return observe("Tool-set mutation after adoption is refused at transport", refused, true, [ref]);
}

/** Requests mid-turn without holding the foreground; captures store only after responses. */
async function prepareDuringTurn(host: Host, sessionId: string): Promise<boolean> {
  let handle: PreparationHandle | undefined;
  let requested = false;
  host.setForegroundObserver(async (dispatch) => {
    if (dispatch.sessionId !== sessionId || dispatch.index !== 2 || requested) return;
    requested = true;
    handle = await requestPreparation(host);
  });
  // Marker mapping is by substring, so the prompt must not start with a seeded prefix marker.
  // Live: three tool cycles give requests 0-3; preparation is requested at request 2.
  await host.session.prompt(
    withThinking(host, stepsPrompt(host, CAPTURE_REQUEST, 3, "HARNESS-NATIVE-CAPTURE-ACK")),
  );
  host.setForegroundObserver(undefined);
  const prepared = handle ? await awaitPreparation(host, handle) : false;
  host.recorder.record("native-preparation", { requested, prepared });
  return prepared;
}

/** No replay on a committed native checkpoint: every check fails with the same observation. */
function missingReplay(host: Host, prepared: boolean): CheckEvidence {
  const result = evidence(host);
  const missing = [
    observe(
      `Replay on a committed native checkpoint observed (prepared=${String(prepared)})`,
      false,
      true,
      [host.snapshot()],
    ),
  ];
  result.observations["post-adoption-transport"] = missing;
  result.observations["native-block-replayed"] = missing;
  result.observations["lane-usage-persisted"] = missing;
  result.observations["thinking-binding-strict"] = missing;
  return result;
}

async function runNativeAdoption(host: Host): Promise<CheckEvidence> {
  const sessionId = host.manager.getSessionId();
  const prepared = await prepareDuringTurn(host, sessionId);
  await host.session.prompt(replyPrompt(host, TAIL_REQUEST, "HARNESS-NATIVE-TAIL-ACK"));
  const pair = findReplayPair(host, sessionId);
  if (!pair) return missingReplay(host, prepared);
  const result = evidence(host);
  result.knownSecrets = [...(result.knownSecrets ?? []), ...protectedSignatures(pair)];
  result.observations["post-adoption-transport"] = replayObservations(pair);
  result.observations["native-block-replayed"] = nativeBlockObservations(pair);
  result.observations["lane-usage-persisted"] = usageObservations(host, pair);
  const negative = await toolsMutation(host, sessionId);
  result.observations["thinking-binding-strict"] = [
    ...bindingObservations(pair),
    ...(negative ? [negative] : []),
  ];
  host.recorder.record("not-covered", {
    missing: [
      "system-prompt-mutation negative: no public host API changes the session system prompt",
      ...(negative ? [] : ["tools-mutation negative: no inactive registered tool"]),
    ],
  });
  return result;
}

export const scenario: Scenario = {
  name: "anthropic-native-adoption",
  description:
    "Anthropic native compaction block replayed byte-exact under strict thinking binding",
  settings: { enabled: true, anthropicNative: true },
  seedBytes: 20_000,
  // ~5,000 tokens per seeded message: the cut lands in the seeded prefix, so the
  // kept tail starts at a user message as Anthropic requires.
  keepRecentTokens: 3000,
  checks: [
    "post-adoption-transport",
    "native-block-replayed",
    "lane-usage-persisted",
    "thinking-binding-strict",
  ],
  markers: [CAPTURE_REQUEST, TAIL_REQUEST],
  execute: runNativeAdoption,
};
