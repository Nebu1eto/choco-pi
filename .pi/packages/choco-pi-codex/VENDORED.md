# Vendored: choco-pi-codex

## Codex Fast wire parity (choco-pi addition)

Fast and standard requests follow openai/codex `service_tier_for_request` and
`build_routing_hint_header`: Fast sends `service_tier: "priority"`; standard
omits `service_tier` instead of sending `default`. Every inference request
carries `x-codex-routing-hint: model=<slug>`, adding `;tier=<tier>` only when a
tier is sent. The originator is always `codex_cli_rs`, Codex's own client
identity; the upstream `harnessIdentifierHeader` preference and its
`pi-codex-conversion` originator are removed.

Request identity follows `get_codex_user_agent` and `CodexResponsesMetadata`
(`client-identity.ts`): User-Agent `codex_cli_rs/<ver> (<os> <ver>; <arch>)
<terminal>`, `version: <ver>` (`CODEX_CLIENT_VERSION`, bump with the verified
codex-cli), `x-codex-window-id: <thread>:0`, and an `x-codex-turn-metadata`
subset (ids, window, `request_kind`, model, effort). Window numbers do not track
compaction; installation id, sandbox fields, and the cookie jar are not sent.
Cached WebSocket routes ignore User-Agent like the per-request metadata: its
macOS version is refined asynchronously after startup, so keying it would strand
the first socket. `originator` and `version` remain route-keyed.

## Background compaction (choco-pi addition)

Off by default (`codexNative` in `.pi/extensions/background-compaction.json`).
While off or unbound, the legacy request rewrite, native compaction and
post-compaction reset run exactly as before.

**Lane** (`adapter/compaction/background-v2.ts`). Implements the compaction
package's backend contract through a relative TypeScript import (existing
compaction imports of Codex adapter modules set the precedent); no dependency or
second coordinator. It captures one lineage-validated, deeply frozen canonical
request per snapshot and prepares on a fresh SSE session and prompt cache key,
never touching the foreground canonical cache. Deadline, cancellation,
input/output/result limits, account/model/endpoint incompatibility, an
incomplete terminal response, or anything but exactly one compaction item fail
closed. Failures come from named constructors (`authFailure`,
`rateLimitFailure`, `timeoutFailure`, ...) with named cooldowns (60 s for auth,
unsupported and a 429 without Retry-After; 1 s after a timeout). Version-1
native details persist candidate ID, prefix fingerprint, retention-policy
version and a SHA-256 account scope, never credentials or a plaintext
reinterpretation of encrypted data; legacy details stay readable. The
subscription endpoint rejects `max_output_tokens`, so the output budget is a
result acceptance limit, not a paid-generation cap, and rejected attempts report
no usage.

**Transport** (`providers/openai-codex/{transport-recovery,stream-events,types}.ts`,
`providers/openai-codex-custom-provider.ts`, `adapter/compaction/{remote-v2-client,details-store,types}.ts`):

- The SSE transport honors `options.fetch` and rechecks abort after each await.
- Foreground requests always keep `MAX_SSE_REQUEST_RETRIES` (the SDK always
  passes `maxRetries`); only the background lane with an explicit `maxRetries`
  narrows the request retry budget. The v2 client's stream retries use the
  supplied `maxRetries`, else the previous default.
- A per-call background marker gives the lane a private `CodexTurnState` and
  skips live fast/Daybreak configuration, responses-lite, steering, async-code
  rewriting and the foreground `onPreparedPayload` hook; stale turn-state hints
  are omitted. Before fetch, the provider-finalized body is compared with the
  frozen payload; drift is a typed unsupported result with zero network
  attempts. Captured `access_programs` are unsupported, so no Daybreak grant is
  borrowed or minted.
- The raw mapped-event observer receives detached events and cannot fail
  foreground generation. Frozen-body calls validate the terminal compaction
  count, response ID and exact opaque item; other calls keep legacy validation.
- Structural divergence (behavior-preserving): `createCodexTransportStream` is
  split into named steps (setup, request preparation, retry planning, WebSocket
  and SSE attempts and failure handling, error emission) with calls, awaits and
  side effects in the original order; `runAttempt` and
  `executeRemoteCompactionV2` are split the same way, dropping a loop over a
  one-element transport list. A resync must re-apply these as structure.

**Adoption runtime** (`extension/background-compaction.ts`, `extension/events.ts`).
The backend factory registers at extension load (first registration wins; an
unbound factory reports unsupported). The legal-cut hook serializes only the
frozen prefix with the image policy snapshotted at session start; incomplete
canonical lineage refuses the cut before transport. The adoption consumer
verifies strategy, candidate ID and fingerprint before the guarded install;
duplicate adoption IDs install once and elision epoch/cut state is
session-keyed. Session start, tree and model changes and the host compaction
reset restore compatible committed checkpoints. An account or model mismatch
clears the pending window and disables legacy native replay for that session via
a fresh detached request state, because the legacy rewriter does not check
account or model. A rejected sidecar warns once per session; an incompatible
checkpoint warns once per session and reason, re-armed by a compatible refresh.
Handlers snapshot a generation fence before their first await and drop their
result only when a background binding (or incompatible state) existed then and
the generation has moved, so the fence never gates the legacy path.
`session_before_switch`/`session_before_fork` leave the integration running (the
replacement may be cancelled); `session_shutdown` tears it down. `events.ts`
shares `refreshBackground` (refresh plus generation check) across
`session_start`, `model_select` and `session_tree`, and `activateAdapter` for
the `session_start`/`model_select` tail. Settings and owner identity use the
compaction package's exports; the adoption signal is read through its validated
process-global symbol. Without a child-owner binding, preparation is refused.

Tests: `tests/background-compaction-{v2-preparation,v2-transport,adoption-runtime}.test.ts`
use fake SSE/WebSocket transports, `InMemoryCredentialStore`, synthetic opaque
placeholders and a throwing global-fetch guard; no live behavior is inferred
from them. `tests/context-elision.test.ts` runs every handler registered for an
event and covers a cancelled switch followed by the unchanged legacy request
rewrite.

## Daybreak Auto preference (choco-pi addition)

Daybreak request state accepts `"auto"` alongside existing booleans. Auto uses
the existing account and model lookups but requires a confirmed Blue/Red grant
before adding `access_programs`; denial and lookup failure remain inactive.
Explicit On retains its best-effort behavior. Request ownership, revisions,
model-support gates, and finalizer validation remain unchanged. Decision tests
cover Auto grants, denial, failure, unsupported models, and On compatibility.

This directory is a **vendored, renamed, stripped fork** of the upstream
open-source package **@howaboua/pi-codex-conversion**. This is not the original
source repository.

- Original source code: <https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion>
- Package on npm: <https://www.npmjs.com/package/@howaboua/pi-codex-conversion>
- Base version: `3.0.18`
- Base artifact: `howaboua-pi-codex-conversion-3.0.18.tgz`, `dist.shasum`
  `a8443f5b6aec92ab9408f01f1622951db05644e9` (registry value, confirmed against
  `shasum -a 1` of the downloaded tarball)
