# Vendored and harness-wide divergences

Package-level divergences live in each package's `VENDORED.md`. This file records harness-wide notes.

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
