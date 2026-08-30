# Vendored: choco-pi-codex

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

## Registered-tool bridge (choco-pi addition)

tools/code-mode/registered-tool-bridge.ts exposes every tool Pi has registered
(LSP navigation and diagnostics, the MCP gateway, sub-agent and session
control, goals, browser and web access) inside the code-mode tools namespace.
Pi hands extensions tool schemas but not executable definitions and no event
carries the live session, so the bridge patches ExtensionRunner.prototype the
way .pi/extensions/command-filter.ts does, captures the runner the first time
Pi assembles its tool list, and wraps each definition through the existing
nested-tool adapter. Bridged tools are deferred, so they add no per-tool prompt
lines; tool-source.ts now keeps every deferred tool in ALL_TOOLS (not just
custom ones) and custom-tool-prompt.ts adds one line naming them. Code mode's
own entry points and the natively wrapped Codex tools stay excluded.
tests/codex-code-mode-bridge.test.ts pins exclusions, usage lines, deferral,
the ALL_TOOLS scope and the prompt line.

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

Collapsed Code Mode `exec_command` summaries omit Bash reserved words used for
control flow and retain only executable command names. The expanded trace still
shows the complete command source.

Code Mode `exec_command` requires a concise `description`. Collapsed
traces show that intent before the parsed executable names, while sanitizing and
bounding display text; command execution remains unchanged.
An optional first-line `// @description:` pragma supplies the collapsed parent
Code Mode call's intent. Without it, the renderer derives the parent intent from
the first `exec_command` description and suppresses its redundant generic
“Calls” line.

## Code Mode and edit preflight (choco-pi addition)

`tools/code-mode/source-preflight.ts` parses restricted cells before host execution and scans executable source tokens for unsupported restricted globals. It hard-rejects a `tools.<name>` reference only when the reference is unconditional at the cell's top level and Pi registers the name neither inside nor outside code mode. Guarded references and real-but-unbridged tool names run to the namespace proxy. String, comment, template text, and regular expression contents are ignored. Notebook cells retain Deno TypeScript capabilities and skip restricted-global and JavaScript-only checks. Command strings and non-zero `exec_command` exits remain runtime data and are not reclassified.

The tools namespace guard supplies close-match and direct-registration guidance at runtime. Bridged tools translate stale `read` offsets, exact-match ambiguity versus stale `edit` context, and missing UI observation state into focused recovery errors. `apply_patch` accepts only its documented freeform string in Code Mode; its native first-match, `@@` anchor, and fuzzy resolution remain authoritative. Context analysis runs only after the native applier rejects a hunk, when it reports current line counts, anchor-scoped candidate ranges, and exact re-read windows. `tests/code-mode-preflight.test.ts` pins each measured failure class and the false-positive boundaries.

## Codex request-body invariants (choco-pi addition)

`tests/request-body-invariants.test.ts` pins the stable, Unicode-safe clamping
of the session-derived `prompt_cache_key`, deterministic instruction and tool
serialization for identical inputs, and omission of the unproven
`prompt_cache_retention` field on the ChatGPT-backed Codex endpoint. The test
documents existing upstream request behavior; no provider source was changed.

## Bundled native binaries (choco-pi addition)

`src/tools/{apply-patch,exec,imagegen,view-image,web-run}/bin/darwin-arm64/`
are the upstream prebuilt Rust binaries for those tools (same tarball provenance;
~10.5 MB). Only darwin-arm64 is vendored; add other platforms the same way or set
`tools.customRustBinariesDir`. The fork's resolver
(`src/tools/native/binary.ts`) finds them automatically when the config is empty.

## Deferred runtime imports (choco-pi addition)

Load-time-only changes defer provider stream processing, websocket connection setup, Code Mode host process support, exec session internals, apply-patch execution, optional image and web tool execution, settings screens, and image codecs until the corresponding provider request, tool call, command, or event handler runs. Registration keeps the same provider, tool and command names, schemas, event channels, descriptions, and `Symbol.for` keys. Public helper exports remain synchronous and load their implementation on first use.
