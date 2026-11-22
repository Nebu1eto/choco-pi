# Google Antigravity transport

`src/stream/` implements the provider-level `streamSimple`. Pi 1.6 routes both `stream()` and
`streamSimple()` calls for this provider through it, so it accepts both option shapes:
`reasoning` (simple) and the Gemini adapter's `thinking` / `toolChoice` (read through a schema, not a
cast). The source of truth for the wire format is one captured agy request and response
(`streamGenerateContent`, agy 1.5.14). The redacted copies are
`tests/fixtures/stream/capture-request.json` and `capture-response.sse`.

| File             | Role                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `index.ts`       | Entry point: HTTP, watchdogs, abort, retry, settling the event stream |
| `request.ts`     | Envelope builder                                                      |
| `identity.ts`    | Deterministic conversation identifiers                                |
| `sse.ts`         | text/event-stream framing                                             |
| `chunks.ts`      | pi-schema validation of each chunk, in-stream and HTTP-200 errors     |
| `accumulator.ts` | Parts to Pi events, signatures, stop reason, usage and cost           |

## Envelope

`POST {baseUrl}/v1internal:streamGenerateContent?alt=sse`, with the headers from
`antigravityHeaders`: Bearer token, agy User-Agent, JSON content type. Caller and model headers
may add headers but cannot replace `Authorization`, `User-Agent`, `Content-Type` or `Host`. Only
the model's base URL is used: no endpoint fallback and no model-tier switching.

```text
{ project,                        // from the stored credential (aicode-consumers for consumer OAuth)
  requestId: "agent/<conversation>/<unix ms>/<trajectory>/<step + 1>",
  request: {
    contents,                     // pi-ai convertMessages, unchanged
    systemInstruction: { role: "user", parts: [{ text }] },   // getCurrentSystemPrompt
    tools,                        // pi-ai convertTools over getCurrentTools
    toolConfig?,                  // only when Pi asks for a non-default tool choice
    labels,
    generationConfig: { maxOutputTokens, temperature?, thinkingConfig },
    sessionId },
  model: <runtime id>,            // resolveRuntimeModel, e.g. gemini-3.8-flash-low
  userAgent: "antigravity",
  requestType: "agent" }
```

- Prompts are not rewritten and no identity text is injected. The system prompt is sent as
  `systemInstruction`, as agy does. For a live comparison,
  `CHOCO_PI_ANTIGRAVITY_SYSTEM_PROMPT_PLACEMENT=first_user_turn` (in `options.env` or the process
  environment) prepends it to the first user turn instead. It is off by default.