- Forked on: 2026-08-20
- License: MIT (upstream `LICENSE` copied verbatim)
- Compile baseline: `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`,
  `pi-agent-core` at `0.84.2` — the same pin upstream declares as
  devDependencies in `3.0.18`

Upstream ships ~114 MB (≈68 MB `src/tools/*/bin` Rust binaries, ≈44 MB
`src/voice`). The fork keeps only the TypeScript source of the retained feature
set: `src/` is ~1.3 MB across 178 modules, all reachable from the three entry
points (`src/index.ts`, `src/code-mode-preflight.ts`,
`src/apply-patch-display.ts`) with zero orphans and zero dangling imports.
Upstream's built `dist/` entry is replaced by loading `src/index.ts` directly
(`pi.extensions: ["./src/index.ts"]`); upstream's `./changelog.ts` extension is
not carried over.

## Kept

- **OpenAI server-side compaction** — `src/adapter/compaction/**` intact, plus
  the full surrounding graph: `providers/openai-codex/**`,
  `providers/openai-responses/**`, `adapter/{activation,prompt,replay}/**`,
  `adapter/{provider-request,request-options,tool-support,codex-tool-provider,active-tools,local-version-warning}.ts`,
  `shell/**`, `prompt/**`, `codex-usage/**`, `diagnostics/**`.
- Tools: `apply_patch`, `web_run`, `imagegen`, `view_image` (+ view-image
  fallback machinery), `exec_command`/`write_stdin` and the exec session
  manager (required by the adapter tool set and Code Mode).
- Code Mode: `adapter/code-mode*.ts`, `tools/code-mode/**` (minus the notebook
  tool), the `code-mode-preflight` interop entry, the code-mode proxy provider,
  and the host installer (downloads the `codex-code-mode-host` binary from
  GitHub releases into the shared agent cache, same as upstream).
- OpenAI websocket options (`forceCachedWebSockets`, cache keepalive, cache
  diagnostics) — `providers/openai-codex/websocket*.ts` intact.
- UI kept because kept features require it: tool renaming / compact-tools
  rendering (`ui/tool-rendering/**`), status line (`ui/status.ts`), the
  `/codex` settings screen (minus the Voice tab), native-compaction entry
  renderers, apply-patch display broker.

## Removed

- `src/voice/**`, `src/realtime-voice.ts`, the voice renderer/controllers, all
  dictation/realtime/LAN-server shortcuts and `/codex voice *` subcommands,
  `ui/settings/config-items-voice.ts` and the Voice settings tab.
- `src/tools/notebook-mode/**`, `tools/code-mode/notebook-tool.ts`, the
  `notebook` execution mode (config value `"notebook"` is silently downgraded
  to `"code"` in `normalizeExecutionMode`).
- `src/ui/background-bash-widget.ts` (background-shell widget and its
  shortcuts) and its Display-tab toggle.
- All bundled native binaries (`src/tools/*/bin/**`, `src/tools/rust`,
  per-tool `rust/` sources) — see "Native binaries" below.
- Upstream `dist/`, `types/`, `changelog.ts`, `scripts/`, `examples/`,
  screenshots.

Cross-session compatibility is preserved: the custom message types that voice
and notebook mode wrote into sessions are inlined verbatim in
`src/adapter/prompt/context-filter.ts`, so replay/compaction of old upstream
sessions still excludes them exactly as before.

## Config

The fork reads **`choco-pi-codex.json`** (`CODEX_CONVERSION_CONFIG_BASENAME`
in `src/adapter/activation/config-store.ts`) instead of
`pi-codex-conversion.json`. **Config-compat decision: silent-ignore.** The
schema in `config.ts` still parses the obsolete upstream keys (`voice.*`,
`ui.backgroundShell*`, `notebook.*`, `executionMode: "notebook"`) so existing
configs keep loading without errors; the features those keys configured no
longer exist, so the values have no effect. Settings-screen writes may re-emit
those keys with defaults; that is harmless.

## Web-search model preference (choco-pi addition)

`src/ui/settings/config-items-tools.ts` uses choco-pi-ui's public SelectList-based
model submenu instead of cycling values. The row displays full
`openai-codex/<id>` values while its existing config-update path strips the
provider and validates the stored bare id with the unchanged
`normalizeWebSearchModel`. Choices remain the static Codex-only model list.

## Native binaries

