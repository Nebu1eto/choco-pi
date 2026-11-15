# Install and update

[한국어](../ko/installation.md)

This page covers what choco-pi needs, the two ways to install it, and how to update, reload, and remove it.

## Requirements

- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) for browser automation. Versions 0.34.0, 0.35.2, 0.36.0, 0.37.1, and 0.38.1 are tested; other versions still run but show an advisory warning.
- Optional: macOS 14 or later for computer use (see [Set up computer use](computer-use.md))

Each [installation method](#installation) has further requirements:

- **Standalone `choco-pi` command**: macOS on arm64 or x64, or Linux with glibc on x64 or arm64; `tar`; `curl` or `wget`; and a SHA-256 tool (`shasum`, `sha256sum`, or `openssl`). The installer uses Node.js 24 or later and pnpm `12.21.0` when they are on `PATH`, and otherwise downloads pinned copies. Windows and musl-based Linux, such as Alpine, are not supported; on Windows, use WSL2 with a glibc distribution.
- **Profile installed into Pi**: Node.js 24 or later, exactly pnpm `12.21.0`, and Pi `1.5.2` or a later `1.5.x` release (`>=1.5.2 <1.6.0`), which matches this checkout's `~1.5.2` SDK range. [Development environment](development.md#development-environment) shows how to install the pinned Node.js and pnpm, with or without mise.

## Installation

There are two ways to install choco-pi. Both load the same profile; they differ in which Pi runs it and where its state lives. You can install both on the same machine.

|                           | Standalone `choco-pi` command               | Profile installed into Pi          |
| ------------------------- | ------------------------------------------- | ---------------------------------- |
| Command                   | `choco-pi`                                  | `pi`                               |
| Pi                        | The version this repository's lockfile pins | The `pi` you installed             |
| Code                      | A clone in `~/.choco-pi/app`                | Your checkout                      |
| Login, sessions, settings | `~/.choco-pi/agent`, separate from `pi`     | `~/.pi/agent`, shared with `pi`    |
| Update                    | `choco-pi self update`                      | Pull, then rerun the install steps |

### Install the standalone `choco-pi` command

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
sh choco-pi/install.sh
choco-pi
```

The installer clones its own copy of the repository into `~/.choco-pi/app`, so you need the first clone only to run the script. The installer:

- Uses Node.js 24 or later from `PATH`. If there is none, it downloads the pinned Node.js into `~/.choco-pi/runtime/node` and checks its SHA-256 against `scripts/standalone/runtime-pins.txt` before extracting it.
- Uses pnpm from `PATH` only when it is exactly `12.21.0`. Otherwise, on macOS or glibc Linux on arm64 or x64, it downloads the native pnpm binary from `@pnpm/exe.<platform>`, checks it against the pinned integrity hash, and stores it as `~/.choco-pi/runtime/pnpm/pnpm`; pnpm never runs through Node.js. On other platforms, put pnpm `12.21.0` on `PATH` first.
- Keeps all pnpm data in `pnpm-store`, `pnpm-cache`, `pnpm-state`, and `pnpm-home` under `~/.choco-pi/runtime`. It sets `PNPM_HOME` for pnpm, so pnpm writes nothing to `~/Library/pnpm` or the XDG directories.
- Installs the production dependencies from the lockfile, installs the profile into `~/.choco-pi/agent`, and records what it created in `~/.choco-pi/install.json`.
- Links `~/.local/bin/choco-pi` to the launcher. If that directory is not on `PATH`, it prints the `export PATH=...` line to add to your shell configuration.

It never uses `sudo` or a global npm install. If Git is missing, it prints how to install Git on your system and stops. Running it again is safe; it is idempotent.

| Flag                  | Default                                                              | Effect                                                      |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `--home DIR`          | `$CHOCO_PI_HOME`, else `~/.choco-pi`                                 | Install home (`CHOCO_PI_HOME`)                              |
| `--bin-dir DIR`       | `~/.local/bin`                                                       | Directory for the `choco-pi` link                           |
| `--source URL\|PATH`  | The recorded source, else `https://github.com/Nebu1eto/choco-pi.git` | Repository to clone; a local path also works                |
| `--ref REF`           | The recorded ref, else the default branch                            | Branch or tag to install                                    |
| `--rev COMMIT`        | The tip of REF                                                       | Install exactly this commit of REF (`self update` uses it)  |
| `--runtime node\|bun` | `node`, or the runtime an earlier install recorded                   | What runs Pi; see [Choose the runtime](#choose-the-runtime) |

`sh install.sh --help` also lists the mirror variables `CHOCO_PI_NODE_MIRROR`, `CHOCO_PI_NPM_REGISTRY`, and `CHOCO_PI_BUN_MIRROR`. Downloads from a mirror are still checked against the pins.

The launcher finds its install home from its own path, so you do not need to set `CHOCO_PI_HOME`; if you do set it, your value takes precedence. When `choco-pi` opens, run `/login`: the standalone command does not use `pi`'s login.

#### First-run settings

The first `choco-pi self setup`, which `install.sh` runs, adds these settings from `profile/standalone/settings.seed.json` to `~/.choco-pi/agent/settings.json`:

| Key                      | Seeded value                       | Pi's default             |
| ------------------------ | ---------------------------------- | ------------------------ |
| `theme`                  | `nord-dark` (from `choco-pi-ui`)   | terminal's dark or light |
| `fullscreenExitOutput`   | `resume-hint`                      | `transcript`             |
| `fuzzyFileMentions`      | `true`                             | `false`                  |
| `cacheWarming`           | `streaming`                        | `idle`                   |
| `quietStartup`           | `"header"`                         | `false`                  |
| `enableInstallTelemetry` | `false`                            | `true`                   |
| `terminal`               | `{ "showTerminalProgress": true }` | `false`                  |

Setup adds each key at most once: only when the file lacks it and no earlier setup has offered it. `self setup` and `self update` never overwrite a value you set and never add back a key you deleted; a later seed version adds only the keys that are new in that version. Setup records what it offered in `~/.choco-pi/agent/choco-pi/settings-seed.json`. To change the values, edit `settings.json` or use `/preferences` and Pi's `/settings`.

Setup imports nothing from `pi` or `~/.pi` unless you ask it to (see [Optional: import your `pi` preferences once](#optional-import-your-pi-preferences-once)). It leaves unset the values that depend on your provider or are personal: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `agentLanguage`, `sessionAutoNameModel`, and `hooks`. The standalone setup writes no `enabledModels` scope, because Pi warns at every start about each scoped model whose provider has no login yet. After `/login`, set a scope with `/scoped-models` if you want one.

The first setup ends by listing the next steps: start `choco-pi`, run `/login` (credentials are stored only in `~/.choco-pi/agent/auth.json`), and open `/preferences`.

#### Optional: import your `pi` preferences once

```sh
choco-pi self setup --import-pi-settings [--from FILE] [--force]
```

This is the only standalone command that reads `~/.pi`, and it does so only when you run it. It reads exactly one file, `$HOME/.pi/agent/settings.json` (or `FILE`), and copies the preference keys that Pi 1.5.2 or choco-pi itself reads, such as `theme`, `defaultModel`, `modelThinkingLevels`, `agentLanguage`, and `agentStyle`. Each value is checked against what its reader accepts.

It never copies paths, commands, identities, trust settings, or credentials (`packages`, `extensions`, `skills`, `prompts`, `hooks`, `deviceId`, changelog markers, `defaultProjectTrust`, `httpProxy`, and similar keys). It never opens `auth.json`, `sessions/`, `trust.json`, `mcp.json`, `models.json`, or any other file under `~/.pi`.

A value you set in choco-pi always wins. A key is copied only when `~/.choco-pi/agent/settings.json` lacks it or still holds the first-run seed value, and a `modelThinkingLevels` entry only replaces a profile default. The run prints the names of the copied, skipped, and kept keys (never their values) and records itself in `~/.choco-pi/agent/choco-pi/settings-import.json`. A second run refuses to start unless you pass `--force`, and even then it leaves every key that an earlier import set, or that you changed, as it is.

#### Update and uninstall

```sh
choco-pi self update
choco-pi self uninstall
```

`self update` fetches the recorded branch or tag (`--ref REF` picks another), checks out the new revision, and runs that revision's own `install.sh`. Because the new revision's code installs its own Node.js, pnpm, and dependencies, an update also works across a change of toolchain or pin format. `self update` refuses to run when the app checkout has local changes, when the move is not a fast-forward of the recorded ref, or when the target revision is too old to take over its own installation this way. If the new revision's installer fails, it checks out the previous revision again and reinstalls it with that revision's own installer. Stop running sessions before you update.

Running `install.sh` again over an existing install follows the same steps: it moves the checkout first, then runs that revision's code. Without `--source` or `--ref`, it keeps the recorded source and ref. Add `--help` after a `self` command to see its options.

`self uninstall` removes what `install.json` records: the `choco-pi` link (only while it still points to this launcher), `app/`, `runtime/`, and `install.json`. It keeps `agent/` (login, sessions, settings) and `lsp/`; `choco-pi self uninstall --purge` removes them too. It never touches `~/.pi`.

| Command                                    | Purpose                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `choco-pi self setup`                      | Reinstall the profile into `~/.choco-pi/agent` (idempotent)       |
| `choco-pi self setup --import-pi-settings` | Optionally copy preferences once from `~/.pi/agent/settings.json` |
| `choco-pi self runtime [node\|bun]`        | Show or set the runtime that Pi runs on                           |
| `choco-pi self env`                        | Print the launcher's environment contract                         |
| `choco-pi self exec <cmd> [args...]`       | Run a command in that environment                                 |
| `choco-pi self acp [args...]`              | Run the ACP adapter for editors ([Zed](zed-setup.md))             |
| `choco-pi self help`                       | List the `self` commands                                          |

The launcher handles a command itself only when its first two arguments are `self` and one of these verbs. It passes everything else to Pi unchanged, for example `choco-pi --version` or `choco-pi --mode rpc`.

#### Choose the runtime

Pi runs on Node.js by default. Bun is opt-in:

```sh
choco-pi self runtime bun
choco-pi self runtime node
choco-pi self runtime
```

`self runtime bun` uses a `bun` on `PATH` that is at the pinned minimum version or later. Otherwise it downloads the pinned Bun into `~/.choco-pi/runtime/bun` and checks its SHA-256. It records the choice in `install.json` only after Pi has started on Bun. `sh install.sh --runtime bun` does the same at install time, `self runtime node` switches back, and `self runtime` on its own shows the current runtime and where that choice came from. `CHOCO_PI_RUNTIME=node` or `CHOCO_PI_RUNTIME=bun` overrides the choice for a single run. If Bun is selected but missing, the launcher stops with instructions instead of falling back to Node.js.

Bun does not remove the need for Node.js: the installer, every `self` command including `self acp`, and the child processes that need Node.js still run on it. Bun starts Pi with `--no-env-file` and `--no-install`, so a project's `.env`, `bunfig.toml` preloads, and Bun's auto-install do not affect Pi.

#### Separation from `pi`

The standalone command keeps its own login (`auth.json`), sessions, settings, trust decisions, MCP configuration, and caches under `~/.choco-pi`, and never writes to `~/.pi`. It reads `~/.pi` only through the optional `self setup --import-pi-settings`, which reads `~/.pi/agent/settings.json` and nothing else. Wherever these docs name a path under `~/.pi/agent`, the standalone command uses the same path under `~/.choco-pi/agent` (`$CHOCO_PI_HOME/agent`).

Some things are shared by design:

- A project's `.pi/` directory, such as `.pi/settings.json` or `.pi/mcp.json`, holds project configuration, which `choco-pi` reads just as `pi` does. If you start it with your home directory as the working directory, Pi treats `~/.pi` as that project's configuration directory. This is stock Pi behavior, and it goes through Pi's project trust check.
- Locations shared across agents: hooks in `~/.claude/settings.json` and `~/.agents/settings.json`, and skills in `~/.agents/skills`.
- The help text and terminal title still say `pi` (π), because choco-pi runs Pi unmodified.

In the Rex terminal:

- Under Node.js, Rex shows a `choco-pi` pane exactly like a `pi` pane. The launcher replaces itself with Node.js running Pi, so Rex sees the same foreground process, title (`π - …`), and program status (`app: pi`).
- Under Bun, the title and program status are the same, but the foreground process is `bun` running Pi's `cli.js`.
- Rex's SessionStart context reaches choco-pi through its hook in `~/.claude/settings.json`. A Rex hook that exists only in `~/.pi/agent/settings.json` does not reach standalone sessions.
- The `rex` skill in `~/.agents/skills` is shared with `pi`.

### Install the profile into Pi

Clone the repository to a path that will not change. The profile installer records absolute paths in Pi's user configuration, so if you move the checkout later, run the installer again from the new location. First follow [Install Pi without Homebrew](#install-pi-without-homebrew), then install the profile:

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

mise install
pnpm --version

pnpm install --frozen-lockfile
npm run install:profile
pi
```

`mise install` installs the Node.js and pnpm versions that `mise.toml` pins, and `pnpm --version` must then print `12.21.0`. To set them up without mise, see [Development environment](development.md#development-environment).

The checkout ships no `.pi/settings.json`; the installer reads the profile policy from `~/.pi/agent/settings.json`. On a new machine, where that file is missing or lists no bundled packages, the installer writes the bundled package list and the built-in policy itself. Afterward, add any other keys you want from [Example global settings](configuration.md#example-global-settings).

#### Install Pi without Homebrew

choco-pi does not support Pi installed with Homebrew, because the `pi-coding-agent` formula lags behind the pinned release. Install Pi with the official installer:

```sh
curl -fsSL https://pi.dev/install.sh | sh
```

The installer creates the managed launcher `~/.pi/agent/bin/pi` and links it from `~/.local/bin/pi`. In your shell configuration, put `~/.local/bin` before `/opt/homebrew/bin`, then confirm the version:

```sh
export PATH="$HOME/.local/bin:$PATH"
pi --version
```

The command must print `1.5.2` or a later `1.5.x` release. Later 1.5 patch releases work without a change to the checkout. The official installer always installs Pi's current release. If that release is outside the range, such as `1.6.0`, `/check` fails, and the profile installer does not record that launcher until this checkout's range has been reviewed and moved to include it.

Pi 1.5's `cli.js` launcher turns on Node's compile cache. If you are diagnosing unusual module-load errors, set `NODE_DISABLE_COMPILE_CACHE=1` to turn it off.

When Pi opens, run `/login` and select a provider. The installation scripts do not authenticate, open a login flow, or copy credentials into the repository.

The repository is one pnpm workspace: `pnpm install --frozen-lockfile` installs the root and all 18 packages under `packages/` from the single root `pnpm-lock.yaml`. Dependency build scripts never run, because `pnpm-workspace.yaml` sets each one to `false` under `allowBuilds`.

A checkout installed before the profile moved from `.pi/` to `profile/` and `packages/` upgrades in place: after pulling, rerun `pnpm install --frozen-lockfile` and `npm run install:profile`. The profile installer rewrites this checkout's old paths in your settings without changing their order, keeps your own entries, and relinks the profile files. A profile file you replaced yourself still needs `--backup`. Git leaves the old, ignored `node_modules` directories under `.pi/` in place; delete them once the new install works.

`npm run install:profile` preserves the existing runtime and authentication state and the packages you added, writes absolute checkout paths, and links the tracked profile resources into `~/.pi/agent` (or `PI_CODING_AGENT_DIR` / `--agent-dir`). It does not link MCP configuration. If a target already holds unrelated content, the installer stops. Review the conflict, and if replacing the content is right, run `npm run install:profile -- --backup` to keep a copy and replace it.

After a successful install, it atomically writes `choco-pi/profile.json` in that agent directory with the checkout path, the Git revision (null if unavailable), the observed Pi version, the launcher path, and the host-bridge schema. For the launcher, it takes `--pi-launcher <path>`, then `CHOCO_PI_LAUNCHER`, then the first `pi` on `PATH` that reports a version in `>=1.5.2 <1.6.0`; if it finds none, it records null and prints a warning. External hosts such as Waku use this marker to identify the profile, and `harness_check` warns about a missing marker, a checkout mismatch, or an incompatible launcher.

## Updating and reloading

Stop running Pi sessions before you replace their dependency trees. To update the standalone command, run `choco-pi self update` (see [Update and uninstall](#update-and-uninstall)). To update the profile installed into Pi, pull the repository changes, keep the same Node.js and pnpm versions, and rerun the frozen install and the profile install:

```sh
pnpm install --frozen-lockfile
npm run install:profile
```

Restart Pi after an update. If you edit files under `profile/` or `packages/` during a running Pi session, run `/reload` to reload extensions, skills, prompts, themes, and linked profile files.
