# Vendored: choco-pi-agent-browser

This directory is a vendored, renamed fork of the MIT-licensed package [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native).

- Upstream URL: https://github.com/fitchmultz/pi-agent-browser-native
- Base commit: `bb2197bef0e142941b84f641993f81c5b1d325f9` (`bb2197b`)
- Base version: `0.5.0`
- Forked on: 2026-08-22
- License: MIT; upstream `LICENSE` copied verbatim

The fork lets choco-pi customize the extension in-tree and load its TypeScript source directly instead of maintaining patches against the published compiled package.

## What was taken

- `extensions/agent-browser/**`: all 101 upstream files, including `index.ts`, `script-worker.ts`, and `lib/**` with the complete `results/` and `presentation/` trees.
- `scripts/agent-browser-target.mjs`: runtime version metadata imported by `lib/upstream-version.ts` through its package-relative path.
- `scripts/agent-browser-capability-baseline.mjs`, `scripts/doctor.mjs`, and `scripts/config.mjs`: operator diagnostics and configuration support.
- `LICENSE` verbatim.
- Upstream `CHANGELOG.md` as `CHANGELOG.upstream.md`.
- Four bounded pure-logic tests: argv descriptor, command taxonomy, navigation policy, and selector recovery.

## Divergences from upstream

### Package and documentation

- Replaced upstream package metadata with private package `choco-pi-agent-browser@0.5.0-choco.0` and declared that it supersedes `pi-agent-browser-native`.
- Changed the Pi entrypoint from compiled JavaScript to `./extensions/agent-browser/index.ts`.
- Removed npm bin links. Operators invoke `node scripts/doctor.mjs` and `node scripts/config.mjs` manually.
- Kept `@earendil-works/*` and `typebox` as optional peer dependencies supplied by the Pi host. No runtime dependency was vendored.
- Replaced upstream `README.md` and `AGENTS.md` with fork-specific source-loading and maintenance guidance; added this provenance file and a root-extending `tsconfig.json`.
- Updated package-root discovery in `index.ts` for the fork name. Reduced installed-document prompt guidance to the retained fork `README.md` and removed one link to the deleted architecture document; command and result guidance remains embedded in the tool prompt.

### Source-only loading

- Renamed `extensions/agent-browser/lib/config-policy.js` to `config-policy.ts`; replaced its JavaScript-only JSDoc typedef declarations with equivalent exported TypeScript aliases and interfaces. The implementation retains its upstream JSDoc annotations under `@ts-nocheck` because TypeScript does not apply checked-JavaScript parameter annotations after a `.ts` rename. Added one return cast in `config.ts` and one explicit provider annotation in `web-search.ts` to preserve the types that the checked-JavaScript module previously exposed; both are type-only.
- Added `scripts/agent-browser-target.d.mts` with declarations for the runtime `.mjs` metadata module so strict NodeNext typechecking resolves the preserved import.
- Rewrote 560 target-verified relative `.js` module specifiers to `.ts`: 556 resolved immediately, then four `config-policy.js` imports resolved after that module was renamed. The four ported tests contributed four additional rewrites. Upstream's expected count of 558 was stale for commit `bb2197b`; the codemod reported 560 source specifiers.
- Preserved the one relative `.mjs` runtime import from `lib/upstream-version.ts` to `scripts/agent-browser-target.mjs`.
- Changed `scripts/config.mjs` to import `config-policy.ts` directly and removed its compiled-output fallback.
- Changed one-shot script mode to launch `extensions/agent-browser/script-worker.ts` with Node instead of resolving a compiled worker, and changed the missing-worker diagnostic accordingly.
- Removed the compiled entrypoint candidate from `scripts/doctor.mjs`.
- Desugared the `WebSearchRequestGate` constructor parameter properties into explicit private fields and assignments. The initial text scan missed the multiline constructor; direct Node strip-types entry loading exposed it before completion. No `enum`, `namespace`, or decorator syntax was found.

### Removed upstream-only machinery

- Removed generated compiled output and its build configuration: `dist/**`, `scripts/build.mjs`, `scripts/prepare.mjs`, `scripts/project.mjs`, and `tsconfig.build.json`.
- Removed release, publishing, lifecycle, package, live-upstream, command-reference, and startup verification scripts: `scripts/publish-contract.mjs`, `scripts/profile-startup.mjs`, `scripts/check-command-reference-baseline.mjs`, `scripts/check-playbook-drift.ts`, `scripts/verify-agent-browser-dogfood.ts`, `scripts/verify-command-reference.mjs`, `scripts/verify-lifecycle.mjs`, and `scripts/verify-package.mjs`.
- Removed platform smoke infrastructure: `platform-smoke.config.mjs`, `scripts/platform-smoke.mjs`, and `scripts/platform-smoke/**`.
- Removed generated and release documentation under `docs/**`, `.github/**`, `.pi-fleet-tested-version`, and `package-lock.json`.
- Removed the broad upstream test suite, its fixtures, and helpers; retained only the four source-only tests listed above under `tests/`.

### Anti-slop type hardening

- Brought the vendored TypeScript to the harness standard of zero `oxlint` findings at any severity, without a single suppression: 1,369 anti-slop errors plus the residual `eslint`/`unicorn` warnings, across roughly 30k lines. No `oxlint-disable` comment, ignore pattern, or `any` was introduced, and no test assertion was relaxed. The work was split across four disjoint partitions (`lib/*.ts` with the extension entry and scripts, `lib/input-modes/**`, `lib/results/**`, and `lib/orchestration/**` with `lib/electron/**`).
- The changes are type-only and behavior-preserving. Output from the external `agent-browser` CLI is now decoded at its boundary into named domain types, replacing inline representation checks, `unknown` parameters and returns, broad dictionaries, and unjustified assertions. Every retained assertion carries a safety comment stating the invariant that makes it sound.
- `hasRuntimeType` preserves exact JavaScript `typeof` semantics without the banned runtime operator or the unsupported `typebox/guard` subpath. It uses O(1) TypeBox value checks for primitives and callables, supplements TypeBox's finite-number schema for `NaN` and infinities, and separates objects from functions without traversing object properties.
- The model-visible result contract is unchanged: `resultCategory`, `successCategory`, and `failureCategory` keep the same names and enum values, verified token-for-token against the base commit. Optional fields are still constructed by explicit statements, so a property upstream omits is still absent rather than present-and-undefined.
- Tool names are unchanged, including `agent_browser`. Session-command argv construction preserves ordering and conditional namespace insertion; spawn behavior, Electron launch arguments, script-mode IPC keys and limits, and the lease read/persist/cleanup lifecycle are unchanged.
- The `script-mode.ts` to `script-worker.ts` child-process contract was deliberately left intact; the partition that owned `script-mode.ts` did not edit `script-worker.ts`, and no breaking change to a shared export was made across partition boundaries.
- `TARGET_AGENT_BROWSER_VERSION` and the upstream version gate still resolve through the retained `scripts/agent-browser-target.mjs` import.

## Updating

Diff a new upstream revision against the base commit, copy the same runtime subset, and reapply every divergence above. Run the target-checking specifier codemod rather than a blind replacement, then update the base revision, version, fork date, rewrite counts, and divergence log here.