The fork vendors darwin-arm64 Rust tool binaries (see "Bundled native
binaries" below). `apply_patch`, `web_run`, `imagegen`, and `view_image` need
them at runtime; on other platforms they return the standard recovery error
until `tools.customRustBinariesDir` points at a directory containing them. Fork addition in `src/tools/native/binary.ts`: besides the upstream flat
layout (`<dir>/<exe>`), the custom dir may also use the upstream package tree
layout (`<dir>/<tool>/bin/<platform>-<arch>/<exe>`), so it can point straight
at an installed upstream package's `src/tools` directory. The Code Mode host
binary is unaffected (self-installed into the agent cache).

## Vendored dependencies (`node_modules/`)

Only what the kept import graph uses, copied from the pnpm store resolved for
upstream 3.0.x:

- `openai@6.26.0` (runtime: code-mode proxy provider; types elsewhere)
- `undici@8.10.0`, `proxy-from-env@1.1.0` (websocket transport, host installer)
- `js-tiktoken@1.0.21` + `base64-js@1.5.1` — pruned to the `lite` entry and the
  `o200k_base` rank; `src/adapter/compaction/request-shrink.ts` was patched to
  import `js-tiktoken/lite` + `js-tiktoken/ranks/o200k_base` instead of the
  ~11 MB all-encodings root bundle (equivalent encoder)
- `partial-json@0.1.7` (responses stream parsing)
- `smol-toml@1.7.1` (code-mode custom tools)
- `web-tree-sitter@0.26.12` (pruned: `debug/` build dropped) +
  `tree-sitter-bash@0.25.1` (pruned to `tree-sitter-bash.wasm` + metadata; the
  native prebuilds are unused — `shell/bash.ts` loads only the wasm)
- `pngjs@7.0.0` + `jpeg-js@0.4.4` (pure-JS PNG/JPEG decoders for the ANSI
  half-block image fallback; `pngjs` ships no declarations, so the retained
  synchronous decoder shape is declared locally in `src/types/pngjs.d.ts`)

Dropped upstream dependencies (only used by removed features): `ws`,
`selfsigned` (voice LAN server), `zeromq`, `unzipper` (notebook mode).

## Source changes relative to upstream 3.0.18

Beyond the removals above: `extension/{register,runtime,events,ui,tools}.ts`,
`ui/settings/{command,screen,tabs,config-items,config-items-adapter,config-items-display}.ts`,
`tools/code-mode/{shared-runtime,public-tools}.ts`,
`adapter/activation/{config-store,execution-mode}.ts`,
`adapter/prompt/context-filter.ts`, `adapter/compaction/request-shrink.ts`,
`native-binary-error.ts`, `tools/native/binary.ts`, `src/index.ts`,
`ui/tool-rendering/{media,halfblock-image}.ts`, and image-tool renderers. Wire
and interop identifiers (originator header `pi-codex-conversion`, preflight and
apply-patch-display protocol strings, code-mode host cache path) are kept
verbatim for protocol parity.

`src/providers/openai-codex/model-catalog.ts` only adds models missing from the
host's built-in `openai-codex` catalog (currently the Daybreak entries). The
temporary `gpt-6-astra` registration was removed once pi 0.85.1 shipped the
model in the host catalog (272,000-token Codex context limit, `max` effort).

## Registered-tool bridge (choco-pi addition)

tools/code-mode/registered-tool-bridge.ts exposes every tool Pi has registered
(LSP navigation and diagnostics, the MCP gateway, sub-agent and session
control, goals, browser and web access) inside the code-mode tools namespace.
Pi hands extensions tool schemas but not executable definitions and no event
carries the live session, so the bridge patches ExtensionRunner.prototype the
way .pi/extensions/command-filter.ts does, captures the runner the first time
Pi assembles its tool list, and wraps each definition through the existing
nested-tool adapter. Bridged tools are deferred, so their schemas add no native
prompt cost; tool-source.ts keeps every deferred tool in ALL_TOOLS (not just
custom ones), and custom-tool-prompt.ts catalogs them with bounded summaries
sourced from `promptSnippet` or an eight-word description fallback. Headless
sessions omit computer-use's UI-only tools from both the catalog and callable
bridge. Code mode's
own entry points and the natively wrapped Codex tools stay excluded.
tests/codex-code-mode-bridge.test.ts pins exclusions, usage lines, deferral,
the ALL_TOOLS scope, UI filtering, and catalog entries.

## Transport cleanup bridge (choco-pi addition)

`src/extension/transport-cleanup.ts` publishes the stateless candidate
`{ cleanupOwner }` at
`Symbol.for("choco-pi-codex:transport-cleanup")`. Session owners such as the
subagents package can reclaim transport state without importing this package or
capturing an extension runtime. The implementation in
`src/providers/openai-codex/transport-cleanup.ts` closes both the bare session
lane and its `:cache-keepalive` lane, including their canonical continuation and
SSE-fallback state. Its separate reset helper clears websocket and canonical
state for both lanes while retaining SSE fallback for mid-session resets.
Empty owner ids are inert rather than process-global cleanup requests.

## Runtime batching advice (choco-pi addition)

`tools/code-mode/batching-advice.ts` counts consecutive exec blocks that made at
most one `tools.*` call and, on the fifth (then every tenth), prepends a
`<system-reminder>` block to that call's tool result pointing back at the
injected Composition pattern, tagged the way choco-pi marks its other
out-of-band guidance. Blocks using Promise.all, loops, or several tools.* calls
reset the streak, so only the degenerate single-call habit nudges; the tool
schema, results, and execution path are otherwise untouched, and the nudge is
wired as an optional parameter in tools/code-mode/public-tools.ts.
tests/codex-code-mode-batching.test.ts pins detection, streak/interval policy
and the advisory wording.

Collapsed Code Mode `exec_command` items show only their supplied description;
the expanded trace still shows the complete command source.

Code Mode `exec_command` requires a concise `description`. Collapsed
traces show that intent while sanitizing and bounding display text; command
execution remains unchanged.
An optional first-line `// @description:` pragma supplies the collapsed parent
Code Mode call's intent. Without it, the renderer derives the parent intent from
the first `exec_command` description and suppresses its redundant generic
“Calls” line.

Code Mode prompt routing is owned solely by the generated `<code_mode_tools>`
block: the `exec` description points to that block, and system-prompt composition
removes legacy duplicate guideline lines. Bounded tool workflows default to Code
Mode, while approvals, native artifacts, citations, decision-dependent single
results, and unavailable capabilities stay direct. Capability-aware examples mention only
tools present in the filtered namespace, preserve fulfilled and rejected outcomes,
and never manufacture filesystem or UI capabilities; when exposed, `read_text` is
explicitly identified as an observed-UI-text-by-reference tool, not a filesystem reader. Static shell and mutation
guidance is omitted when the session permission filter removed `bash`, `edit`, or
`write`. Generated tool guidance is enclosed in a bounded owned block and rebuilt
when the root/child tool set changes; unrelated prompt prose and legacy composition
phrases cannot suppress that refresh. The opt-in `tests/code-mode-first.e2e.ts`
probe requires successful manifest-reading `exec` calls and normally stopped final
answers from both the real root and explore child. It records bounded tool counts,
revision stability, and process teardown separately, is excluded from the default
`*.test.ts` suite, and refuses to run without its environment guard.

Injected skill indexes group skill locations by root, render each skill as one
description line capped at twelve words, and keep invocation guidance to two
sentences. Full skill instructions remain in each root's `<name>/SKILL.md`.

The probe's wire decoding lives in `tests/code-mode-probe-events.ts` so it can be
regression-tested offline. Message `content` is modelled as the SDK's real union
(`string | block[]`, per `CustomMessage` in `@earendil-works/pi-coding-agent`);
an array-only contract silently discarded the whole terminal `agent_end` envelope
whenever an extension-injected `custom` message was present, which reported a
settled real run as "root did not settle". `tests/code-mode-probe-events.test.ts`
pins that decoder against a mixed custom-string plus assistant-block envelope and
fails under the array-only contract; probe assertions still require a normally
stopped final assistant message with the exact expected answers and ignore custom
and user payloads. Probe teardown attempts SIGTERM and SIGKILL unconditionally,
retaining only the first cleanup error, and drops its abort listener once the
detached group is confirmed closed.

The probe's teardown branch uses a positive settled-result check; its success
and error actions are unchanged by this test-only readability cleanup.

## Code Mode and edit preflight (choco-pi addition)

`tools/code-mode/source-preflight.ts` parses restricted cells before host execution and scans executable source tokens for unsupported restricted globals. It hard-rejects a `tools.<name>` reference only when the reference is unconditional at the cell's top level and Pi registers the name neither inside nor outside code mode. A separate compile-only `node:vm` `Script` probe detects conflicting same-scope `tools` bindings without executing cell source or transforming it at runtime, so automatic semicolon insertion, loop-scoped lexical declarations, nested functions, property and named function expressions keep their real JavaScript meaning; multiple declarations are covered without rejecting nested expression arrows or notebook-local bindings. Guarded references and real-but-unbridged tool names run to the namespace proxy. String, comment, template text, and regular expression contents are ignored. Notebook cells retain Deno TypeScript capabilities and skip restricted-global and JavaScript-only checks. Command strings and non-zero `exec_command` exits remain runtime data and are not reclassified.

The tools namespace guard supplies close-match and direct-registration guidance at runtime. The registered-tool bridge validates prepared object arguments through Pi's public `validateToolArguments` from `@earendil-works/pi-ai`, so code mode receives the same normalization as a directly registered tool call: optional `null` properties are dropped, coercible scalars are converted, and the executor receives the validator's cloned arguments while the caller's object stays unmodified. Non-object payloads keep the bare TypeBox schema check, preserving freeform inputs and top-level `null` rejection for object-only schemas. Only a validation rejection is translated into a bridge error; any other failure raised by the native validator, such as a structured-clone failure on a schema-valid but non-cloneable member, propagates unchanged and never reaches the executor. Only `undefined` normalizes to an empty object, and only when that object is valid; explicit `null` keeps its schema meaning. Invalid calls return at most three length-bounded `[invalid_arguments]` messages that name the failing instance path (for example `edits.0.oldText`), never the rejected values and never the native validator's `Received arguments:` payload suffix. Bridged tools translate stale `read` offsets, exact-match ambiguity versus stale `edit` context, and missing UI observation state into focused recovery errors. Recovery names only an available filesystem reader or direct `read`; UI recovery names `observe_ui` only when available, and the `read_text` hint remains UI-specific. Filesystem recovery uses asynchronous Node APIs. `apply_patch` accepts only its documented freeform string in Code Mode; its native first-match, `@@` anchor, and fuzzy resolution remain authoritative. Context analysis runs only after the native applier rejects a hunk, when it reports current line counts, anchor-scoped candidate ranges, and exact re-read windows. `tests/code-mode-preflight.test.ts`, `tests/code-mode-bridge-arguments.test.ts`, and focused namespace tests pin these boundaries.

## Codex request-body invariants (choco-pi addition)

`tests/request-body-invariants.test.ts` pins the stable, Unicode-safe clamping
of the session-derived `prompt_cache_key`, deterministic instruction and tool
serialization for identical inputs, and omission of the unproven
`prompt_cache_retention` field on the ChatGPT-backed Codex endpoint. The test
documents existing upstream request behavior; no provider source was changed.

Payload-hook replacements on the custom Codex provider are validated as complete
recursive protocol bodies, including nested objects and arrays, and replace the
original body instead of being spread over it. Responses Lite normalization and
the frozen fast-mode decision still run afterward; focused tests pin transport,
field-removal, and service-tier handling.

## Codex SSE EOF handling (pi 0.85.1 backport)

`src/providers/openai-codex/sse.ts` ports upstream pi issue #9047's fix so EOF
terminates and parses a residual SSE frame even when no final blank line was sent.
The fork's CR/CRLF normalization remains in place before the EOF flush.

## Bundled native binaries (choco-pi addition)

`src/tools/{apply-patch,exec,imagegen,view-image,web-run}/bin/darwin-arm64/`
are the upstream prebuilt Rust binaries for those tools (same tarball provenance;
~10.5 MB). Only darwin-arm64 is vendored; add other platforms the same way or set
`tools.customRustBinariesDir`. The fork's resolver
(`src/tools/native/binary.ts`) finds them automatically when the config is empty.

## Deferred runtime imports (choco-pi addition)

Load-time-only changes defer provider stream processing, websocket connection setup, Code Mode host process support, exec session internals, apply-patch execution, optional image and web tool execution, settings screens, and image codecs until the corresponding provider request, tool call, command, or event handler runs. Registration keeps the same provider, tool and command names, schemas, event channels, descriptions, and `Symbol.for` keys. Public helper exports remain synchronous and load their implementation on first use.

## Isolated Responses protocol prototype (choco-pi addition)

`src/prototype/` adds an explicitly invoked, single-turn experiment for native
Responses steering and one module-owned async synthetic lookup. It uses public
Pi SDK/provider/input APIs only; it neither imports the registered-tool bridge
nor modifies Pi. It is not imported by the package entry points or enabled in
the profile. The live runner defaults to the `choco-pi-dev` checkout and permits
the `choco-pi` checkout only with explicit `--allow-main`; the working directory
must match the script's checkout. It reads an
existing unexpired credential through Pi's public API without refreshing it,
and isolates resources, settings, model cache, and session state. See
`src/prototype/README.md` for commands and limits. Protocol regressions run in
the baseline suite; the real Pi host `.e2e.ts` suite remains opt-in.

## Native Mid-turn Steering and Async Code Mode (choco-pi addition)

The production config and `/preferences` Model tab expose independent Auto
defaults and Off overrides for `openai.midTurnSteering` (label **Mid-turn
Steering**) and `openai.asyncCodeMode` (**Async Code Mode**). The native path is
limited to `gpt-6-astra` Responses WebSocket requests. Other models and SSE keep
their ordinary behavior; Pi's queued steering remains available.

`providers/openai-codex/native-steering.ts` owns a bounded socket inbox across
Pi turns. The public input hook forwards steering without consuming Pi's input;
the next provider call consumes the server's automatic successor, or supplies
required tool outputs without repeating accepted input. Changed input/settings
fall back to an ordinary request on a fresh connection. Cleanup invalidates
ownership synchronously. Diagnostics contain phases, never steering text.

`native-features.ts` marks only direct client-owned `exec` as async. Pi still
dispatches it after normal preflight; no tool runs early from a streaming event.
The actual async call gives Code Mode a 250ms default initial yield, subordinate
to explicit script pragmas and tool-specific yield settings. Existing wait,
termination, and result handling remain authoritative. Hosted programmatic tool
calling is excluded; local Code Mode is not that hosted protocol. Owned state is
shared across loader copies via a versioned global symbol without replacing Pi
methods. No new monkeypatch or credential handling is introduced. See
`NATIVE-FEATURES.md` for behavior, limits, and opt-in live validation.

The native inbox preserves the ordinary transport's zero-timeout semantics and
structured WebSocket close/error classification. Close code 1009 selects SSE
fallback even if it arrives between Pi turns, and a following close event can
refine an earlier generic socket error without dropping received terminal frames.

Native steering now carries a per-submission observer from the public input
hook through acceptance and validated successor consumption. The session-local
`ui/steering-status.ts` widget displays the latest four numbered previews and
their queue/sent/accepted/applied/fallback receipts without modifying Pi history
or its queue. Terminal receipts settle once; session invalidation suppresses
stale UI callbacks. Logging remains optional and contains no steering text.
Focused regressions cover correlation, fallback and lifecycle; opt-in Astra SDK
and dedicated interactive Pi probes cover production UI delivery.
The interactive probe opts out of the automated host's 120-second abort watchdog
so human-paced verification is not interrupted by a test-only timer.

`ui.steeringDeliveryStatus` defaults to false. The Appearance preference
**Show per-submission steering delivery status** enables these receipts independently
of native steering. Disabling it clears displayed receipts and invalidates their
pending callbacks without changing steering delivery or Pi's queue.

Native-steerable response starts now bypass cached `previous_response_id` deltas:
live full-profile and isolated wire probes showed that Astra's cached path fails
thinking-phase successor creation with unsupported `prompt_cache_options`.
Full context preserves prompt-cache identity and native application; pending
successors still use delta validation and normal tool-output continuation. Other
models, Off, and ineligible requests retain existing behavior. Failed successors
reconnect directly instead of retrying an invalidated previous response ID, and
metadata diagnostics include sanitized error codes without raw error messages.
Regression and opt-in live coverage include a thinking steer after a prior turn.

## Native steering pending bridge (choco-pi addition)

"providers/openai-codex/native-steering.ts" adds a read-only
"isNativeSteerPending(owner)" predicate over its existing owner registry, and
"extension/native-steering-bridge.ts" publishes it to sibling extension
packages through the established "Symbol.for" frozen-process-global seam
(mirroring "extension/transport-cleanup.ts"). "register.ts" installs the
bridge beside transport cleanup with one import and one call.
Notification-producing packages can duck-type the slot to hold queued
completions while a native steer is pending, instead of having any queued
message downgrade the user's steer through "hasPendingMessages()". No steering
behavior, history, or Pi internals change; tests cover symbol resolution,
unknown owners, pending transitions, and close cleanup.

## Aged tool-result elision for Codex contexts (choco-pi addition)

"extension/context-elision.ts" plus the "turn_start"/"session_start"/
"session_tree"/"session_compact"/"context" wiring in "extension/events.ts"
optionally replace old tool-result bodies with a bounded head/tail tombstone
when Codex requests are built. Elision is request-only (session JSONL and UI
keep the full transcript), cut advances in 64 KiB character steps and never
regresses, the current and prior turn are never elided, pairing fields
("toolCallId"/"toolName"/"isError"/"details") are preserved, and error or
encrypted results are always retained. The cut persists as a session custom
entry scoped to the current compaction epoch, resets on compaction, and is
inactive outside the adapter runtime. Cut advancement is frozen while a
native steer is pending ("turn_start" recomputes nothing), but the frozen
cut keeps applying to every request — earlier versions additionally skipped
application, which un-elided the history for the steer turn and re-elided it
afterwards, paying two full cache rewrites per steer. Server-cache economy
holds because cuts advance discretely at turn boundaries and continuation
baselines are recorded from the already-elided request body. "turn_start"
fires before the new user message persists, so the cut conservatively
reflects the previous completed branch at that moment.

## WebSocket transport probe registry (choco-pi addition)

"src/diagnostics/transport-probe-registry.ts" owns an additive, optional
"Symbol.for(\"choco-pi.transport-probe\")" registry slot so the root
cache-probe extension can observe what Codex WebSocket requests actually
transmit without the package importing the extension. "websocket-stream.ts"
synchronously publishes one record per provider send — continuation
decision, previous-response-id flag, native-steering flag, and full/sent
input item counts — immediately before "socket.send", wrapped so a publish
failure can never affect the request path; automatic staging sends nothing.
With no consumer the slot stays unset and the hot path is a single
existence check. The producer registry validates records with TypeBox `Check`
at its publish boundary. The in-process consumer trusts that publisher shape
and matches by stream and request ID, additionally requiring the probe
instance when one is present. Unmatchable observations are honestly marked
`linkStatus: "unmatched" | "ambiguous"` rather than paired by guesswork, and
the consumer retains only the newest 64 unlinked transport records.
"tests/transport-probe-registry.test.ts" pins publication counts, item-count
fidelity, and send-path exception isolation.

## Vendored install policy

## Shared fast-mode request decisions (choco-pi addition)

Codex provider entry points consume the validated v1 process bridge at
`Symbol.for("choco-pi.fast-mode-state")` by session id. Each request freezes one
decision before asynchronous preparation and maps its explicit `priority` or
`standard` choice to the SDK-verified `priority` or `default` wire tier for the
body, routing headers, retries, continuation, usage
pricing fallback, prewarm/keepalive, and native-compaction streams. Prewarm rejects
a bridge-backed snapshot whose revision changes before transport send. The legacy
Codex config remains the fallback while sibling packages transition; Codex routing
headers remain confined to the `openai-codex` provider implementation.

Payload hooks and prepared prewarm bodies are followed by a final application of
the frozen session decision, so conversion defaults cannot restore priority after
an explicit off. Codex config initializes only a session controller whose source
is still `default`; status rendering reads that controller and no longer publishes
the former process-global default.

This package declares the repository pnpm toolchain (`pnpm@11.11.0`) and an
isolated one-package workspace boundary. Frozen installs retain the repository's
`typebox@1.3.29` release-age exception. This is installer configuration only;
it does not migrate or change the package's Pi SDK compatibility.

## Pi SDK target alignment

Host-provided Pi SDK peer contracts and any development SDK dependencies now
require exactly `1.0.4`, matching the harness target. Package-local frozen
locks resolve that release, with release-age exceptions
limited to the six exact SDK/chord/telemetry `0.87.1` packages and the existing
`typebox@1.3.29` exception. This SDK alignment is separate from the pnpm 11
installer-policy change; unrelated dependency contracts are unchanged.

## 2026-09-21 choco-pi patch: Pi 0.86.1 transcript migration

Provider boundaries now accept `TranscriptContext`. The Responses converter
replays system messages as the leading prompt and later developer items,
preserving `tool_search` anchors and `additional_tools`; deferred-tool placement
comes from `resolveTranscriptTools`, and grammar-tool metadata comes from
`getDeclaredTools`. Prewarm and native compaction paths use `normalizeContext`,
the Code Mode nested-tool boundary validates `JsonObject` arguments, and Off
reasoning effort is explicit. `tests/request-body-invariants.test.ts` and
`tests/transcript-request-paths.test.ts` cover the request paths.

## Native OpenAI web-search backend (choco-pi addition)

`src/tools/web-run/backend.ts` extracts the native `web_run` subprocess boundary
for reuse by the unified search router. Adapter calls supply an explicit session
owner and already-resolved OpenAI Codex subscription credentials; the backend
rejects other provider routes, stops the child process on cancellation, refuses
stale owners before startup and after completion, and preserves structured output
and source data. Transport failures retain typed categories and structured HTTP
status when the helper reports one. `codex-tool-provider.ts` now exposes a separate
OpenAI-only resolver that never accepts the conversation model or an arbitrary
Responses proxy. The legacy standalone tool keeps its configured-Responses route,
and Code Mode now passes the same Codex-provider fallback flag as the directly
registered tool. Focused root tests use a temporary executable and no provider
network requests.

`src/extension/search-adapter.ts` registers the native helper with the shared
search router as `codex.web_run` (`openai`, `codex-native`, subscription billing).
It resolves only canonical OpenAI Codex credentials, derives availability from
local configuration, credentials, and binary presence, and binds every native
request to the router's session owner. Search, image search, direct or referenced
open, click, and find retain native filters and references. The router owns public
reference identity. When canonical search is active, Codex activation no longer
registers or reactivates `web_run`, and Code Mode omits `web__run` while retaining
the registered canonical `web_search` bridge across conversation providers.

The extracted subprocess boundary now waits for child close after cancellation,
escalates from `SIGTERM` to `SIGKILL` after a bounded grace period, and redacts the
resolved token and account id from native diagnostics. SSE retry bodies snapshot
typed-array input once into an owned `ArrayBuffer`, preserving the request bytes
across retries and satisfying the integrated Fetch `BodyInit` contract.

## 2026-09-23 choco-pi patch: GPT-6 family native features

Mid-turn Steering and Async Code Mode now gate on `supportsNativeResponsesModel`
(`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`) instead of the exact
`gpt-6-astra` ID, because the whole GPT-6 family supports both features.
The WebSocket request gate, async exec decoration and call tracking, the
`openai-codex` input-hook steering gate, and the setting descriptions share it.
Other models and SSE keep ordinary behavior.

2026-10-07: the gate also accepts `gpt-6.1-sol` (exact ID only; no other 6.1
name). Native steering and async exec support for GPT-6.1 Sol is assumed from
GPT-6 Sol and is pending a live probe by the orchestrator.

## choco-pi patch: structured Codex usage-limit reset signal

User-facing error text is unchanged. `errors.ts` adds `parseCodexUsageLimitError`
(`formatCodexUsageLimitError` now returns its `message`), which also exposes
`{ resetAt, planType }` with `resetAt` in epoch milliseconds (absolute
`resets_at` / `X-Codex-Primary-Reset-At` first, else now plus
`resets_in_seconds` / `X-Codex-Primary-Reset-After-Seconds`). `parseErrorResponse`
returns it as `usageLimit`. The SSE HTTP error path attaches it to the thrown
error through a `WeakMap` (`attachCodexUsageLimitDetails`), and
`resolveCodexUsageLimitDetails` also reads WebSocket `error` /
`response.failed` payloads. On a non-aborted terminal usage-limit failure,
`transport-recovery.ts` records a per-session signal
(`providers/openai-codex/usage-limit-signal.ts`, pruned after 10 minutes on write
and ignored when stale on read, account id included) before it emits the error
event. The extension's `message_end` handler (`extension/usage-limit-entry.ts`)
drains it for Codex error messages and appends the `choco-pi-codex-usage-limit`
custom entry, a structural copy of root `CodexUsageLimitEntry` (no root import).
`session_shutdown` and `session_before_switch` clear the current session's signal.
A host test confirms the provider's stream `sessionId` equals
`ctx.sessionManager.getSessionId()` at `message_end`.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4

Pi SDK peer and development pins move from `0.87.1` to exactly `1.0.4`,
matching the harness target. Other dependency contracts are unchanged.

The package workspace release-age exceptions now list eight exact
`@earendil-works/*@1.0.4` packages and the existing `typebox@1.3.29` exception.
`@earendil-works/pi-codemode@1.0.4` and `@earendil-works/pi-mcp@1.0.4` now appear
in the frozen lock as transitive dependencies of `pi-coding-agent`.

## 2026-10-07 choco-pi patch: Pi 1.0.4 nested tool context and shell results

In Pi 1.0.4, tool `execute` receives `ExtensionToolContext` (`tools` and `executeTool`).
`ToolExecutionContext.extensionContext` is now that type, and the `exec`/`wait` tool's
own context passes through unchanged. Its tool members are non-enumerable, so the
adapter never copies the context.

Bridged registered tools (`collectBridgedTools`) use `dispatch: "session"`. When
`ctx.tools` lists the name, the call runs through `ctx.executeTool(name, input,
{ signal, onUpdate })` with the code-mode-prepared input. Pi then applies its hooks,
nested-call events, the `nestedCalls` record and usage folding. An `isError` outcome
without shell structured content rejects with the tool's text. Registered tools that
the session cannot call (inactive `direct` tools) and the Codex-native instances code
mode builds (`apply_patch`, `exec_command`, `write_stdin`, `view_image`, `web__run`,
`image_gen__imagegen`) still run their definition directly, because `executeTool`
reaches only callable session tools.

Results whose `structuredContent` matches Pi's shell shape (`output`, `truncated`,
optional `full_output_path`, `exit_code`, `wall_time_seconds`) resolve to that
validated object, including non-zero exits. Empty output resolves to `""` rather than
`(no output)`. The text fallback of other tools is unchanged. `extension/events.ts`
ignores `tool_execution_start` events that carry `parentToolCallId`, so nested calls
no longer reset the exploration group.

