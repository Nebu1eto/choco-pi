# Vendored: @aliou/pi-synthetic

This directory is a **vendored, patched copy** of the upstream open-source
package **@aliou/pi-synthetic**. This is not the original source repository.

- Original source code: https://github.com/aliou/pi-synthetic
- Package on npm: https://www.npmjs.com/package/@aliou/pi-synthetic
- Base version: `0.24.3` (upstream commit `3a66c5b`, `@aliou/pi-synthetic@0.24.3`)
- License: MIT (see `package.json` in upstream)
- Runtime deps vendored under `node_modules/@aliou/`: `pi-utils-settings@0.15.1`,
  `pi-utils-ui@0.4.1` (same author, same upstream organization)
- Local identity: the directory and manifest name are
  `choco-pi-provider-synthetic` at version `0.1.0`, matching this harness's
  package naming, and the outbound `X-Title` header reports
  `@choco-pi/provider-synthetic`. Upstream provenance above is unchanged.

## choco-pi patch: reasoning effort from the Synthetic API

Upstream `0.24.3` hardcodes per-model `thinkingLevelMap` overrides in
`extensions/provider/models.ts` (e.g. Kimi-K3 was limited to `off/high/max`)
and lets these static maps win over live API data. As a result, the Pi effort
picker only showed `off`, `high`, `max` for `hf:moonshotai/Kimi-K3` — and the
`off` level itself was wrong (Kimi K3 always reasons; upstream rejects
`reasoning_effort: "none"`).

The Synthetic models API (`https://api.synthetic.new/openai/v1/models`)
already declares supported efforts per model via
`reasoning_parameters.efforts` (Kimi-K3: `["low","high","max"]`). This patch:

1. Adds `reasoning_parameters` to `SyntheticApiModel` (`src/client/types.ts`).
2. Adds `buildThinkingLevelMapFromApiEfforts()` in
   `extensions/provider/models.ts` and applies it in the API/store model
   builders, so live API declarations win over static maps. `"none"` maps to
   Pi's `off` level; levels the API does not list are hidden; when `"none"` is
   not accepted (Kimi-K3), `off` itself is hidden instead of sending an
   invalid value upstream. Static maps remain as the offline fallback.
3. Aligns every static `thinkingLevelMap` in the catalog with the efforts the
   live API currently declares (Kimi-K3 → `low/high/max`; GLM, Qwen, Nemotron
   → `off/low/medium/high`; gpt-oss → `off/low/medium/high`).
4. Adds regression tests in `extensions/provider/models.test.ts`, including a
   live parity check between the static catalog and the API's declared efforts.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (153 tests) — run
against an upstream checkout at commit `3a66c5b` with this patch applied.

## choco-pi patch: extension entry load time

The six Pi extension entries run under separate uncached jiti loaders. Five
entries now keep their registration modules small and load their existing
runtime implementation through a memoized dynamic `.ts` import. The provider
entry keeps only the model catalog needed to preserve synchronous provider
registration; its config, quota store, settings, and event machinery move to
the deferred runtime, while API clients load only when model or quota refresh
runs. The provider publishes its validated config snapshot through
`Symbol.for("choco-pi.provider-synthetic.config-state")`, so later entries do
not reload the config/client graph under their separate jiti instances. The
quotas command similarly defers its client and TUI implementation until
invocation.

This is a load-time-only change. Provider, tool, command, schema, and event
identities are unchanged, as are activation and event-handler ordering. The
sub-bar entry remains eager because its exported synchronous registration and
first event-driven render path must stay immediately available.

## choco-pi divergence: devDependency `typebox` version bump

The harness-wide typebox alignment (Wave 1 of the schema-validation migration)
bumped this package's `devDependencies.typebox` from `^1.1.37` to `^1.3.29` to
match the single latest line used across the repository. `peerDependencies.typebox`
remains `"*"` (unchanged) since this package accepts any host-provided typebox.
Upstream `@aliou/pi-synthetic@0.24.3` pins `^1.1.37`; this divergence is local
to the choco-pi vendored copy only.

## How this copy is used

`.pi/settings.json` references it as a local Pi package (`./packages/pi-synthetic`,
resolved against this `.pi` directory), replacing the former
`npm:@aliou/pi-synthetic` entry. The same replacement applies to the
user-scope `~/.pi/agent/settings.json`.

## Updating

Re-clone `https://github.com/aliou/pi-synthetic` and check whether the new
release already consumes `reasoning_parameters.efforts`; if it does, drop this
vendored copy and switch the settings entries back to
`npm:@aliou/pi-synthetic@<version>`. If not, re-apply the patch above and
re-run the upstream test suite (`pnpm install && pnpm test`).

## Prefix-stable web-search entitlement

