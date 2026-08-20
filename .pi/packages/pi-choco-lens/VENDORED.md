# VENDORED — pi-choco-lens

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
worktree's jiti). There is no build step and no generated artifacts.

### `pi.skills` path

Upstream's manifest says `"skills": ["../../skills"]` — resolved relative to
the entry FILE `dist/index.js`, where `path.resolve` consumes the filename as
the first `..`. In pi-coding-agent 0.84.2 the manifest entries are resolved
against the PACKAGE ROOT (`collectFilesFromManifestEntries` →
`resolve(packageRoot, entry)`), so with the entry at the package root this
fork uses `"skills": ["./skills"]`. All four upstream skills ship unchanged:
`pi-lens-ast-grep`, `pi-lens-lsp-navigation`, `pi-lens-write-ast-grep-rule`,
`pi-lens-write-tree-sitter-rule`.

### Vendored runtime dependencies

Checked into-package `node_modules/` is populated (untracked; `node_modules/`
is gitignored repo-wide) with the exact versions the previous
`npm:pi-lens@4.0.0` install used:

| package | version | why |
|---|---|---|
| @ast-grep/napi (+ napi-darwin-arm64) | 0.45.1 | ast-grep structural search/scan |
| web-tree-sitter | 0.25.10 | tree-sitter grammars/queries |
| minimatch (+ brace-expansion, balanced-match) | 10.2.6 | ignore/rule matching |
| js-yaml (+ argparse) | 5.2.3 | rule/config YAML |
| pidusage (+ safe-buffer) | 4.0.1 | resource sampler |
| vscode-jsonrpc | 9.0.1 | LSP transport |
| @types/pidusage | 2.0.5 | typecheck only |

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
- Footer status key `pi-lens-lsp` and widget key `pi-lens` — byte-identical;
  `.pi/extensions/pi-lens-visibility.ts` patches those keys.
- Tree-sitter structural rules and ast-grep scanners (`rules/`), semantic
  index tools (`symbol_search`, `module_report`, `read_symbol`,
  `read_enclosing`), `lens_diagnostics`, `ast_grep_search` family,
  `pi_lens_activate_tools` lazy-tool mechanism, read-guard, dispatch pipeline,
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

`/lsp on|off|status` — a human-facing runtime toggle for LSP usage, wired into
the same machinery as upstream's `--no-lsp` flag (`lsp.enabled` config key):

- a session-scoped runtime override tier (`setRuntimeLensFlagOverride`,
  `clients/lens-config.ts`) resolves ABOVE env/CLI/config, so every
  `getFlag("no-lsp")` consumer reacts immediately;
- `/lsp off` also stops the running language servers
  (`resetLSPService({ fast: true })`) and persists `lsp.enabled=false` to
  `~/.pi-lens/config.json` (`persistPiLensGlobalConfigKey`); `/lsp on`
  persists `lsp.enabled=true`;
- while disabled, the `pi-lens-lsp` status renders "LSP Inactive (disabled)",
  which the visibility patch hides (status and widget), and
  `lsp_diagnostics`/`lsp_navigation` return a graceful "disabled" message
  instead of spawning servers (upstream gated only `lsp_navigation` on the
  flag; gating `lsp_diagnostics` too is a deliberate fork behavior).
