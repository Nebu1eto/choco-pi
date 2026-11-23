# @choco-pi/provider-google-antigravity

Pi provider `google` (display name "Google"): Google Antigravity models (Gemini, Claude and
GPT-OSS through Cloud Code Assist `v1internal`) on a consumer Google AI subscription, signed in
with OAuth. Model refs are `google/<base model id>`.

## It replaces Pi's built-in `google` provider

Registering `google` with a model list replaces Pi's built-in Gemini API-key `google` provider
and all of its models; this package's provider-level `streamSimple` serves every `google`
model. `GEMINI_API_KEY` is not used. Pi still composes the built-in API-key auth into the
provider, so `/login google` can list an API-key method next to the "Google Antigravity" OAuth
method, and Pi resolves `GEMINI_API_KEY` when no credential is stored (a stored credential,
such as the OAuth sign-in, always wins). This provider accepts only its own packed OAuth key:

- The transport fails a request whose key is anything else (a stored API key or
  `GEMINI_API_KEY`) with a classified `auth` error that names `/login google` and Google
  Antigravity, before any network request and without echoing the key.
- `/usage` lists Google under "Not signed in"; a host that reports API-key auth never has the
  key resolved.
- The Google search adapter reads as unconfigured and is not registered.
- Background compaction token counting skips the model.

To use a Gemini API key instead, remove this package from `packages` and restart.

## Read this first: terms and account risk

Google's Antigravity terms restrict third-party clients on consumer OAuth access, and Google has
suspended accounts used this way. choco-pi is a third-party client. `/login google`, choosing
Google Antigravity, shows this warning above the sign-in instructions. Like agy, login asks no
question: signing in means you accept the risk, and closing the prompt cancels.

## Client identity (a deliberate compatibility choice)

Requests identify as the official agy CLI release this package was built against, version
1.5.14 (`AGY_CLIENT_IDENTITY` in `src/config.ts`):

```text
antigravity/cli/1.5.14 (aidev_client; os_type=<your OS>; arch=<your arch>; cl=1026970498; auth_method=consumer)
```

`os_type` and `arch` are this machine's real values. The login warning names this choice. The
provider does not rewrite prompts, inject an
identity into them, or fold the system prompt into user turns.

## Login and the OAuth client

The repository ships no OAuth client id or secret. Login resolves one in this order:

1. `CHOCO_PI_ANTIGRAVITY_CLIENT_ID` and `CHOCO_PI_ANTIGRAVITY_CLIENT_SECRET`.
2. `<agentDir>/google-antigravity.json`:

   ```json
   {
     "client_id": "...",
     "client_secret": "...",
     "project_id": "optional-own-project",
     "agy_path": "optional"
   }
   ```

3. Only when neither is set: a local scan of the installed agy binary
   (`CHOCO_PI_ANTIGRAVITY_AGY_PATH`, then `agy_path`, then `agy` on `PATH`). agy 1.5.14 holds
   three OAuth clients, each loaded next to its own secret: Business login, consumer login
   (`auth.newBrowserLogin`) and MCP. Login takes the consumer pair, identified by the SHA-256
   digests in `AGY_CONSUMER_CLIENT` (`src/auth/client-credentials.ts`); the values are never
   committed. An agy without that pair fails the login and names the environment variables.

The browser step follows agy 1.5.14's consumer login. It opens
`https://accounts.google.com/o/oauth2/auth` with PKCE (S256), an independent `state`,
`access_type=offline`, `prompt=consent` and the redirect
`https://antigravity.google/oauth-callback`, with the parameters in the order agy prints them.
It requests these scopes, in this order: `cloud-platform`, `userinfo.email`,
`userinfo.profile`, `cclog`, `experimentsandconfigs` and `aicode` (each under
`https://www.googleapis.com/auth/`), then `openid`. Nothing listens on this machine: after you
allow access, the antigravity.google page shows an authorization code, and you paste it at the
one prompt choco-pi shows. Pasting the full redirect URL also works; its `state` must match. The
code is exchanged at `oauth2.googleapis.com/token` with the same redirect and the PKCE verifier,
and is never logged or echoed.

Like agy, login then reads the account email from `https://www.googleapis.com/oauth2/v2/userinfo`.
A failure there does not fail the login. The email is stored in the Pi credential and, hashed,
keys per-account caches such as `/usage`, so the key survives refresh-token rotation;
credentials without one fall back to a hash of the refresh token. Credentials are stored only
through Pi's credential store. Env and config secrets are never persisted and are re-read at
refresh; a pair found in agy is stored in the Pi credential so refresh never rescans the binary.

After sign-in, `loadCodeAssist` returns the project (consumer accounts get the shared
`aicode-consumers`). `onboardUser` runs only when no tier is onboarded yet. A project id is
never invented: without one from Google or your `project_id`, login fails with a clear message.