The web-search extension now consults the process-wide
`Symbol.for("choco-pi.prefix.locked")` contract before changing active tools.
A subscription entitlement resolved after the first provider request does not
rewrite that session's tool prefix. Each `session_start` resets entitlement to
unknown and rechecks it for the new session. The lock-gated activation decision
lives in a dependency-free module so strip-only Node tests do not load the TUI
dependency graph.

## Unified web-search backend extraction

The Synthetic `/v2/search` transport now exposes a session-owned backend for
the harness's unified web-search registry. It resolves Synthetic credentials
independently of the selected model, supports authenticated direct and proxy
calls plus explicitly unauthenticated proxies, and performs the subscription
eligibility check lazily on the same credential-bound client used for each
search. Canonical availability caches that check by configuration revision and
credential identity, reports PAYG accounts as unavailable, and prevents auto
routing from selecting them. PAYG accounts remain ineligible and are never
auto-enabled.

The extracted backend has no process-global config, credential, entitlement,
or client cache. Cancellation and lifecycle invalidation are checked around
every asynchronous boundary. Safe typed failures preserve auth, quota,
network, request, abort, and stale categories without including API keys,
proxy secrets, or provider response bodies. Reachable client modules use
explicit `.ts` relative imports so native strip-types tests can load the
production adapter boundary.

The package test command runs the upstream Vitest suites under `extensions`
and `src`, then runs the native `node:test` integration suites under `tests`.
This preserves both runner styles without making Vitest reject native suites as
files with no tests.

The historical standalone `synthetic_web_search` registration and rendering
remain available when this extension runs without the canonical core. When the
core marker is already present, the extension instead registers only adapter
`synthetic.search` (family `synthetic`, transport `synthetic-v2-search`) in the
event-bus-rendezvoused session scope. Registration performs no quota network
request. The adapter resolves credentials from Synthetic's registry entry,
never from the selected conversation model, and returns result-only core
responses with no fabricated answer. It enforces `numResults` locally and
preserves the 20KB shared/4KB per-result excerpt bounds with explicit warnings.

If the canonical marker arrives after standalone registration, Pi's extension
API cannot unregister the already-defined tool. Session-start and config-update
paths permanently keep it inactive and perform no further entitlement refresh;
the unified tool discovery layer is responsible for filtering that legacy
definition in this reversed load order.

## Vendored install policy

This package declares the repository pnpm toolchain (`pnpm@11.11.0`) and an
isolated one-package workspace boundary. The installer-policy change originally
preserved SDK overrides (subsequently aligned to `0.86.1` below) plus the
repository's `typebox@1.3.29` release-age exception. The
legacy manifest-level pnpm override block was moved here because pnpm 11 reads
workspace-root overrides. This is installer configuration only; it does not
migrate or change the package's Pi SDK compatibility.

## Pi SDK target alignment

Host-provided Pi SDK peer contracts and any development SDK dependencies now
require exactly `1.0.4`, matching the harness target. Package-local frozen
locks resolve that release, with release-age exceptions
limited to the six exact SDK/chord/telemetry `0.87.1` packages and the existing
`typebox@1.3.29` exception. This SDK alignment is separate from the pnpm 11
installer-policy change; unrelated dependency contracts are unchanged.

## 2026-09-21 choco-pi patch: Pi 0.86.1 transcript migration

The fallback and override catalog was refreshed from the live Synthetic API.
GLM-5.3-Flash replaces GLM-5.2, Qwen3.8-27B replaces Qwen3.6-27B, and
DeepSeek-V4.1-Flash is added. The catalog now records the API's current effort
levels, including `xhigh`, together with current prices, input modalities,
context windows, and output limits.

Observed by direct `chat/completions` API probes on 2026-09-21:
`hf:zai-org/GLM-5.3-Flash` with `reasoning_effort=low` returned no response
within 240 seconds for `Reply with the single word PONG` at
`max_tokens=65536`; at `max_tokens=4096` it ended with
`finish_reason=length`, 4,100 reasoning tokens, and empty content; and `What is
17*23?` at `max_tokens=65536` ended with `finish_reason=stop`, 250 reasoning
tokens, and empty content. The same PONG probe at `high` and `max_tokens=4096`
returned `PONG` with 33 reasoning tokens. `low` is therefore intentionally
hidden even though the live API declares it. To re-enable it, set the static
map entry back to `low: "low"`, remove the matching entry from
`THINKING_LEVEL_MAP_OVERRIDES`, and restore exact live-catalog parity in the
model test.

## 2026-09-23 choco-pi patch: oxlint and oxfmt replace Biome

