import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CanonicalHistoryDecision, ProtocolValue, ResponsesBody } from "./types.ts";
import { responseInputsEqual } from "./websocket-continuation.ts";
import type { CodexCompactionReplayDecision } from "../../adapter/compaction/diagnostics.ts";

export type CanonicalSessionToken = {
  laneIdentity: symbol;
  requestSequence: number;
};

type CanonicalSessionLane = {
  identity: symbol;
  requestSequence: number;
};

const AdditionalToolsItemSchema = Type.Object({ type: Type.Literal("additional_tools") });
const DeveloperItemSchema = Type.Object({ role: Type.Literal("developer") });

type CanonicalSessionState = {
  accountId: string;
  url: string;
  requestBody: ResponsesBody;
  reconstructedRequestInput: readonly ProtocolValue[];
  responseItems: readonly ProtocolValue[];
};

const canonicalSessions = new Map<string, CanonicalSessionState>();
const canonicalSessionLanes = new Map<string, CanonicalSessionLane>();

function matchesLane(
  state: CanonicalSessionState,
  url: string,
  accountId: string,
  model: string,
): boolean {
  return state.url === url && state.accountId === accountId && state.requestBody.model === model;
}

function materializedInput(state: CanonicalSessionState): ProtocolValue[] {
  return [...state.requestBody.input, ...state.responseItems];
}

function responsesLiteRequestPrefixLength(input: readonly ProtocolValue[]): number {
  if (!Check(AdditionalToolsItemSchema, input[0])) return 0;
  return Check(DeveloperItemSchema, input[1]) ? 2 : 1;
}

interface CanonicalReplayResult {
  input?: ProtocolValue[] | undefined;
  decision: CanonicalHistoryDecision;
}

function replayCanonicalInput(
  state: CanonicalSessionState,
  preparedInput: readonly ProtocolValue[],
  requestPrefixLength = 0,
): CanonicalReplayResult {
  const reconstructedRequestInput = state.reconstructedRequestInput.slice(requestPrefixLength);
  const minimumInputLength = reconstructedRequestInput.length + state.responseItems.length;
  if (preparedInput.length < minimumInputLength) {
    return { decision: "input_shorter_than_baseline" };
  }
  if (
    !responseInputsEqual(
      preparedInput.slice(0, reconstructedRequestInput.length),
      reconstructedRequestInput,
    )
  ) {
    return { decision: "request_prefix_mismatch" };
  }
  const reconstructedResponseEnd = reconstructedRequestInput.length + state.responseItems.length;
  if (
    !responseInputsEqual(
      preparedInput.slice(reconstructedRequestInput.length, reconstructedResponseEnd),
      state.responseItems,
    )
  ) {
    return { decision: "response_prefix_mismatch" };
  }
  return {
    input: [
      ...structuredClone(materializedInput(state)),
      ...structuredClone(preparedInput.slice(reconstructedResponseEnd)),
    ],
    decision: "validated",
  };
}

export function recordCanonicalSessionResponse(args: {
  sessionId?: string | undefined;
  url: string;
  accountId: string;
  requestBody: ResponsesBody;
  reconstructedRequestBody?: ResponsesBody | undefined;
  responseItems: readonly ProtocolValue[];
  token?: CanonicalSessionToken | undefined;
}): void {
  if (!args.sessionId) return;
  if (args.token && !canonicalSessionTokenMatches(args.sessionId, args.token)) return;
  canonicalSessions.set(args.sessionId, {
    accountId: args.accountId,
    url: args.url,
    requestBody: structuredClone(args.requestBody),
    reconstructedRequestInput: structuredClone(
      (args.reconstructedRequestBody ?? args.requestBody).input,
    ),
    responseItems: structuredClone(args.responseItems),
  });
}

export function captureCanonicalSessionToken(
  sessionId: string | undefined,
): CanonicalSessionToken | undefined {
  if (!sessionId) return undefined;
  let lane = canonicalSessionLanes.get(sessionId);
  if (!lane) {
    lane = { identity: Symbol(), requestSequence: 0 };
    canonicalSessionLanes.set(sessionId, lane);
  }
  lane.requestSequence++;
  return {
    laneIdentity: lane.identity,
    requestSequence: lane.requestSequence,
  };
}

function canonicalSessionTokenMatches(sessionId: string, token: CanonicalSessionToken): boolean {
  const lane = canonicalSessionLanes.get(sessionId);
  return lane?.identity === token.laneIdentity && token.requestSequence === lane.requestSequence;
}

export function validateCanonicalSessionRequest(
  sessionId: string | undefined,
  url: string,
  accountId: string,
  preparedBody: ResponsesBody,
): CanonicalHistoryDecision | undefined {
  if (!sessionId) return undefined;
  const state = canonicalSessions.get(sessionId);
  if (!state) return undefined;
  if (!matchesLane(state, url, accountId, preparedBody.model)) {
    return "identity_mismatch";
  }

  const replay = replayCanonicalInput(state, preparedBody.input);
  return replay.decision;
}

export function canonicalCompactionPromptInput(
  sessionId: string,
  model: string,
  identity?: { url: string; accountId: string } | undefined,
  reconstructedInput?: readonly ProtocolValue[] | undefined,
): ProtocolValue[] | undefined {
  return resolveCanonicalCompactionPromptInput(sessionId, model, identity, reconstructedInput)
    .input;
}

interface CanonicalCompactionPromptResult {
  input?: ProtocolValue[] | undefined;
  decision: CodexCompactionReplayDecision;
}

export function resolveCanonicalCompactionPromptInput(
  sessionId: string,
  model: string,
  identity?: { url: string; accountId: string } | undefined,
  reconstructedInput?: readonly ProtocolValue[] | undefined,
): CanonicalCompactionPromptResult {
  const state = canonicalSessions.get(sessionId);
  if (!state) return { decision: "no_state" };
  if (state.requestBody.model !== model) return { decision: "model_mismatch" };
  if (identity && (state.url !== identity.url || state.accountId !== identity.accountId))
    return { decision: "identity_mismatch" };
  if (!reconstructedInput)
    return { input: structuredClone(materializedInput(state)), decision: "validated" };
  const replay = replayCanonicalInput(
    state,
    reconstructedInput,
    responsesLiteRequestPrefixLength(state.reconstructedRequestInput),
  );
  const result: CanonicalCompactionPromptResult = {
    decision: replay.decision === "compaction" ? "validated" : replay.decision,
  };
  if (replay.input) result.input = replay.input;
  return result;
}

export function canonicalCompactionRequestBody(
  sessionId: string,
  model: string,
  identity: { url: string; accountId: string },
): ResponsesBody | undefined {
  const state = canonicalSessions.get(sessionId);
  if (!state || !matchesLane(state, identity.url, identity.accountId, model)) return undefined;
  const body = structuredClone({ ...state.requestBody, input: [] });
  delete body.previous_response_id;
  return body;
}

export function clearCanonicalSessions(sessionId?: string): void {
  if (sessionId) {
    canonicalSessions.delete(sessionId);
    canonicalSessionLanes.delete(sessionId);
    return;
  }
  canonicalSessions.clear();
  canonicalSessionLanes.clear();
}