## 2026-10-08 choco-pi patch: Daybreak access program

Adds a per-session Daybreak toggle for the OpenAI Codex provider, modeled on Fast
mode. `providers/openai-codex/daybreak-types.ts` publishes the shared state
contract (registry symbol `choco-pi.daybreak-state`, requested, source,
revision, generation, outcome). `daybreak-decision.ts` freezes a decision per
request and checks currentness by controller identity, generation, and
revision. `daybreak-entitlement.ts` looks up `accounts/verified_access` with
the Codex auth headers, validates the response with typebox, caches per account
and backend with a bounded TTL and single flight, and is invalidated on toggle,
auth change, and inference 401/403 (HTTP, WebSocket transport, and prewarm).

Wire semantics: off (default) strips `access_programs` from every outgoing
body; on sends `access_programs.cyber` as `daybreak_blue` or `daybreak_red`
only with canonical ChatGPT-account Codex auth and an active cyber grant;
otherwise the field is omitted and the outcome records why (`not-granted`,
`lookup-failed`, `auth-not-eligible`). The finalizer runs after payload hooks
in `prepareCodexRequestBody` and the prewarm `preparedBody` branch; remote
compaction v2 replaces the field in history bodies; the WebSocket continuation
comparison keeps the effective field so a change forces a fresh
`response.create`; stock and proxy Responses overlays never receive it.
`src/ui/status.ts` shows the effective state and reason. Tests:
`tests/daybreak-decision.test.ts`, `tests/daybreak-status.test.ts`.

