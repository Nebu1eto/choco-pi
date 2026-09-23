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
- Derived the retained `README.md` path directly from the fixed source-only entrypoint layouts in `index.ts` and `lib/runtime-extension.ts`, removing redundant synchronous manifest walks and unchecked manifest parsing from registration.

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

### Deferred extension runtime loading

- Split the extension entrypoint into a lightweight registration module and a memoized runtime module. Tool names, labels, descriptions, prompt text, parameter schemas, renderers, and event registrations remain synchronous and byte-identical; the session, orchestration, process, result, and Electron graph loads on the first runtime event or `agent_browser` execution.
- Kept schema-only limits in small constant modules so registering `agent_browser` no longer imports the script runner or Electron discovery implementation. The optional web-search tool likewise registers from a lightweight schema/metadata module and memoizes its existing implementation on first execution.
- This is a load-time-only divergence. External CLI argv construction, result details, lifecycle handling, TypeBox imports, and the retained `.mjs` target-version edge are unchanged.
- Resolve the deferred runtime's retained README directly from its fixed source layout instead of synchronously searching and parsing ancestor package manifests. This preserves standalone-install paths without filesystem work during runtime capture.

### Compact provider schema

- The provider-facing `agent_browser` schema omits descriptive JSON Schema prose while preserving every property, constraint, and runtime validation path. Detailed workflows remain in prompt guidelines and the skill. The tool description and prompt snippet are bounded for the native schema tier.

### Session-tree restoration ownership

- Reserve a branch restoration generation when `session_start` or `session_tree` takes ownership. A queued tree restoration checks that generation after waiting for active scripts and at both serialized queue boundaries, so shutdown or a newer tree event can supersede it before it reads an obsolete extension context.
- Snapshot the restored branch and working directory before asynchronous script-lease recovery. Recovery stops after a lease close when its generation loses ownership, while the current generation retains the existing restore and cleanup behavior.

### Unified web-search backend integration

- Exported production-callable Brave and Exa backend descriptors, non-contacting availability
  classification, guarded execution, and the existing per-runtime sequential request gate for the
  canonical choco-pi web-search integration. Provider IDs are `agent-browser.brave` and
  `agent-browser.exa`; the latter has lower routing precedence than the web-access Exa synthesis
  transports while remaining available for advanced Exa constraints.
- Registered both adapters in the canonical loader-local scope through the shared Pi event bus,
  with one sequential request gate per extension scope and asynchronous context-aware config
  loading. Canonical mode suppresses registration and prompt discovery of
  `agent_browser_web_search`; standalone mode retains its existing name and behavior.
- Preserved credential precedence. The backend boundary rejects unsupported hard constraints
  instead of silently dropping them, checks cancellation/session generation and its own timeout
  after credential and network awaits, and translates authentication, quota, invalid request,
  transient HTTP, network, invalid response, deadline, cancellation, and stale-context failures
  into typed router errors without exposing credentials. HTTP 429 remains nonretryable.
- Added local-fetch regression coverage for Brave locale/pagination/freshness/safety forwarding,
  Exa search type and single-request behavior, normalized source metadata/highlights, availability
  states, sequential gating, queued cancellation, stale generations, all transport error classes,
  canonical response metadata, real Pi wrapper scope isolation, and integrated/standalone tool
  discovery.

## Updating

Diff a new upstream revision against the base commit, copy the same runtime subset, and reapply every divergence above. Run the target-checking specifier codemod rather than a blind replacement, then update the base revision, version, fork date, rewrite counts, and divergence log here.

### Agent-browser compatibility profiles

- Replaced exact 0.34.0 rejection with tested profiles for 0.34.0, 0.35.2, 0.36.0, 0.37.1, and 0.38.1. Version drift is advisory; concrete missing safety capabilities remain operation-specific failures.
- Added executable fingerprinting over resolved path, realpath, size, and modification time so upgrades and symlink retargeting invalidate warning state. Aborted and failed probes are not cached.
- Added 0.38.1 global grammar for input mode, CA trust, and WebMCP control, plus WebMCP/recording option arities. Nested full snapshots retain their tree and refs.
- Migrated changed doctor and target metadata executables to erasable TypeScript. The doctor uses the shared host identity helper when installed in choco-pi and safely falls back when the standalone vendored package lacks it.
- Browser-version warnings remain successful and are exposed in headless result metadata once per executable fingerprint. The doctor uses only real package commands and exits nonzero only for genuine failures.
- Bound PATH discovery, version probing, script/QA workers, normal commands, and cleanup to the same resolved real executable through per-invocation async context, including explicit Windows launcher paths.
- Added source-derived capability introduction profiles: CA trust in 0.35, WebMCP in 0.36, recording FPS in 0.37, and snapshot deltas, conditional screenshots, input modes, recording cursor/contact sheets in 0.38. Known older profiles reject only requested unsupported operations; future versions remain advisory.
- Added bounded snapshot revision reconstruction scoped to namespace/session plus wrapper-owned tab/document generations, URL, and snapshot options. Missing or incompatible baselines trigger at most one read-only full refresh; nested batch deltas fail before execution when intermediate identity cannot be proven.
- Added pre-spawn video/contact-sheet collision checks, persisted multi-destination recording reservations, WebMCP params-file validation/redaction, and generation/frame/session-scoped detached invocation ownership and cleanup.

### Live compatibility corrections

- Exact upstream binaries 0.34.0, 0.35.2, 0.36.0, 0.37.1, and 0.38.1 passed the isolated macOS arm64 CLI matrix. A fresh Pi 0.86.1 host also exercised the native script path with 0.38.1. These checks do not establish live compatibility on other platforms.
- Derive recording contact sheets as `<stem>.contact-sheet.png`, matching the observed 0.38.1 output. Reserve that exact destination before recording; artifact presentation also accepts historical hyphen-form filenames.
- Make the script worker self-contained and grant Node's permission model read access only to its worker file. This fixes the pre-dispatch `ERR_ACCESS_DENIED` startup failure without exposing general filesystem, process, or network access to sandbox scripts. The production-child regression uses the supported `browser(...)` and `emit(...)` API.
- Classify compatibility capabilities by parsed command grammar rather than raw token presence, so positional values, option values, unrelated same-named flags, and tokens after `--` do not create false requirements.
- Protect every active recording reservation destination, including contact sheets, from general artifact and `outputPath` writes while preserving recording cleanup operations.
- Translate backend-local search deadlines into retryable attempt deadlines at the canonical adapter boundary so router fallback and fan-out continue without weakening total-deadline handling.

## Pi SDK target alignment

Host-provided Pi SDK peer contracts and any development SDK dependencies now
require exactly `0.86.1`, matching the harness target. This SDK alignment is
separate from installer policy; TypeBox and unrelated
dependencies retain their existing contracts.
