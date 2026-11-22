# Google search through Antigravity

This package adds the `google` family to choco-pi's unified `web_search` tool. The adapter
`google-antigravity.grounding` sends one Cloud Code Assist `v1internal:generateContent` request
with the `googleSearch` tool and turns the response's grounding metadata into an answer, a
source list and citations.

## When it runs

The family is explicit-only. Automatic routing and `provider: "all"` never use it; a search
reaches it only when the request's `provider` (one family or a family list) or
`searchRouting.providers` names `google`. Each call spends the signed-in account's Antigravity
subscription quota, which is subject to Google's Antigravity terms of service, so it is never
chosen on the user's behalf.

The extension registers nothing unless the canonical unified search is active: the
`choco-pi-web-search` core has requested integration and a frontend has registered
`web_search`. There is no standalone search tool. The handshake is read at session start, tree
navigation and model selection, after all extensions have loaded, so the frontend may load
before or after this package. The adapter is present only while the handshake holds and Pi
reports a stored OAuth credential for the `google` provider (`/login google`, then choose
Google Antigravity), re-checked at each of those events, and removed at session shutdown.
Signing in mid-session takes effect at the next of those events.

Availability reads only Pi's auth status for `google`: configured, from a stored credential,
and of OAuth type (`getProviderAuthStatus` plus `isUsingOAuth`). Pi's inherited Gemini API-key
auth also reports `google` as configured (a stored API key, a runtime key or
`GEMINI_API_KEY`); such a provider reads as unavailable, with a message naming the Google
Antigravity login. Availability never resolves the credential, because resolving an OAuth
credential can refresh the token over the network. The credential is resolved and parsed in
`execute`; a missing one, or one that is not the packed OAuth key (a raw Gemini API key the
status snapshot did not yet reflect), is an `auth` error before any request is sent.

## Request

- Endpoint walk, timeouts and error classification come from the package's shared client
  (`src/client/http.ts`): daily-cloudcode-pa first, cloudcode-pa on a network error, 404 or 5xx.
  Each endpoint attempt is bounded at 50 seconds, so both fit inside the router's 120-second
  attempt deadline. A timeout surfaces as a retryable `network` error.
- Envelope: `project` from the credential, an agy-shaped `requestId`, `model`,
  `userAgent: "antigravity"`, `requestType: "agent"`, and a `request` with one user turn, the
  `googleSearch` tool and `generationConfig.maxOutputTokens`. No `sessionId`, `labels` or
  `systemInstruction`: a search is a one-shot sub-request, and the system-instruction
  acceptance question for non-agy prompts is unresolved, so the short directive goes into the
  user turn.
- Model: the first id in the refreshed catalog's `webSearchModelIds`, otherwise
  `gemini-3.5-flash-lite` (the value in the captured agy 1.5.14 `fetchAvailableModels`).
- Filters, expressed through `Tool.GoogleSearch` fields from the descriptor: allowed domains
  become `includedDomains`, excluded (`-domain`) become `excludeDomains`, and `recency_filter` or
  `recency_days` become `timeRangeFilter {startTime, endTime}` ending now. `num_results` caps the
  returned results.
- Not advertised: `url` (the canonical contract defines it as a URL open, not URL context for a
  search, so `urlContext` is not sent), `open`/`click`/`find`, images, country, language, safe
  search and pagination.

## Response

The validated response's first candidate supplies the answer from its non-thought text parts.
Each `groundingChunks[].web` with an http(s) `uri` becomes a numbered result (deduplicated by
URL; title falls back to the domain, then the host). Each `groundingSupports[]` entry with
segment text and chunk indices becomes a citation: the segment text is located in the answer
and `[n]` markers are placed after it, and the segment also becomes the cited results'
snippet. A `Sources:` list closes the answer. `native` carries the model, `webSearchQueries`
and the citation list.

Grounding URLs are returned exactly as given (they are usually
`vertexaisearch.cloud.google.com/grounding-api-redirect/...` links). The adapter follows no
redirect, fetches no title and makes no HTTP request other than `generateContent`, so the
web-access fetch path and its SSRF policy remain the only way a page is read.

An answer without grounding metadata is returned with a warning. A response with no
candidates (`promptFeedback.blockReason`) or with neither text nor sources is an
`invalid-response` error.

## Errors

Classified `AntigravityError` kinds map onto the router's kinds:

| Antigravity kind                                                       | Router kind      | Retryable |
| ---------------------------------------------------------------------- | ---------------- | --------- |
| quota_exhausted, credits_exhausted                                     | quota            | no        |
| rate_limited                                                           | quota            | yes       |
| capacity, server                                                       | transient        | yes       |
| network                                                                | network          | yes       |
| auth                                                                   | auth             | no        |
| permission, validation_required, unsupported_client, model_unavailable | entitlement      | no        |
| invalid_request, context_overflow                                      | invalid-request  | no        |
| malformed_response                                                     | invalid-response | yes       |

Messages are the client's sanitized `formatAntigravityErrorMessage` lines and carry no token
or account identifier. Caller cancellation aborts the in-flight request; a session change
during the request is `stale-context`.

## Unproven assumptions

No search request or response was captured from agy, and no live call has been made. These
points rest on the protobuf descriptors and the agy binary strings only, and need a live
check (plan step O5):

1. The response shape. `tests/fixtures/search/grounding-response.json` is synthetic, built
   from the aiplatform `GroundingMetadata`, `GroundingChunk.Web`, `GroundingSupport` and
   `Segment` descriptors in proto3 JSON naming, inside the v1internal `GenerateContentResponse`
   wrapper.
2. That consumer credentials may call non-streaming `v1internal:generateContent` (agy's chat
   traffic used `streamGenerateContent`) and that the backend accepts this envelope without
   `labels` or `sessionId`.
3. That `includedDomains`, `excludeDomains` and `timeRangeFilter` are honored rather than
   rejected or ignored for this account type. A rejection surfaces as `invalid-request`.
4. Segment offsets are not used, because whether they count bytes or UTF-16 units is unproven;
   segment text is matched instead, and a segment that cannot be located gets no marker.
5. The catalog's `webSearchModelIds` is read from module state set by the provider extension's
   model refresh. If Pi loads the two extensions as separate module instances, the adapter
   sees the offline catalog and uses the `gemini-3.5-flash-lite` fallback.

## Deferred

URL reading through `fetchFromTrawlerCache`, `rewriteUri` redirect resolution, image search,
and enterprise grounding (`enterpriseWebSearch`) are not implemented.