Granted requests also pre-check the selected model against the authenticated
`codex/models?client_version=1.0.0` catalog. The per-account/backend single-flight
cache validates only used fields, skips malformed model entries, and shares
entitlement invalidation events. Missing support for the exact blue/red program
omits the wire field and reports `model-not-supported`; lookup failures fail
closed as `lookup-failed`. Catalog successes expire after ten minutes, failures
after one minute, with a five-second lookup timeout.

Requested sessions now start as `pending`, distinct from a genuine `lookup-failed`.
`extension/daybreak-probe.ts` resolves credentials and runs the same ticket decision
pipeline on session start, toggle-on, and model changes without building a Responses
body or sending `/responses`. One serialized lane coalesces rapid changes; session,
controller generation, revision, and model replacement guards discard stale reports.
Controller subscriptions notify both `set()` and changed `report()` outcomes; the
root editor repaints through the same `setStatus` path as Fast mode. Disposal and
replacement clear listeners. The independent subagent outcome union also includes
`pending`; its hidden registration factory is unchanged. Focused probe, state, badge,
and subagent tests cover these paths.

Daybreak editor and status metadata now disappear outside canonical ChatGPT Codex
models. Pi 1.0.4's `RegisteredCommand` and `ExtensionAPI` expose no dynamic command
visibility or unregister API: `/daybreak` remains listed, but offers no argument
completions and only explains its model restriction when ineligible. The shared
normalized terminal consumer in `stream-events.ts` validates the server's
`response.access_programs.cyber` echo once per frozen request ticket on HTTP and
WebSocket paths. A different or missing program in a present access-program object
reports `not-granted` and invalidates that account's entitlement/catalog caches;
confirmed blue/red programs report their grant. Entirely absent or malformed echoes
leave the previous outcome unchanged. Superseded revisions cannot report or invalidate,
and no request is retried or resent.