- Tools: every family gets JSON Schema (`parametersJsonSchema`) through pi-ai's
  `convertTools(tools, false, strict)`, with strict sampling only on Gemini 3+ (see "Tool schemas,
  measured"). Tool-call ids follow pi-ai's `requiresToolCallId`, based on the base model id.
- `generationConfig.maxOutputTokens` is the catalog variant's cap, lowered to `options.maxTokens` and
  to Pi's context clamp. `thinkingConfig` is the catalog variant's (`includeThoughts` is true unless
  the level is off).
- Thinking level: `reasoning` is clamped with Pi's `clampThinkingLevel`. `thinking.enabled: false`
  or no level means off: the lowest variant, without thought summaries. `thinking` with only
  `budgetTokens` has no level equivalent and maps to the highest supported level.
- `labels` carry only values this client has: `cascade_id` and `root_cascade_id` (the
  conversation id), `trajectory_id`, `request_id` = `<trajectory>-<step>`, `last_step_index` (the
  number of assistant turns so far), `model_enum` (only when the refreshed catalog supplied
  one), and the `used_claude`, `used_claude_conservative` and `used_non_gemini_model` flags (from
  the current model and the models of earlier assistant turns). No execution ids are invented.
- `options.onPayload` sees the envelope. A non-undefined return value is sent instead.
  `options.onResponse` runs after the headers arrive and before the body is read.

## Tool schemas, measured

Probed live on 2026-11-22, one tool per `generateContent` request with `maxOutputTokens` 16:

- Claude (`claude-sonnet-5-5-low`) through the OpenAPI `parameters` field: v1internal parses it as
  `google.cloud.aiplatform.master.Schema`, so a JSON Schema key with no field there (`const`)
  fails with HTTP 400 `Unknown name ... Cannot find field`. Reduced to that message's fields, any
  schema containing `anyOf` is still rejected by Anthropic after Google translates it
  (`tools.N.custom.input_schema: JSON schema is invalid`), for scalar, object and single-branch
  unions alike.
- Claude through `parametersJsonSchema`: all 102 tool schemas the default choco-pi profile
  registers pass, including choco-pi-agent-browser's `agent_browser` with its
  `const`-discriminated `qa` and `electron` unions.
- GPT-OSS (`gpt-oss-120b-medium`): both fields accept every probed case.

The transport therefore sends `parametersJsonSchema` for every family. agy itself sends OpenAPI
`parameters` with uppercase types; its own tool schemas contain no unions.

## Identity

`identity.ts` derives three values from Pi's `options.sessionId` with SHA-256 under distinct
labels:

- the conversation UUID (agy's cascade id),
- the trajectory UUID,
- `request.sessionId`, a signed 64-bit decimal like the capture's.

The values are identical across turns and transport retries of one Pi session and differ
between sessions, so server-side session state and caching see one conversation. A request
without a Pi session id uses a seed that is random per process. The user's session id is not
sent, only its digests.

## Thought signatures

- Responses: `isThinkingPart` separates thought text from answer text. Consecutive parts of
  one kind extend one block. `retainThoughtSignature` keeps the last non-empty signature. A part
  that carries a different signature from the open block starts a new block, so no signature
  is overwritten. A signature-only empty part (agy's final chunk is `{"thoughtSignature": …,
"text": ""}`) is kept on the text block or as an empty block, because Gemini expects it
  echoed back. A `functionCall` part's signature is stored on the ToolCall.
- Replay: assistant messages carry provider `google`, api `model.api`
  (`google-generative-ai`), and model = the base id (e.g. `gemini-3.8-flash`, not the runtime
  variant). pi-ai's `transformMessages` replays signatures and thinking only when all three
  match the target model. A turn from another model or provider loses its signatures and
  thinking, and its tool calls stay. A thinking-level change keeps the base id, so signatures
  survive it.
- Compaction: a retained tail that begins with a signed model `functionCall` turn after the
  summary's user turn replays with its signatures. pi-ai's transform synthesizes a result for
  any unanswered call, so no `functionCall` is orphaned (tests/stream-replay.test.ts).

## Responses and errors

- SSE framing follows WHATWG: LF, CR and CRLF line endings (agy sends CRLF), multi-line
  `data`, comments, a final event without a trailing blank line, and a CRLF split across reads.
  Each `data` payload is validated with pi-schema as `{response: …}` (v1internal) or a bare
  GenerateContentResponse.
- An in-stream `{error: google.rpc.Status}`, a non-2xx response, and an HTTP 200 JSON error body
  all go through G1's `AntigravityError` classifiers, and the stream fails with that error's
  formatted message. Pi's `isRetryableAssistantError` and `isContextOverflow` read that message,
  and tests/stream-errors.test.ts asserts both predicates per kind. A chunk that is not JSON or
  does not match the schema fails as `malformed_response`; it is never dropped silently.
- Stop reason: `STOP` → stop, `MAX_TOKENS` → length, any tool call → toolUse. Every other finish
  reason (SAFETY, RECITATION, MALFORMED_FUNCTION_CALL, …) fails as a non-retryable
  `invalid_request` naming the reason, with `rawStopReason` kept. pi-ai's `mapStopReason` uses the
  same table but takes the @google/genai enum and throws on unknown values, so the table is
  restated here. A body that ends without a finish reason is a retryable `network` error.
- Abort: `options.signal` reaches fetch, the body reads, and the retry sleep. An abort ends the
  stream once with stopReason `aborted` and keeps any partial content. It is never retried.
- Watchdogs: response headers must arrive within 90 s. The body may not stay silent longer than
  `options.timeoutMs` (Pi's idle timeout), or 300 s by default. Either timeout is a retryable
  `network` error. The body watchdog covers every body: the event stream, a non-2xx error body
  and an HTTP 200 JSON body; a stalled body is cancelled.
- The stream settles exactly once: one terminal `done` or `error` event, then end.

## Retry policy

Pi already retries whole turns that fail with a retryable message, with visible backoff.
Transport retries here are kept small so the two do not multiply:

- Only `capacity`, `rate_limited`, `server` and `network` are retried, and only before any content
  has been emitted, because a retry after partial output would duplicate events.
- Attempts: `options.maxRetries` (default 1), capped at 2.
- Delay: the server's RetryInfo, quota-reset or `Retry-After` delay when present, otherwise
  1 s, then 2 s. A delay over 5 s (or over `options.maxRetryDelayMs`) is not waited out here. The
  error is surfaced at once with its `retry_after_ms` so Pi's visible retry owns the wait.
- `quota_exhausted`, `credits_exhausted`, auth, permission, validation, unsupported-client,
  model-unavailable, invalid-request and context-overflow errors fail immediately. A retry
  resends the same body with the same identifiers.

## Usage mapping

From the last `usageMetadata` seen:

| Pi field      | Source                                       |
| ------------- | -------------------------------------------- |
| `input`       | `promptTokenCount - cachedContentTokenCount` |
| `output`      | `candidatesTokenCount + thoughtsTokenCount`  |
| `cacheRead`   | `cachedContentTokenCount`                    |
| `cacheWrite`  | 0                                            |
| `reasoning`   | `thoughtsTokenCount`                         |
| `totalTokens` | `totalTokenCount`                            |

Cost comes from Pi's `calculateCost` with the model's per-million prices, as pi-ai's Gemini
adapter computes it. Subscription models are registered at zero cost, so cost is normally 0.
`responseModel` is `modelVersion` and `responseId` is `responseId`.

## Unproven assumptions

Everything rests on one capture of one simple Gemini turn, with no tools called and no thought
text. None of the following has been exercised against the live service:

- Tool schemas: see "Tool schemas, measured". Gemini is covered by real turns, Claude and
  GPT-OSS by the probes; multi-turn Claude tool use with thinking is not yet covered.
- Claude and GPT-OSS behind v1internal: the wire shape of their thinking parts, signatures,
  tool-call ids, and finish reasons is inferred from the Gemini schema and the third-party
  extension's behaviour. It has not been observed.
- Label semantics: `last_step_index` as the assistant-turn count and the derived `used_*` flags
  match the capture's format. Their server-side meaning is unknown. `model_enum` is sent only when
  the refreshed catalog provides it.
- Whether the server keys caching or session state on `sessionId` or the labels, and whether a
  stable derived value is what it expects across turns, is unverified.
- `toolChoice: "any"` / `"none"` (toolConfig) is absent from the capture and follows the public API.
- In-stream `{error}` chunks, HTTP 200 JSON errors, `[DONE]` markers, and multi-candidate
  responses have not been seen from this endpoint. They are handled defensively; only the
  first candidate is read.
- Long silent thinking phases may exceed a small `options.timeoutMs` if the backend sends no
  keep-alive chunks while thinking.
