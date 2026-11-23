# Vendored: choco-pi-code-mode

## Origin (choco-pi split, 2026-11-24)

Extracted from `packages/choco-pi-codex` (itself the choco-pi fork of
`@howaboua/pi-codex-conversion` 3.0.18; MIT, `LICENSE` copied verbatim). The
history of every file moved here lives in `packages/choco-pi-codex/VENDORED.md`
and in Git (`git log --follow`). The files moved with `git mv` and their
directory layout unchanged:

- `src/tools/{code-mode,apply-patch,exec,view-image,native}/**` (with the
  darwin-arm64 `apply_patch`, `exec_bridge` and `view_image` binaries),
  `src/tools/boundary.ts`, `src/tools/tool-sampling.ts`
- `src/patch/**`, `src/shell/**`, `src/ui/tool-rendering/**`
- `src/adapter/code-mode.ts`, `src/adapter/code-mode/**`,
  `src/adapter/prompt/runtime-shell.ts`, `src/adapter/runtime-values.ts`,
  `src/adapter/tool-support.ts`
- `src/code-mode-preflight.ts`, `src/apply-patch-display.ts`,
  `src/memoized-import.ts`, `src/native-binary-error.ts`,
  `src/schema-bridge.ts`, `src/value-guards.ts`, `src/types/pngjs.d.ts`
- `code-mode/` (`UPSTREAM_SYNC.md` and `vendor/code-mode-src/`, OpenAI Codex
  `rust-v0.145.0` provenance)

Protocol strings that name the upstream package
(`@howaboua/pi-codex-conversion/...`, the `pi-codex-conversion` host cache
directory) are unchanged: they are live runtime contracts.

## Changes made by the split

- `src/adapter/tool-support.ts` keeps only `supportsViewImageInputs`; the
  Codex-native web search and image generation predicates stay in
  `choco-pi-codex`.
- `src/adapter/code-mode.ts` drops the transitional
  `createCodeModeWebSearchTool` shim and its `CodexConversionConfig` import;
  `registerCodeMode` aliases `registerCodexCodeMode`.
- `src/tools/native/binary.ts`: `getBundledToolBinaryPath` takes an optional
  `toolsRootDir` (default: this package's `src/tools`, exported as
  `CODE_MODE_TOOLS_ROOT_DIR`), so a provider resolves the binaries it bundles
  from its own tree.
- New `src/host-slot.ts`, `src/standalone.ts`, `src/extension.ts`,
  `src/index.ts` (see below).

## Standalone and composed operation

`src/extension.ts` is the Pi extension entry. It probes the host slot on the
runtime's shared event bus. If a provider already owns Code Mode
(choco-pi-codex, which loads first in the default profile), it registers
nothing; otherwise it claims the slot as `standalone` and calls
`registerStandaloneCodeMode`, which:

- registers `exec` and `wait` over a host whose policy is active for every
  model in `code` execution, with no provider ports (no image-description
  fallback, no `web__run`/`image_gen__imagegen`, no native async calls);
- on `session_start`, `model_select` and `session_tree`, makes the top-level
  tools `exec`, `wait` and every active tool Code Mode neither owns nor
  replaces (Pi's `read`/`bash`/`edit`/`write` stay callable inside Code Mode
  through the bridge), then prepares the host;
- shuts down exec sessions and the host on `session_shutdown`.

When this extension loads before choco-pi-codex (a hand-ordered
`settings.json`), the standalone owns Code Mode and Codex registers only its
provider and `web_run`/`imagegen`, warning once that its ports are not
attached. `tests/code-mode-extension.test.ts` covers all three load shapes.

## Dependencies

`jpeg-js@0.4.4`, `pngjs@7.0.0` (half-block image fallback), `smol-toml@1.7.1`
(custom tools), `web-tree-sitter@0.26.12` + `tree-sitter-bash@0.25.1` (shell
parsing), the same pins choco-pi-codex used; they left its manifest.

## 2026-11-23 choco-pi patch: remove non-exempt source comments and add public API JSDoc

- Removed non-exempt comments across package source and test files (`d285398f`), preserving `SAFETY:` annotations, active `@ts-*` directives, MIT license headers, and shebangs.
- Added concise English JSDoc to exported cross-package API interfaces in `src/adapter/code-mode/ports.ts` and `src/host-slot.ts` (`1b7e4231`). Runtime behavior and public APIs are unchanged.