Gate order (2026-10-08, matching codex-cli 0.161): the model catalog is the gate. If the
selected model advertises a Daybreak program the request carries it and the server's
`response.completed.access_programs` echo is final: a downgrade to `standard` reports
`not-granted` and invalidates the account caches. `verified_access` only chooses red
over blue (default blue); it never blocks, because it reports `inactive` for accounts
the backend still serves Daybreak to.

## 2026-10-08 choco-pi patch: WebSocket decode ownership

`websocket-parser.ts` invalidates its decoding generation synchronously on abort,
idle timeout, terminal completion, failure, and consumer return, including return
while a next call is pending. Stale decoding continuations cannot capture metadata
or mutate the event queue. `turn-state.ts` supplies generation-bound capture
callbacks, frozen by `websocket-stream.ts` before connection acquisition, so a
superseded request cannot claim the next turn's first metadata value. Socket close
still drains already-received frames for terminal and close-error classification.
`tests/websocket-parser-abort.test.ts` exercises delayed production decoding,
listener cleanup, turn replacement, and terminal invalidation.

## 2026-10-08 choco-pi patch: memoized bridged tool usage lines

`bridgedToolUsage` caches its rendered call line per registered definition (keyed on
the definition and its `parameters` object). The code-mode result renderer rebuilds the
bridged catalog for every rendered result, so resuming a session with a few hundred
code-mode results walked ~170 schemas per result and blocked the main thread for 11 s.

