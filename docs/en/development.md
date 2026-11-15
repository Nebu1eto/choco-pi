# Development

[한국어](../ko/development.md)

This page covers the toolchain this repository pins and the checks to run before you trust a change.

## Development environment

`mise.toml` at the repository root pins the toolchain that this checkout is developed and tested with: Node.js `26.13.1`, the newest release, and pnpm `12.21.0`, the version that `package.json` names in `packageManager`. The standalone installer still accepts Node.js 24 or later, and downloads `24.22.3` when it finds none, so code must keep running on Node.js 24. `mise.lock` records the download URL and checksum of each tool for macOS and Linux on arm64 and x64.

1. Install [mise](https://mise.jdx.dev/getting-started.html) and activate it in your shell (`mise activate`), so that `node` and `pnpm` in the checkout run the pinned versions.
2. In the checkout, run `mise install`. Because `mise.toml` holds only tool versions, mise loads it without `mise trust`, unless you turned on paranoid mode.
3. Install the dependencies with `pnpm install --frozen-lockfile`.

```sh
mise install
node --version   # v26.13.1
pnpm --version   # 12.21.0
pnpm install --frozen-lockfile
```

In a shell where mise is not activated, prefix each command with `mise exec --`, for example `mise exec -- pnpm test`.

Without mise, install Node.js 24 or later and run `npm install --global pnpm@12.21.0`. npm installs pnpm's native binary for your platform; check that `pnpm --version` prints `12.21.0`.

pnpm `11.11.0`, the previous pin, still works from `PATH`. In this checkout, it reads `packageManager`, installs pnpm `12.21.0` into its own store, and runs that version for every command, so `pnpm --version` prints `12.21.0` here and `11.11.0` elsewhere. That switch also adds an `@pnpm/exe` entry to the pnpm self-lock at the top of `pnpm-lock.yaml`, which `tests/workspace-policy.test.ts` rejects; revert the entry before you commit. Other pnpm versions on `PATH` are untested. If `pnpm --version` in the checkout prints anything other than `12.21.0`, use mise or the npm command above.

## Development verification

Starting Pi in this checkout does not load the checkout's profile. The extensions, skills, and prompts moved from `.pi/` to `profile/`, so Pi finds no project resources here. Load them through an agent directory instead: either run `npm run install:profile` (which installs into `~/.pi/agent`, or into another directory with `--agent-dir <dir>`), or use the checkout's own launcher with a separate home:

```sh
export CHOCO_PI_HOME="$HOME/.choco-pi-dev"
bin/choco-pi self setup
bin/choco-pi
```

Without `CHOCO_PI_HOME`, a launcher started from a checkout uses `~/.choco-pi`, the home of a standalone install.

Run the root verification gates below. In a shell that Pi started, including an agent's tool call, unset the session variables that Pi exports before you run `pnpm test`; otherwise a subagent scratch-directory test fails:

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT pnpm test
```

`pnpm typecheck` checks the root and each package that has a `tsconfig.json`, and `pnpm test` runs `tests/` and every `packages/*/tests/`.

`pnpm test` leaves out the formal validation tests in `tests/formal/`, which start Java and TLC. `pnpm test --formal` adds them; you need it only when `formal/`, the `formal-verify` skill, or those tests change.

Runtime and TUI changes also need a check in a fresh Pi process. The [verification map](../verification-map.md) lists what to run for each area, how to run a test Pi without credentials, the ACP real-Pi suites, and the formal model and drift checks. A package's own policy may require more checks.
