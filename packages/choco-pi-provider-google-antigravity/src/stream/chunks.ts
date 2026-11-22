import type { JsonValue } from "@earendil-works/pi-ai";
import {
  arr,
  bool,
  compile,
  map,
  nul,
  num,
  obj,
  opt,
  recursive,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import {
  RpcErrorSchema,
  antigravityErrorFromRpc,
  antigravityMalformedResponse,
} from "../errors.ts";

const JsonValueSchema = recursive<JsonValue>("AntigravityJsonValue", (self) =>
  union([nul(), bool(), num(), str(), arr(self), map(self)]),
);

const FunctionCallSchema = obj(
  { name: str(), args: opt(map(JsonValueSchema)), id: opt(str()) },
  { open: true },
);

/** google.ai Part as JSON: only the members this transport reads are declared. */
const PartSchema = obj(
  {
    text: opt(str()),
    thought: opt(bool()),
    thoughtSignature: opt(str()),
    functionCall: opt(FunctionCallSchema),
  },
  { open: true },
);

const CandidateSchema = obj(
  {
    content: opt(obj({ role: opt(str()), parts: opt(arr(PartSchema)) }, { open: true })),
    finishReason: opt(str()),
  },
  { open: true },
);

const UsageMetadataSchema = obj(
  {
    promptTokenCount: opt(num()),
    candidatesTokenCount: opt(num()),
    thoughtsTokenCount: opt(num()),
    cachedContentTokenCount: opt(num()),
    totalTokenCount: opt(num()),
  },
  { open: true },
);

const ResponseSchema = obj(
  {
    candidates: opt(arr(CandidateSchema)),
    usageMetadata: opt(UsageMetadataSchema),
    modelVersion: opt(str()),
    responseId: opt(str()),
  },
  { open: true },
);

const WrappedSchema = obj(
  { response: ResponseSchema, traceId: opt(str()), metadata: opt(unknown()) },
  { open: true },
);
const ErrorChunkSchema = obj({ error: RpcErrorSchema }, { open: true });
const KeyedSchema = obj(
  { response: opt(unknown()), error: opt(unknown()), candidates: opt(unknown()) },
  { open: true },
);

const isWrapped = compile(WrappedSchema).check;
const isErrorChunk = compile(ErrorChunkSchema).check;
const isBare = compile(ResponseSchema).check;
const isKeyed = compile(KeyedSchema).check;

export type StreamPart = Static<typeof PartSchema>;
export type StreamResponse = Static<typeof ResponseSchema>;
export type StreamUsageMetadata = Static<typeof UsageMetadataSchema>;
type KeyedValue = Static<typeof KeyedSchema>;

function classify(value: KeyedValue): StreamResponse {
  if (value.error !== undefined) {
    if (isErrorChunk(value)) throw antigravityErrorFromRpc(value.error);
    throw antigravityMalformedResponse("stream error event does not match google.rpc.Status");
  }
  if (value.response !== undefined) {
    if (isWrapped(value)) return value.response;
    throw antigravityMalformedResponse("stream event response does not match the schema");
  }
  if (isBare(value) && (value.candidates !== undefined || value.usageMetadata !== undefined)) {
    return value;
  }
  throw antigravityMalformedResponse("stream event has neither a response nor an error");
}

/**
 * Classifies one decoded SSE data payload: a streamed response (wrapped in `{response}` as
 * v1internal sends it, or bare as the public Gemini API does), or an in-stream google.rpc
 * error, which is thrown as its AntigravityError. Anything else is malformed_response.
 */
export function parseStreamChunk(data: string): StreamResponse {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw antigravityMalformedResponse("stream event data is not JSON");
  }
  if (!isKeyed(value)) throw antigravityMalformedResponse("stream event is not a JSON object");
  return classify(value);
}

/**
 * A whole non-SSE 2xx body: a google.rpc error envelope (thrown), one response, or a JSON array
 * of responses. Anything else is malformed_response.
 */
export function parseJsonBody(text: string): StreamResponse[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw antigravityMalformedResponse("response body is neither SSE nor JSON");
  }
  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isKeyed(item)) throw antigravityMalformedResponse("response body is not a JSON object");
    return classify(item);
  });
}
