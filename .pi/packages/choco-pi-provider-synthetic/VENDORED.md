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

## Vendored install policy

This package declares the repository pnpm toolchain (`pnpm@11.11.0`) and an
isolated one-package workspace boundary. The installer-policy change originally
preserved SDK overrides (subsequently aligned to `0.85.1` below) plus the
repository's `typebox@1.3.29` release-age exception. The
legacy manifest-level pnpm override block was moved here because pnpm 11 reads
workspace-root overrides. This is installer configuration only; it does not
migrate or change the package's Pi SDK compatibility.

## Pi SDK target alignment

Host-provided Pi SDK peer contracts and any development SDK dependencies now
require exactly `0.85.1`, matching the harness target. Package-local frozen
locks resolve that release, with release-age exceptions
limited to the six exact SDK/chord/telemetry `0.85.1` packages and the existing
`typebox@1.3.29` exception. This SDK alignment is separate from the pnpm 11
installer-policy change; unrelated dependency contracts are unchanged.