Biome and `@aliou/biome-plugins` are removed. `lint` runs `oxlint`, `format`
runs `oxfmt .`, and the new `fmt:check` runs `oxfmt --check .`; both tools are
exact devDependencies matching the harness root (`oxlint@1.79.0`,
`oxfmt@0.64.0`) and resolve the root `oxlint.config.ts` and `.oxfmtrc.json`,
including the anti-slop rules. `AGENTS.md` and `README.md` name the new tools.

## choco-pi patch: Synthetic 429 quota refresh

`extensions/provider/runtime.ts` calls `requestQuotas(pi)` for a synthetic assistant
`message_end` error whose message starts with `429`, before context-overflow handling.
This refreshes quota state after a provider usage limit. Validation: root `pnpm lint`,
`pnpm fmt:check`, and `pnpm typecheck`.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4

Pi SDK peer and development pins move from `0.87.1` to exactly `1.0.4`,
matching the harness target. Other dependency contracts are unchanged.

The package workspace release-age exceptions now list eight exact
`@earendil-works/*@1.0.4` packages and the existing `typebox@1.3.29` exception.
`@earendil-works/pi-codemode@1.0.4` and `@earendil-works/pi-mcp@1.0.4` now appear
in the frozen lock as transitive dependencies of `pi-coding-agent`.

The workspace `overrides` for `pi-ai` and `pi-tui` move to `1.0.4`. The vendored
`@aliou/pi-utils-settings@0.15.1` and `@aliou/pi-utils-ui@0.4.1` declare a
`pi-coding-agent` peer of `>=0.74.0 <1`, so `pnpm peers check` reports them as
unmet against `1.0.4`.

## 2026-10-07 choco-pi patch: Pi 1.0.4 chat model config type

Pi 1.0.4 turns `ProviderModelConfig` into the union of chat, image, and
classifier members. `reasoning`, `thinkingLevelMap`, `compat`,
`contextWindow`, and `maxTokens` now exist only on the chat member, which the
package root does not export by name. `extensions/provider/models.ts` now
derives `SyntheticModel` from
`Extract<ProviderModelConfig, { type?: "chat" }>` and still omits `api` and
`compat`. Built models still omit `type`, and Pi normalizes a missing `type`
to `"chat"`. Their arrays and the `refreshModels` result are assignable to
`ProviderModelConfig[]` without casts. Runtime objects and persisted store
entries are unchanged.

The vendored `@aliou/pi-utils-settings@0.15.1` and `@aliou/pi-utils-ui@0.4.1`
still declare a `pi-coding-agent` peer of `>=0.74.0 <1` and remain unmet
peers against `1.0.4`. `extensions/provider/**` does not import either
package. `src/config.ts` imports the settings package, and
`extensions/web-search/tool.ts` imports the UI package. pnpm resolves both
packages to the single `pi-coding-agent@1.0.4` and `pi-tui@1.0.4` install, so
the packages share one Pi instance. Every runtime value they import exists in
`1.0.4`: `getAgentDir` and `getSettingsListTheme` from `pi-coding-agent`, and
`Key`, `matchesKey`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`,
`Input`, `fuzzyFilter`, `Text`, `TruncatedText`, `Spacer`, and
`getKeybindings` from `pi-tui`. Package `tsc`, which also checks their
TypeScript sources, reports no errors. No break is known, but nothing exercises
the settings or tool-render UI end to end against `1.0.4`.

## 2026-10-07 choco-pi patch: GLM-5.3 static catalog entry

Synthetic now serves `hf:zai-org/GLM-5.3`. `extensions/provider/models.ts`
adds it to the static `SYNTHETIC_MODELS` fallback next to GLM-5.3-Flash, with
values from the live models API: text input, 524288-token context, 65536
maximum output tokens, and $1.40 input, $4.40 output, $0.26 cache-read, and $0
cache-write per million tokens. Its `thinkingLevelMap` exposes the advertised
`high` and `max` efforts and hides `off` and the advertised `low`.

As with GLM-5.3-Flash, `low` is hidden in the static entry and through a
`THINKING_LEVEL_MAP_OVERRIDES` entry that also applies to live and cached
catalogs. Observed in a Pi 1.0.4 session on 2026-10-07 against
`synthetic/hf:zai-org/GLM-5.3` with the prompt `Reply with exactly:
GLM_OK_<n>`: at `reasoning_effort=low`, all five attempts failed. Failures
included reasoning with no visible text (14 s and 928 tokens; 66 s and 4.0k
tokens) and reasoning that continued until aborted (4 min 20 s and 16k tokens;
13 min 57 s and 17k tokens). At `high` (3 s) and `max` (1 s) the model
answered correctly. Network was healthy; a separate connection-error burst was
excluded. To re-enable `low`, set the static entry back to `low: "low"`,
remove the override, and update the test special cases. The live refresh
already discovered the model; this entry updates the offline fallback, the
override, and the live parity test.
