# Vendored and harness-wide divergences

Package-level divergences live in each package's `VENDORED.md`. This file records harness-wide notes.

## 2026-11-15: choco-pi startup header and `@choco-pi` package names

- The root package is `choco-pi` `1.0.0-alpha.1` (was `choco-pi-harness` `0.1.0`). `scripts/install-profile.ts` recognizes a checkout by that name. Every bundled package is `@choco-pi/<directory without the choco-pi- prefix>` at the same version; directories keep their names, so settings entries and relative imports are unchanged. Subagent extension allowlists match a package entry by its path-derived name and by the unscoped package name, so `choco-pi-lsp` (an `index.ts` entry named after its directory) still matches, while the package-name alias of each bundled package changes from `choco-pi-<x>` to `<x>`.
- `profile/extensions/startup-header.ts` (new) replaces Pi's startup header through `ctx.ui.setHeader`: the choco-pi logo in half blocks (from `assets/choco-pi-logo.svg`), `v<choco-pi> (pi v<pi>)`, Pi's key hints, and a one-line description. It shows only where Pi decided to show its own header, so `quietStartup: true` still hides it. Pi decides inside `InteractiveMode`, before `session_start`, whether to print the model scope and the loaded-resource listing, and no extension API reaches that decision. The extension therefore patches `InteractiveMode.prototype.shouldShowStartupDetails` to answer only `--verbose`, and wraps `shouldShowStartupHeader` to record the host's choice. Pi still renders load diagnostics when quiet.
- `profile/standalone/settings.seed.json` seeds `quietStartup: "header"` instead of `true`, so a new standalone install shows the header. Existing installs keep the value they have.

## 2026-11-14: mise develops on the newest Node.js

- `mise.toml` pins Node.js `26.13.1` (the newest release, LTS line 26) instead of the runtime pins' `24.22.3`; `mise.lock` was regenerated with `mise lock` for the same four platforms, and its Node.js checksums equal nodejs.org's `SHASUMS256.txt` for v26.13.1. The standalone installer's `node_version`, checksums, and Node.js 24 floor are unchanged.
- `tests/workspace-policy.test.ts` now requires the mise Node.js to be no older than `node_version` instead of equal to it, and checks each `mise.lock` Node.js entry's release URL instead of comparing its checksum with the runtime pins.

## 2026-11-14: self update hands off to the target revision's installer

- `self update` no longer installs a new revision with the running code. It fetches the target, reads only `installer_protocol` from the target's `runtime-pins.txt` (`readPin`, which accepts any pins format), checks the revision out, and runs its own `install.sh` with `--home`, `--bin-dir`, `--source`, `--ref`, `--rev`, and `--runtime`. On failure it restores the previous `install.json`, checks out the previous revision, and reinstalls it with that revision's `install.sh`; the creation journal keeps what the failed run created.
- `install.sh` moves an existing checkout (only forward on the recorded ref, unless `--ref` changes or `--rev` is given) after it read and checked the target's pins with `git show`, provisions Node.js from those pins, then runs `scripts/standalone/bootstrap.ts` (pnpm and dependencies) and stage 1. Without `--source` or `--ref` it uses the values `install.json` records. `installer_protocol` is `3`; `install.sh` refuses any other value, and `self update` refuses a target below `3`.
- Removed: the `upgrade_notice` pin line and its parser exception, the `install.sh` rerun of a moved checkout's stage 1, and the `--app-cloned` and `--node-provisioned` stage 1 switches. None of the installs they served was released.
- `scripts/standalone/manage.ts` is now a dependency-free entry point. The commands (`cli.ts`) parse arguments with `@optique/core` `1.3.6` and log progress and warnings through `@logtape/logtape` `2.4.2` (a synchronous terminal sink: info on stdout, warnings and errors on stderr); data output such as `self env` is written directly. Both are new root dependencies without dependencies of their own. Without `node_modules`, `manage.ts` still runs `self uninstall [--purge]` from the creation journal (`uninstall.ts`) and refuses every other command.

## 2026-11-14: mise development toolchain and pnpm 12.21.0

