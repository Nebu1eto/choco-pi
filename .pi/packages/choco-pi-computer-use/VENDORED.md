# Vendored: choco-pi-computer-use

This directory is a **vendored, renamed fork** of the upstream open-source package **@injaneity/pi-computer-use**. It is not the original repository.

- Original source: https://github.com/injaneity/pi-computer-use
- Base commit: `de72583`
- Base version: `0.5.0`
- Forked on: 2026-08-22
- License: MIT (upstream `LICENSE` copied verbatim)

## What was taken

- `extensions/computer-use.ts`, the TypeScript extension entry.
- All 27 files under `src/`, including the macOS, Linux, and Windows dispatch backends and the shared `helper-path.mjs` module.
- `scripts/setup-helper.mjs`, retained at its original package-relative path for runtime macOS helper installation.
- All four `native/macos/*.swift` files for source hashing and the opt-in `PI_COMPUTER_USE_ALLOW_BUILD=1` fallback.
- The arm64 and x64 loose helper binaries under `prebuilt/macos/` (about 1.1 MB total).
- The upstream MIT `LICENSE` verbatim.

## Divergences

### Package identity and loading

- Renamed `@injaneity/pi-computer-use` to `choco-pi-computer-use`, changed the version to `0.5.0-choco.0`, marked it private, and declared that it supersedes the upstream package.
- Pinned `pi.extensions` to `./extensions/computer-use.ts` instead of scanning the extension directory.
- Removed the npm `postinstall` script. Local harness packages are not installed by npm; helper setup remains runtime-driven.
- Removed the upstream `pi.image` field and all package metadata aimed at publishing the upstream project. Added only the package-local `typecheck` script.
- Kept `typebox` and `@earendil-works/*` as optional host-provided peer dependencies. There are no other third-party runtime dependencies, so this fork has no vendored `node_modules/`.
- Added `tsconfig.json` extending the harness root configuration; there is no build step and no `dist/`.

### Runtime helper installation

- Kept the package-relative runtime installer call. On macOS, `ensureComputerUseSetup` and tool execution reach the current platform's `ensureReady`; `ensureMacosReady` calls `MacosHelperClient.ensureInstalled`, which spawns `scripts/setup-helper.mjs --runtime` only when the resolved helper executable is absent.
- Removed the GitHub-release ZIP fallback from `scripts/setup-helper.mjs`, including release URL/tag constants, network fetches, timeout handling, archive extraction, SHA256SUMS parsing and verification, temporary release files, fallback warnings, and release-specific help text. The fork version would not name an upstream release, and both architecture binaries are committed.
- Retained installation of a pre-signed app bundle when one exists, wrapping of the committed loose macOS binary, Developer ID/local/ad-hoc signing, LaunchServices registration, source-hash tracking, and the opt-in Swift build fallback.
- Corrected the build-fallback gate so runtime invocation alone does not enable Swift compilation. A build now requires `--allow-build` or `PI_COMPUTER_USE_ALLOW_BUILD=1`; upstream also enabled it implicitly for `--runtime`.
- Removed Windows and Linux setup/build branches, paths, Cargo invocation, prebuilt copying, and related help text from the setup script. The script now rejects non-macOS platforms explicitly.

### Platform support and removed trees

- Native helper installation is supported only on macOS in this fork.
- Kept `src/platform/{linux,windows}` because platform dispatch guards those small TypeScript backends, but removed `native/{linux,windows}` and their Rust crates and build scripts. Removed non-macOS prebuilts as well.
- Removed `.github/`, `demo/`, `notes/`, `assets/`, `docs/`, `package-lock.json`, the root upstream `.gitignore`, and upstream project-process/readme files. The fork supplies a concise package `README.md` and `AGENTS.md` that state macOS-only support.
- Removed `scripts/build-native.mjs`, every `scripts/check-*.mjs`, and the remaining development-only scripts and signing assets (`make-signing-cert.sh`, `pi-computer-use.entitlements`, `pi-cubench-agent.mjs`). The package retains only the runtime installer.

### Erasable TypeScript

Node strip-types must load every source file. Three constructors used parameter properties; all were desugared without changing behavior:

- `src/cdp.ts` `CdpTab`: `ws`, `targetId`, and `title` are explicit fields assigned in its private constructor.
- `src/runtime.ts` `StaleResourceStateError`: `resourceKey`, `expectedEpoch`, and `actualEpoch` are explicit readonly fields assigned in the constructor.
- `src/runtime.ts` `StateStore`: `limit` is an explicit private readonly field assigned in the constructor, preserving the default value `128`.

No enums, namespaces, decorators, or other constructor parameter properties remain.

### Anti-slop type hardening

- Hardened the vendored TypeScript and setup script to satisfy the harness anti-slop rules without suppressions. The changes are type-only and behavior-preserving: protocol-owned response types, recursive JSON/accessibility node types, named result types, and boundary predicates replace `unknown`, broad dictionaries, widening assertions, and inline representation checks.
- Preserved all 11 tool names and schemas. Conditional helper request fields are still added only when present; no request field, JSON encoding, command name, response interpretation, or ordering assumption changed.
- The macOS helper IPC path now gives daemon envelopes and command results explicit protocol types. The Linux and Windows backends received compile-time protocol types only and remain dispatch-guarded and unsupported by this fork.
- Permission handling only names the existing `checkPermissions` response and source fields. Accessibility and Screen Recording decisions, attribution handling, prompts, and failure gates are unchanged.
- Helper setup and discovery logic are unchanged. The setup script replaces two representation checks with equivalent primitive/API-presence checks; installation, hash/staleness checks, signing, and LaunchServices registration retain their existing control flow.

### Tests and documentation

- Replaced the upstream source-text `scripts/check-tool-schemas.mjs` check with `tests/load.test.ts`, which imports the extension and bridge under Node strip-types and pins all 11 tool names plus their parameter-property and required-field shapes.
- Made `stateId` optional for the read-only `search_ui`, `expand_ui`, and `inspect_ui` tools. On a fresh operation they now establish a semantic observation internally; this capture disables OCR and images and never delivers input. The `act_ui.stateId` schema is also optional so a missing state reaches its structured runtime refusal, but actions remain state-bound and never auto-observe.
- Defined observation staleness using the existing per-resource scheduler epoch: an action state is stale when its saved epoch differs from the resource's current epoch after a write. Missing and stale action states now throw `ObservationRefreshRequiredError`, whose JSON message and typed `requirement` include `code`, `operation`, `reason`, the requested `stateId` when available, exact `observe_ui` refresh arguments, and both epochs for stale states.
- Added a test-only platform-backend replacement hook so transition tests can exercise full bridge executors without installing or invoking native helpers.
- Added this provenance record, package working rules, and fork-specific README.

## Updating

Diff a fresh checkout of the upstream repository against base commit `de72583`, then reapply every divergence above. Preserve explicit `.ts` relative imports and the one deliberate `.mjs` import. Do not restore npm lifecycle installation, network downloads, or non-macOS native helper support without an explicit fork decision.
