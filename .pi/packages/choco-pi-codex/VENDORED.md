# Vendored: choco-pi-codex

This directory is a **vendored, renamed, stripped fork** of the upstream
open-source package **@howaboua/pi-codex-conversion**. This is not the original
source repository.

- Original source code: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion
- Package on npm: https://www.npmjs.com/package/@howaboua/pi-codex-conversion
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

Dropped upstream dependencies (only used by removed features): `ws`,
`selfsigned` (voice LAN server), `zeromq`, `unzipper` (notebook mode).

## Source changes relative to upstream 3.0.18

Beyond the removals above: `extension/{register,runtime,events,ui,tools}.ts`,
`ui/settings/{command,screen,tabs,config-items,config-items-adapter,config-items-display}.ts`,
`tools/code-mode/{shared-runtime,public-tools}.ts`,
`adapter/activation/{config-store,execution-mode}.ts`,
`adapter/prompt/context-filter.ts`, `adapter/compaction/request-shrink.ts`,
`native-binary-error.ts`, `tools/native/binary.ts`, `src/index.ts`. Wire and
interop identifiers (originator header `pi-codex-conversion`, preflight and
apply-patch-display protocol strings, code-mode host cache path) are kept
verbatim for protocol parity.

## Bundled native binaries (choco-pi addition)

`src/tools/{apply-patch,exec,imagegen,view-image,web-run}/bin/darwin-arm64/`
are the upstream prebuilt Rust binaries for those tools (same tarball provenance;
~10.5 MB). Only darwin-arm64 is vendored; add other platforms the same way or set
`tools.customRustBinariesDir`. The fork's resolver
(`src/tools/native/binary.ts`) finds them automatically when the config is empty.
