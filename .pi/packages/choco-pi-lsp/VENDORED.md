# VENDORED — choco-pi-lsp

choco-pi fork of **pi-lens**, loaded as a local TypeScript-source pi package.

- Upstream repository: https://github.com/apmantza/pi-lens
- Base commit: `51050ea0bd04acc022aaf9c8e1b69729c7c44b2b` (master, 2026-08-20, version 4.0.1)
- Fork date: 2026-08-22
- Upstream license: MIT (see `LICENSE`, unchanged)
- Host baseline: `@earendil-works/pi-coding-agent` / `pi-tui` 0.84.2 (upstream's own v4-safe dependency baseline)

## Deviations from upstream

### TypeScript source, no dist build

Upstream publishes a bundled `dist/` and points `pi.extensions` at
`./dist/index.js`. This fork ships the TypeScript sources directly and points
`pi.extensions` at `./index.ts`; pi 0.84.2 loads extension entries through
jiti 2.7.0, which compiles TS on the fly and resolves upstream's ESM-style
`./x.js` import specifiers to the `./x.ts` sources (verified against the
worktree's jiti). There is no build step and no generated `dist/` artifact.

### Deferred runtime loading

`index.ts` is a registration-only entry. It synchronously registers the exact
vendored tool metadata, commands, flags, message renderer, and event channels
from `registration-manifest.json`, then memoizes `await
import("./runtime-extension.ts")` behind the first subscribed event, command,
or tool call. The captured runtime handlers and renderers receive the original
host arguments unchanged. This is a load-time-only fork change: registration
names, parameter schemas, descriptions, command names, flags, event channels,
and runtime behavior are unchanged. Native/wasm analysis, LSP machinery,
cache/rule engines, and dispatch runners therefore stay off the entry import
path and load at the same logical startup boundary (`session_start`) or on an
earlier explicit invocation.

The ast-grep subprocess runner also defers its shared installer/runner-helper
graph until the first availability or scan operation, and
`diagnostics_report` keeps only its model-visible registration definition eager
while loading the project-scan implementation on first execution.

### `pi.skills` path

Upstream's manifest says `"skills": ["../../skills"]` — resolved relative to
the entry FILE `dist/index.js`, where `path.resolve` consumes the filename as
the first `..`. In pi-coding-agent 0.84.2 the manifest entries are resolved
against the PACKAGE ROOT (`collectFilesFromManifestEntries` →
`resolve(packageRoot, entry)`), so with the entry at the package root this
fork uses `"skills": ["./skills"]`.

### Local LSP naming

The fork renames the four upstream skill directories and their frontmatter to
`choco-pi-lsp-*`. It also replaces the stale `lens-*` client filenames with
`lsp-*`, names the aggregate diagnostics source `tools/diagnostics-report.ts`,
and names the disposition source `tools/diagnostic-mark.ts`.
The retained model-facing tool names are `diagnostics_report`,
`diagnostic_mark`, and `lsp_activate_tools`; legacy health references use
`lsp_health`. This package has no underscore-form health tool registration;
its health interface is the intentionally preserved `/lens-health` command.

The runtime status and widget keys are both `choco-pi-lsp`; the host stores
statuses and widgets in separate registries, so the shared text does not
collide. Exact upstream runtime source and namespace labels now use
`choco-pi-lsp`, environment variables use the `CHOCO_PI_LSP_*` prefix, and the
visibility installation symbol is `choco-pi.choco-pi-lsp-visibility`. The
default machine state directory is `~/.choco-pi-lsp`; the fork reads and writes
only that directory and performs no migration or compatibility fallback.
Internal `/lens-*` command ids, `lens_diagnostics_full`, and TypeScript `Lens`
identifiers remain unchanged.

### Vendored runtime dependencies

Checked into-package `node_modules/` is populated (tracked; the package
`.gitignore` re-includes `node_modules/` because `node_modules/`
is gitignored repo-wide) with the exact versions the previous
`npm:pi-lens@4.0.0` install used:

| package                                       | version | why                             |
| --------------------------------------------- | ------- | ------------------------------- |
| @ast-grep/napi (+ napi-darwin-arm64)          | 0.45.1  | ast-grep structural search/scan |
| web-tree-sitter                               | 0.25.10 | tree-sitter grammars/queries    |
| minimatch (+ brace-expansion, balanced-match) | 10.2.6  | ignore/rule matching            |
| js-yaml (+ argparse)                          | 5.2.3   | rule/config YAML                |
| pidusage (+ safe-buffer)                      | 4.0.1   | resource sampler                |
| vscode-jsonrpc                                | 9.0.1   | LSP transport                   |
| @types/pidusage                               | 2.0.5   | typecheck only                  |

`typebox`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`
resolve from the repository root `node_modules` (0.84.2). Note: the platform
package `@ast-grep/napi-darwin-arm64` is macOS/arm64-only; other platforms
need their own napi platform package dropped into `node_modules/@ast-grep/`.

### Grammars

The 12 core wasm grammars (ts/tsx/js/python/go/rust/json/yaml/bash/html/css/
java) ship in `grammars/`, copied from the installed pi-lens 4.0.0 package and
verified byte-for-byte against `scripts/grammars.lock.json` from the 4.0.1
base commit. The long tail stays lazy-fetched at runtime on first parse
(`ensureGrammar` → CDN), unchanged; `vendor/grammars/tree-sitter-cue.wasm`
ships as upstream does. Upstream's `scripts/download-grammars.js` build step is
replaced by this one-time copy; `scripts/grammars.lock.json` is kept because
the runtime provenance check reads it.

## Kept (behavior parity with upstream)

- LSP service and clients, diagnostic pipeline, wait policies, warm/cold
  management, `lsp_diagnostics`, lazy-activated `lsp_navigation`.
- Footer status and widget key `choco-pi-lsp`;
  `.pi/extensions/choco-pi-lsp-visibility.ts` patches both registrations.
- Tree-sitter structural rules and ast-grep scanners (`rules/`), semantic
  index tools (`symbol_search`, `module_report`, `read_symbol`,
  `read_enclosing`), `diagnostics_report`, `ast_grep_search` family,
  `lsp_activate_tools` lazy-tool mechanism, read-guard, dispatch pipeline,
  format/autofix machinery, project-trust consumption, opengrep and the other
  per-edit dispatch runners, `clients/mcp/` (word-index/IPC engine used by the
  in-process tools and warm-attach).
- The `/lens-*` command family and flag registry.

## Dropped

- **Heavyweight project analyzers** and everything that only served them:
  trivy, gitleaks, knip, jscpd, madge (dependency-checker), govulncheck,
  dead-code (vulture). Removed: their clients and loggers, project-diagnostics
  runner adapters, the `trivy-config` dispatch runner, helm-render's trivy IaC
  pass, session-start/turn-end scan wiring, installer registry entries
  (npm + GitHub-release), tool-policy rows, the `lens-turn-end-madge` flag,
  the `trivy` project-config consent key, gitleaks/trivy secret converters,
  and their delivery-gate registry entries. Shared seams survive: the lazy
  dispatch graph, cache manager, telemetry names, the fresh-fetch lane shape
  (now opengrep + test-runner), the unified secrets pipeline (ast-grep is the
  only remaining producer), and `security-scan-client` (used by opengrep).
- **The MCP second-host adapter**: upstream root `mcp/` (server, CLI, worker,
  analyze-cli, build-staleness) and its bins. `clients/mcp/` is NOT that
  adapter and is kept (see above).
- **Repo machinery**: `.github/`, `tests/`, `cases/`, `docs/` (except
  `docs/custom-rules.md`, referenced by the rule-writing skills), `scripts/`
  (except `grammars.lock.json`), changelog/PR tooling, vitest config,
  `tsconfig.build.json`/`tsconfig.dist.json`, banners, contributor docs.

## Added (choco-pi feature)

Code-mode edit tracking (`clients/code-mode-tool-results.ts`) — pi 0.84.2
reports the agent's edits as nested `details.traces` entries on an outer `exec`
tool result. Upstream inspects only the outer `toolName`, so under code mode it
never saw a mutation: the turn-end advisory stayed silent while every on-demand
tool kept working. Completed nested `edit`, `write`, and successful
`apply_patch` mutations are now expanded into dispatchable events with absolute
paths, and their diagnostics are returned through the outer tool result.

`/lsp on|off|status` — a human-facing runtime toggle for LSP usage, wired into
the same machinery as upstream's `--no-lsp` flag (`lsp.enabled` config key):

- a session-scoped runtime override tier (`setRuntimeLensFlagOverride`,
  `clients/lsp-config.ts`) resolves ABOVE env/CLI/config, so every
  `getFlag("no-lsp")` consumer reacts immediately;
- `/lsp off` also stops the running language servers
  (`resetLSPService({ fast: true })`) and persists `lsp.enabled=false` to
  `~/.choco-pi-lsp/config.json` (`persistPiLensGlobalConfigKey`); `/lsp on`
  persists `lsp.enabled=true`;
- while disabled, the `choco-pi-lsp` status renders "LSP Inactive (disabled)",
  which the visibility patch hides (status and widget), and
  `lsp_diagnostics`/`lsp_navigation` return a graceful "disabled" message
  instead of spawning servers (upstream gated only `lsp_navigation` on the
  flag; gating `lsp_diagnostics` too is a deliberate fork behavior).