`/usage` labels the Google row with the paid tier's name from `loadCodeAssist` (else the current
tier's). Google names both consumer Ultra plans "Google AI Ultra", so the tier id adds the size:
`g1-ultra-lite-tier` shows as "Google AI Ultra (5x)" and `g1-ultra-tier` as "Google AI Ultra
(20x)". Every other tier keeps Google's name unchanged.

## Models

`fetchAvailableModels` is refreshed every four hours (cache-only when offline) and stored in Pi's
models store. Effort-suffixed runtime ids collapse into one Pi model per base id, for example
`gemini-3.8-flash` with low, medium and high; only advertised levels are selectable. A small
fallback list is used until the first refresh.

The models-store slot `google` is shared. Pi composes this provider's refresh with the built-in
google provider's pi.dev catalog refresh. The built-in refresh runs first and owns the top-level
`models`, `lastModified`, `etag` and `checkedAt` fields. Both refreshes read one snapshot taken
before either runs, and each write replaces the whole slot. This provider therefore:

- keeps its data under `google_antigravity` (`schema_version` 2, `credential_key`, `checked_at`,
  `catalog`) and judges freshness only by its own `checked_at`;
- persists only after a successful fetch, writing the snapshot's other fields back unchanged next
  to its own key; a cache hit, an offline start or a failed fetch writes nothing;
- reads a version 1 entry, whose timestamp was the shared `checkedAt`, as stale: it serves that
  catalog offline and as the failure fallback, and the first successful online fetch rewrites it
  as version 2.

The two writers settle within two runs. When the built-in refresh downloads a new catalog
(HTTP 200) in the same run as this provider's fetch, this provider's write restores the
snapshot's older built-in fields, so the built-in refresh revalidates on the next run. If that
download drops `google_antigravity`, this provider serves the catalog from that run's snapshot
and fetches again on the following run, merging with the new built-in entry. A revalidation
(HTTP 304) keeps every key. The worst case is two `fetchAvailableModels` calls per four-hour
window instead of one (`tests/catalog.test.ts`, "composed refresh"), and the live catalog is
served on every run.

## Deferred and omitted features

- The Antigravity Orchestrator (every `gemini-pro-orchestrator*` id, such as "Orchestrator
  (Neon)") is intentionally not offered. agy runs it as a client-side plan/execute loop on
  `gemini-4-neon-xhigh` and `gemini-4-hydrogen-xhigh` and never sends the orchestrator id on
  the wire, so a plain model entry would not behave like it. The ids are dropped from refreshed
  catalogs, the fallback list and any catalog persisted before this change.

## Modules

| Module                       | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `src/config.ts`              | Provider id, agy identity and User-Agent, endpoints, config file     |
| `src/errors.ts`              | `AntigravityError`, structured classification, the stable error line |
| `src/client/http.ts`         | `postV1Internal` with endpoint walk and timeouts                     |
| `src/auth/*`                 | OAuth, client credentials, project discovery                         |
| `src/catalog/*`              | Catalog fetch, grouping, refresh, `resolveRuntimeModel`              |
| `src/client/quota.ts`        | `readQuotaSummary`, `readTier`                                       |
| `src/client/count-tokens.ts` | `countAntigravityTokens`                                             |
| `src/compaction/*`           | Background compaction prompt counter and its registration slot       |

Transport details are in [docs/transport.md](docs/transport.md) and the search family in
[docs/search.md](docs/search.md).

The provider entry registers the background compaction prompt counter for `google` on
activation and removes it on `session_shutdown` (again from a later `session_start`), through
the process-global slot `Symbol.for("choco-pi:compaction-token-counters/v1")`; compaction never
imports this package. The counter runs only with `CHOCO_PI_ANTIGRAVITY_COUNT_TOKENS=1`.

## References

Behavior was derived from captured agy 1.5.14 traffic and its protobuf descriptors, and compared
with pi-antigravity 0.15.0 (Rahularya01/pi-antigravity). No code was copied from either.

## Known gaps

- agy discovery recognises only the consumer client of agy 1.5.14. If a later agy rotates it,
  login fails until `AGY_CONSUMER_CLIENT` is updated or the client is set by environment or
  config. The pairing comes from agy's arm64 code: each client id is loaded beside its secret in
  the functions named above.
- Claude thinking parameters (`thinkingLevel` LOW/MEDIUM/HIGH) match captured agy requests for
  Claude Opus 5.5. Claude Sonnet 5.5 was not captured from agy, but live Sonnet requests with
  the same shape succeed, including tool turns.
- Tool schemas go to every family as JSON Schema (`parametersJsonSchema`); the OpenAPI
  `parameters` field rejects unions for Claude (docs/transport.md, measured).
- GPT-OSS 120B answered wrongly after tool results in live sessions although the transport
  assembles its output correctly (docs/transport.md); treat it as the weakest family here.
- `/usage` names the Ultra plan size only for the two tier ids in "Login and the OAuth client";
  any other tier shows Google's own name. The 5x mapping was confirmed on a 5x account; the 20x
  one is inferred (agy knows exactly two consumer Ultra tiers) and has not been seen live.