## 2026-10-08 choco-pi patch: expanded exec command source

Native `exec_command` call rendering forwards expansion state to the command
renderer. Expanded command source preserves every line without per-line shortening
or exploration summaries; collapsed calls retain their existing five-line and
100-character previews. Both modes share line normalization, including three-space
tab expansion for TUI width accounting. Existing grouped exploration rendering
is unchanged.
Code Mode's native-renderer catalog receives the same command-source behavior
without changes to trace rendering. Regression tests cover direct
native calls, real-catalog nested traces, collapsed defaults, and tab normalization.

## 2026-10-08 choco-pi patch: nested result fallback and image preferences

Expanded Code Mode traces fall back to generic result rendering when a custom
renderer throws, while retaining the call header and any execution error.
Successful custom rendering still replaces the generic result. The nested render
context now carries Pi's optional `showImages` preference through to native
image renderers; the public result renderer already forwards the outer context
unchanged. Regression tests exercise throwing and successful custom renderers
and compare nested `view_image` rendering with direct calls for disabled, enabled,
and unspecified image preferences.

## 2026-10-08 choco-pi patch: compact Code Mode contracts

The exec description and compact system-prompt help share two sentences describing
non-empty notification text and the boundary between exposed tools and direct-only
Pi tools. The namespace guard in `src/tools/code-mode/tools-namespace.ts` enforces
the latter. Notification validation lives inside the external
`codex-code-mode-host` binary, not readable package or installed Pi source: the
session evidence recorded in `docs/audits/2026-10-08-session-audit.md` (lines 152 and 254)
is corroborated by a production-host regression that rejects empty and
whitespace-only notifications. The same probe confirms that `text` and `notify`
emit output and return `undefined`; their existing help sentence is unchanged.
No runtime enforcement or result formatting changes are included.

## 2026-10-09 choco-pi patch: array-preserving tool traces

The shared trace serializer recognizes arrays before the record-only object guard.
Tool content blocks, array arguments, and nested result details now remain structured
in streaming updates, final snapshots, and JSON replay for every tool producer.
Existing size, depth, and cycle limits remain in place; literal strings are unchanged.
`tests/code-mode-trace-arrays.test.ts` covers these production boundaries.

## 2026-10-09 choco-pi patch: retrievable nested results keep their content id

`compactNestedResult` in `src/adapter/code-mode/nested-tool-adapter.ts` no longer
collapses a text-only result to a string when its `details` carry a string
`responseId` (web-access `fetch_content`, `source_check`, and
`get_search_content` error/artifact replies) or `searchId` (`web_search`). Such
results resolve to `{ output, ...scalars }`, copying top-level booleans, finite
numbers, and strings up to 256 characters from `details`; arrays, objects, nulls,
and longer strings are dropped, and `output` is never overwritten. Scripts can then
pass the id to `get_search_content`, which requires it. Both the direct and
session dispatch paths use this fallback. Results without such an id, shell
`structuredContent`, `details.output`, image results, and tools with a
`resultValue` hook are unchanged. `tests/code-mode-nested-tool-dispatch.test.ts`
covers both id keys, scalar filtering, the text fallback, and session dispatch.

## 2026-10-11 choco-pi patch: `/codex` summary outside the TUI

`openSettings` in `src/ui/settings/command.ts` gated the text summary on
`!ctx.hasUI`, but Pi RPC reports `hasUI` true while `ctx.ui.custom()` returns
`undefined`, so RPC hosts got no output. The gate is now `ctx.mode !== "tui"`;
TUI is unchanged. Test: `tests/settings-command-rpc.test.ts`.

## 2026-10-11 choco-pi patch: OpenAI subscription sign-in degradation

Pi 1.0.4 "Sign in with ChatGPT" on provider `openai` sends the subscription
token to `https://api.openai.com/v1` (SSE, no ChatGPT account id). Live probes
showed the following Codex-backend capabilities are refused or ignored there:
`service_tier`, `access_programs`, `compaction_trigger`, `/responses/compact`,
and the chatgpt.com usage/entitlement routes.
`src/adapter/openai-sign-in.ts` (new) owns detection: provider `openai`, public
base URL, and `modelRegistry.isUsingOAuth`. That mirrors pi-ai `isChatGPTSignIn()`
without reading the token. It also owns the user-facing reasons. `sk-` API keys
and `openai-codex` (kept as opt-in legacy) are unchanged.

