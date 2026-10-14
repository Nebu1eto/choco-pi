import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  parseBetaHeader,
  parseWireBody,
} from "../../../.pi/packages/choco-pi-compaction/src/anthropic/capture.ts";
import { InputSchema, type ArtifactInput } from "./artifacts.ts";
import { estimateTokens } from "./budget.ts";
import type { HostState, ResponseDispatch } from "./host-state.ts";
import { billedInput, billedOutput, type LiveLedger, type RequestKind } from "./live-ledger.ts";
import { captureRequestBranch } from "./request-branch.ts";
import { capturePayload, containsText } from "./transport-capture.ts";
import { STEP_TOOL } from "./fake-sse.ts";

const SUMMARY_MARKER = "context summarization assistant";

/** Origin only (scheme + host); paths and queries never enter artifacts. */
export function requestOrigin(input: Parameters<typeof globalThis.fetch>[0]): string {
  const raw = input instanceof Request ? input.url : String(input);
  return URL.canParse(raw) ? new URL(raw).origin : "unparseable";
}

const LaneSchema = Type.Object({ compaction: Type.Unknown() }, { additionalProperties: true });
const LaneFieldSchema = Type.Object({ compaction: InputSchema }, { additionalProperties: true });

/** The lane request's `compaction` field and `anthropic-beta` values (no other header). */
export function recordLaneRequest(
  recorder: HostState["recorder"],
  compaction: ArtifactInput,
  init: RequestInit | undefined,
): void {
  recorder.record("lane-request", {
    compaction,
    betas: parseBetaHeader(new Headers(init?.headers).get("anthropic-beta")),
  });
}
const ToolsSchema = Type.Object(
  {
    tools: Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: true })),
  },
  { additionalProperties: true },
);
const SystemSchema = Type.Object({ system: InputSchema }, { additionalProperties: true });

/** Classifies an actual serialized Anthropic body by what production put on it. */
export function classify(payload: ArtifactInput): RequestKind {
  if (Value.Check(LaneSchema, payload)) return "lane";
  if (Value.Check(SystemSchema, payload) && containsText(payload.system, SUMMARY_MARKER))
    return "summary";
  if (Value.Check(ToolsSchema, payload) && payload.tools.some((tool) => tool.name === STEP_TOOL))
    return "foreground";
  return "other";
}

export interface LiveFetchOptions {
  readonly state: HostState;
  readonly origin: string;
  readonly ledger: LiveLedger;
  readonly realFetch: typeof globalThis.fetch;
  readonly block: typeof globalThis.fetch;
}

interface Sent {
  readonly kind: RequestKind;
  readonly dispatch: ResponseDispatch;
  readonly bodyText: string;
  readonly branch: ReturnType<typeof captureRequestBranch> | undefined;
}

async function bodyTextOf(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): Promise<string> {
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
  if (!Value.Check(Type.String(), body)) throw new Error("Uncapturable live request body");
  return body;
}

/** Records dispatch, actual transport and the branch it was sent from. */
function recordRequest(state: HostState, bodyText: string, payload: ArtifactInput): Sent {
  const kind = classify(payload);
  const sessionId = state.mainSessionId;
  const summary = kind === "summary";
  const counted = kind === "foreground" || summary;
  const index = counted ? state.nextIndex(sessionId, summary) : -1;
  const dispatch: ResponseDispatch = { sessionId, summary, index };
  state.recorder.record("provider-dispatch", { ...dispatch, kind });
  capturePayload(state.recorder, "transport", payload, state.book.sync(sessionId), sessionId);
  const manager = state.book.manager(sessionId);
  const branch =
    counted && manager ? captureRequestBranch(state.recorder, manager, dispatch) : undefined;
  if (branch) state.requestBranches.push(branch);
  return { kind, dispatch, bodyText, branch };
}

function rememberWire(state: HostState, sent: Sent, init: RequestInit | undefined, status: number) {
  const body = parseWireBody(sent.bodyText);
  if (!sent.branch || !body) return;
  state.wire.push({
    ...sent.dispatch,
    body,
    betas: parseBetaHeader(new Headers(init?.headers).get("anthropic-beta")),
    checkpointId: sent.branch.checkpointId,
    bodyEvidenceRef: sent.branch.bodyEvidenceRef,
    status,
  });
}

/**
 * Live global fetch: provider-origin requests pass through to the real network
 * after capture, the runaway guard and the foreground observer; every other
 * origin is refused through `block`.
 */
export function liveFetch(options: LiveFetchOptions): typeof globalThis.fetch {
  const { state, ledger } = options;
  return async (input, init) => {
    if (requestOrigin(input) !== options.origin) return options.block(input, init);
    const bodyText = await bodyTextOf(input, init);
    const payload: unknown = bodyText.length ? JSON.parse(bodyText) : null;
    if (!Value.Check(InputSchema, payload)) throw new Error("Invalid serialized live transport");
    const sent = recordRequest(state, bodyText, payload);
    if (sent.kind === "lane" && Value.Check(LaneFieldSchema, payload))
      recordLaneRequest(state.recorder, payload.compaction, init);
    const id = ledger.reserve(sent.kind, estimateTokens(bodyText));
    const observer = state.foregroundObserver;
    if (sent.kind === "foreground" && observer) await observer(sent.dispatch);
    state.assertCurrent();
    const response = await options.realFetch(input, init);
    rememberWire(state, sent, init, response.status);
    ledger.observe(id, response, (usage) => {
      if (sent.kind !== "lane") return;
      state.recorder.record("native-lane-response", {
        status: response.status,
        usage: { input: billedInput(usage), output: billedOutput(usage) },
        stopReason: usage.stopReason ?? null,
      });
    });
    return response;
  };
}
