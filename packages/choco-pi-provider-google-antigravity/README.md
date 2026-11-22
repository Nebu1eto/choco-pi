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
Google Antigravity, shows this warning and continues only after you choose to accept it;
declining ends the login before any network request.

## Client identity (a deliberate compatibility choice)

Requests identify as the official agy CLI release this package was built against, version
1.5.14 (`AGY_CLIENT_IDENTITY` in `src/config.ts`):

```text
antigravity/cli/1.5.14 (aidev_client; os_type=<your OS>; arch=<your arch>; cl=1026970498; auth_method=consumer)
```

`os_type` and `arch` are this machine's real values. The login warning names this choice, so
using the provider means you confirmed it. The provider does not rewrite prompts, inject an
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

3. Only when neither is set, and only after you agree at a second prompt: a local scan of the
   installed agy binary (`CHOCO_PI_ANTIGRAVITY_AGY_PATH`, then `agy_path`, then `agy` on
   `PATH`). When the binary holds several candidates you choose one; secrets are shown only by
   their last four characters.

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

## Models

`fetchAvailableModels` is refreshed every four hours (cache-only when offline) and stored in Pi's
models store. Effort-suffixed runtime ids collapse into one Pi model per base id, for example
`gemini-3.8-flash` with low, medium and high; only advertised levels are selectable. A small
fallback list is used until the first refresh.

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

Transport details are in [docs/transport.md](docs/transport.md) and the search family in
[docs/search.md](docs/search.md).

## References

Behavior was derived from captured agy 1.5.14 traffic and its protobuf descriptors, and compared
with pi-antigravity 0.15.0 (Rahularya01/pi-antigravity). No code was copied from either.

## Known gaps

- The agy binary embeds several client ids and secrets with no recorded pairing. Its Go string
  table groups literals by length, so the position of an id or secret says nothing about which
  pair the consumer login uses; candidates keep file order and, when there are several, you pick.
- The wire value for xhigh thinking and Claude thinking parameters are inferred from the catalog,
  not from a captured request.
- Tool schemas go to every family as JSON Schema (`parametersJsonSchema`); the OpenAPI
  `parameters` field rejects unions for Claude (docs/transport.md, measured).