- `mise.toml` (new) pins the development toolchain: Node.js `24.22.3` (equal to `node_version` in `scripts/standalone/runtime-pins.txt`, the supported floor) and pnpm `12.21.0`. It holds only `[tools]` with plain version strings, so mise loads it without `mise trust` outside paranoid mode. mise installs pnpm through its `aqua:pnpm/pnpm` backend, the native binary from the pnpm GitHub release.
- `mise.lock` (new, `mise lock` for linux-x64, linux-arm64, macos-arm64, and macos-x64) records each download URL and checksum; its Node.js checksums equal the runtime pins. `mise.local.toml` and `mise.local.lock` are ignored.
- `package.json` `packageManager` moves from `pnpm@11.11.0` to `pnpm@12.21.0`, and `pnpm-lock.yaml` gains pnpm 12's leading document that locks pnpm itself (`packageManagerDependencies`); the dependency document is unchanged.
- `tests/workspace-policy.test.ts` checks that `mise.toml`, `mise.lock`, `package.json`, the lockfile's `packageManagerDependencies`, and the runtime pins name one toolchain.
- Standalone installer: stage 1 (`scripts/standalone/provision.ts`, `manage.ts`) provisions pnpm 12 as the native binary from `@pnpm/exe.<platform>` instead of the `pnpm` npm package run through Node. It extracts only `package/pnpm` into `$CHOCO_PI_HOME/runtime/pnpm/pnpm`, checks that it reports the pinned version before replacing an earlier copy, and runs it directly. Platforms without a pinned build (musl Linux, Windows) need pnpm `12.21.0` on `PATH`.
- `runtime-pins.txt`: `pnpm_version 12.21.0`, and the single `pnpm_integrity` became `pnpm_integrity_<platform>` for darwin-arm64, darwin-x64, linux-x64, and linux-arm64. A new `upgrade_notice` line is free text that the current parser skips; the older parser rejects it as malformed and quotes it, which is how a pre-pnpm-12 `self update` tells the user to re-run `install.sh` before it rolls back.
- pnpm containment: `pnpm install` gets `PNPM_HOME=$CHOCO_PI_HOME/runtime/pnpm-home` next to the existing store, cache, and state flags, and `--config.pm-on-fail=error` replaces `manage-package-manager-versions=false`; the PATH probe also sets `pnpm_config_pm_on_fail=ignore`.
- `install.sh` reruns stage 1 once from the moved checkout when the first stage 1 failed after moving `$CHOCO_PI_HOME/app` to another revision, which completes an upgrade from a pnpm 11 install.

## 2026-11-13: one pnpm workspace and two install methods

Layout: the 18 bundled packages moved from the `.pi` directory to `packages/`, and the profile resources (extensions, skills, prompts, agents, `profile/scripts`, and the policy and configuration files) moved to `profile/`. Nothing tracked remains in `.pi/`; it holds only ignored project-local Pi state.

Install model:

- `pnpm-workspace.yaml` declares `packages/*` as members, and the root `pnpm-lock.yaml` is the only lockfile. The seven per-package lockfiles and workspace files, the vendored-package bootstrap script, and the root `postinstall` that ran it are gone. `pnpm install --frozen-lockfile` at the root installs every package.
- The merge kept every direct dependency of the formerly isolated packages at its previous resolved version; each package's `VENDORED.md` records its own change. provider-synthetic's `@earendil-works/pi-ai` and `pi-tui` overrides moved to the root `pnpm-workspace.yaml`.
- Dependency build scripts never run: every `allowBuilds` entry is `false`, which replaces the earlier `--ignore-scripts` installs.
- Root `dependencies` hold what the profile imports at runtime (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-schema`, `lovely-mermaid`, `typescript`), so a `--prod` install starts every extension; lint, format, and test tooling stay in `devDependencies`.

Two install methods use this tree:

- Profile installed into Pi: `pnpm install --frozen-lockfile`, then `pnpm install:profile`, which writes the profile into `~/.pi/agent` (or `PI_CODING_AGENT_DIR` / `--agent-dir`). It rewrites settings and links an old `.pi`-layout install wrote, in the same order.
- Standalone `choco-pi`: `install.sh` clones the app into `$CHOCO_PI_HOME/app` (default `~/.choco-pi`), installs with `--frozen-lockfile --prod` using a pnpm store, cache, and state directory under `$CHOCO_PI_HOME/runtime`, and installs the profile into `$CHOCO_PI_HOME/agent` through `choco-pi self setup`. The pinned Node.js, pnpm, and optional Bun downloads are checksum-verified against `scripts/standalone/runtime-pins.txt`.

## 2026-11-03: validation moves from TypeBox to pi-schema

Validation uses `@earendil-works/pi-schema`. `typebox` (host alias, `^1.3.29`) is imported only inside a package's `schema-bridge.ts`, where `Type.Unsafe` wraps a pi-schema object for `registerTool` / `defineTool` (Pi 1.5.0 still requires a TypeBox schema there). The root bridge is `profile/extensions/lib/schema-bridge.ts`.

One-time prompt-prefix change: tool JSON schemas now serialize differently for the same tool, so the provider prompt cache misses once per tool after the upgrade, then is stable again.

- Literal unions (`StringEnum`, `Type.Union` of literals) serialize as `{ "enum": [...] }` without `type` instead of `anyOf` of `const`.
- Closed objects add `additionalProperties: false`; open objects (the TypeBox default) are built with `{ open: true }` and keep the previous behaviour.
- Numbers that carry finite bounds add `minimum` / `maximum` (`Number.MAX_VALUE`) because pi-schema `num()` accepts NaN and the infinities, which TypeBox rejected. In-process values use `profile/extensions/lib/finite-number.ts` (`finiteNum`).