- Request boundary (`provider-request.ts`): the sign-in result is snapshotted
  before the first await. Sign-in payloads lose `service_tier` after the
  existing `access_programs` strip. The Fast snapshot receives
  `ctx.modelRegistry`. Test: `tests/openai-sign-in-request.test.ts`.
- Fast/Daybreak (`fast-mode-decision.ts`, `daybreak-decision.ts`,
  `daybreak-types.ts`, `extension/daybreak-probe.ts`, `ui/status.ts`,
  `ui/steering-status.ts`): decisions gain an optional `reason`. On sign-in,
  bridge or fallback Fast decisions become unsupported/inactive with no tier.
  Daybreak reports `auth-not-eligible` with the reason, and the probe performs
  no credential read or lookup for api.openai.com models. Status shows
  "Fast/Daybreak unavailable (<reason>)" while requested. Steering receipts on
  `openai` state that native steering is unavailable (SSE). Test:
  `tests/openai-sign-in-fast-daybreak.test.ts`.
- Compaction (`compaction-runtime.ts`, `compaction.ts`): the resolver fails with
  `openai-subscription-sign-in` before any auth lookup. `session_before_compact`
  notifies once per session and returns `undefined` so Pi local compaction runs.
  The pending native-window backend check is kept: it prevents replaying
  encrypted compaction items to a different backend.
- Usage (`usage-limit-entry.ts`, `codex-usage/{client,payload,format}.ts`,
  `ui/settings/usage-tab.ts`): an `openai` error containing
  `subscription_sharing_usage_limit_exceeded` yields `{ observedAt }` only.
  `fetchCodexUsage` returns `{ unavailable, reason }` without a request for
  sign-in or an unconfigured `openai-codex` credential. Tests:
  `tests/openai-sign-in-compaction-usage.test.ts`, plus added cases in
  `usage-limit-signal` and `context-elision`.

## 2026-10-11 choco-pi patch: OpenAI sign-in tool authentication

Companion to the sign-in degradation patch above. Tools now resolve stock
`openai` (api.openai.com) credentials before the legacy `openai-codex` chain.
Files: `adapter/codex-tool-provider.ts`, `tools/web-run/{backend,tool}.ts`,
`tools/imagegen/tool.ts`, `tools/view-image/tool.ts`,
`extension/search-adapter.ts`, `ui/settings/config-items-tools.ts`.

- Provider (`codex-tool-provider.ts`): new `resolveOpenAIPlatformAuthModel`
  picks an available `openai` Responses model (preferred ids shared with the
  legacy chain). `resolveCodexToolProvider` takes `{ capability }`; the
  `search` capability on an `openai` model fails before credential lookup with
  the new `unsupported` error kind, because api.openai.com has no
  `/alpha/search` route. `resolveOpenAICodexToolProvider` rejects a configured
  `openai` provider the same way and uses the legacy chain only when `openai`
  is unconfigured. On `openai` the account id is empty, the
  `ChatGPT-Account-ID` header is omitted, and `openAIPlatform.subscriptionSignIn`
  is set. Login hints now lead with `/login openai`, legacy `/login openai-codex`.
- web_run (`backend.ts`, `tool.ts`, `search-adapter.ts`): the helper is never
  given an `openai` credential; `unsupported` maps to a config error with the
  reason, and missing credentials say native search needs an `openai-codex`
  login. Web search on `openai` goes through choco-pi-web-access.
- imagegen (`tool.ts`): `openai` models are executable; a helper failure under
  sign-in appends a note that Images API acceptance of the sign-in token is
  unverified. view_image (`tool.ts`): the description call posts to
  `https://api.openai.com/v1/responses` with an `openai` description model and
  no reasoning summary. Neither is verified live.
- Settings (`config-items-tools.ts`): the web search model row takes the
  credential provider, is labelled "(openai-codex legacy only)" on `openai`, and
  accepts either prefix while storing the bare model id.
  Test: `tests/codex-tool-provider-openai.test.ts`.

## choco-pi patch: one preferences source, no screen headings

`src/ui/settings/preferences-sections.ts` publishes every Codex row as a single
`codex` section instead of spreading rows over host sections through
`CODEX_ROW_LAYOUT` and `mergeInto`; `CodexPreferencesSection` no longer has
`mergeInto`. The profile's `.pi/extensions/lib/preferences-layout.ts` places
each row by id, and a row it neither places nor hides keeps a Codex tab. The
dim `/codex` screen headings (`transportHeader`, `compactionHeader`,
`diagnosticsHeader`, `activateOnlyHeader`) and the per-section
`codexSourceHeader:*` rows are not published, because the host panel draws its
own group headings; `config-items-*.ts` still emits them for `/codex`. The
Edit config outcome reopens with `focusId: "editConfig"`, which the host panel
resolves to the tab that holds it. The profile hides `executionMode`,
`customRustBinariesHelp`, and `customRustBinariesPath`.
Test: `tests/codex-preferences-sections.test.ts`, `tests/preferences-layout.test.ts`.

## choco-pi patch: OpenAI compaction row and native-compaction budget hook

`src/ui/settings/config-items-openai.ts`: the `responsesCompaction` row keeps
its id but is labelled "OpenAI compaction" with values `server-side` (stores
`compaction.responsesCompaction: true`) and `choco-pi` (`false`) instead of the
`off`/`on` "Responses compaction V2" toggle. The config default stays `false`;
the profile's `.pi/choco-pi-codex.json` sets `true`. choco-pi-compaction reads
the same key to derive the background `codexNative` lane.

`src/extension/native-compaction-budget.ts` (new) publishes
`Symbol.for("choco-pi.native-compaction-budget")` as
`{ version: 1, budgetFor({ provider, id, contextWindow }) }`, read by the
profile's `.pi/extensions/lib/context-policy.ts`. `budgetFor` resolves the
provider/id through the session's model registry and returns
`resolveNativeCompactionRequestBudget` (872k on Codex transport for
Responses Lite ids, else 95% of the passed window) only when the live runtime
plan has `nativeCompaction`; otherwise `undefined`. It reads the adapter's live
config on every call, so the row change (which also resets the transport)
applies on the consumer's next read. `src/extension/register.ts` publishes it at
registration and on `session_start` when the slot is free, never replaces
another publisher, and removes it on `session_shutdown` or failed registration
only while the slot still holds it.
Test: `tests/native-compaction-budget.test.ts`,
`../../../tests/codex-preferences-sections.test.ts`.

## 2026-10-09 choco-pi patch: Pi SDK 1.2.0

Pi SDK peer and development pins move from `1.0.4` to exactly `1.2.0`. The package-local workspace and frozen lock follow; `@earendil-works/chord`
leaves the release-age exclusions because 1.2.0 no longer depends on it.
