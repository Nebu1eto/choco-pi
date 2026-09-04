# choco-pi-acp

`choco-pi-acp` connects an ACP client such as Zed to choco-pi. It speaks ACP
JSON-RPC over standard input/output, starts Pi in RPC mode for the selected
working directory, and translates prompts, commands, extension UI, tool calls,
and Pi-owned session history.

This package is private and repository-local. It is **not published** to npm or
the ACP Registry. Do not use the upstream registry or `npx pi-acp` when you
intend to run this fork.

## Upstream relationship

The package is derived from `pi-acp@0.0.33` at the pinned upstream revision
recorded in [VENDORED.md](VENDORED.md). That file records imported files and
every local divergence. The unmodified upstream project documentation is
retained as [README.upstream.md](README.upstream.md); its install, runtime, and
feature statements describe upstream and do not override this README.

## Runtime and invocation

Node.js 24 LTS or newer is required. The package uses Node-erasable TypeScript
directly from source and has no build step or generated runtime output.

From the repository root, install dependencies and run the adapter with:

```sh
pnpm install
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts
```

Zed setup writes the equivalent invocation with absolute paths:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --dry-run
```

See [the Zed setup guide](../../../docs/zed-setup.md) before applying changes to
a real Zed profile.

## Command reference

All commands run through `node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts`.
There is no `--help`; unknown options fail with a nonzero exit.

| Invocation                         | Effect                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| (no arguments)                     | Start the ACP adapter on stdio. This is what Zed launches.                                        |
| `--terminal-login`                 | Run Pi's provider login or API-key setup in a terminal, then exit.                                |
| `--terminal-trust <absolute-dir>`  | Open Pi in a terminal so its one-time project trust prompt can be answered for that directory.    |
| `zed setup --dry-run`              | Print the settings and Tasks changes that setup would write, without touching files.              |
| `zed setup --apply`                | Write the `choco-pi` agent entry and Tasks. Refuses to overwrite a conflicting existing entry.    |
| `zed setup --apply --replace`      | Replace an existing `choco-pi` agent entry and the six choco-pi Task labels only.                 |
| `zed doctor`                       | Compare installed settings and Tasks with this checkout; nonzero on missing or conflicting setup. |
| `zed remove --dry-run` / `--apply` | Remove the choco-pi agent entry and Tasks that setup installed.                                   |

`setup`, `doctor`, and `remove` accept `--zed-config-dir <dir>` to operate on an
alternate Zed configuration directory instead of `~/.config/zed` (on Linux,
`$XDG_CONFIG_HOME/zed` when that variable is absolute). macOS and Linux are the
supported platforms. Exactly one of `--dry-run` or `--apply` is required for
`setup` and `remove`; `doctor` accepts neither. Backups and conflict rules are
described in the setup guide.

## Environment variables

Set these in the agent's environment (the `env` block of Zed's agent entry) or
in the shell that starts the adapter.

| Variable                         | Default                 | Effect                                                                                                              |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PI_ACP_PI_COMMAND`              | `pi` resolved on `PATH` | Executable path of the Pi CLI to spawn in RPC mode.                                                                 |
| `PI_ACP_ENABLE_EMBEDDED_CONTEXT` | unset (disabled)        | Exactly `true` advertises the ACP embedded-context capability; otherwise resource blocks are discarded. See below.  |
| `PI_ACP_MAX_LIVE_SESSIONS`       | `8`                     | Live Pi children retained per adapter connection, 1 through 32; the least recently used beyond the bound is closed. |
| `PI_ACP_SESSION_IDLE_MS`         | `600000` (10 minutes)   | Idle timeout before an otherwise idle Pi child is reaped, clamped to 60,000 through 7,200,000 ms.                   |
| `PI_ACP_REAL_PI`                 | unset                   | Test-only: `1` opts the package test suite into tests that spawn a real Pi process.                                 |

## Embedded editor context

The adapter advertises the ACP embedded-context capability only when
`PI_ACP_ENABLE_EMBEDDED_CONTEXT` is set to exactly `true`. When the capability
is disabled, resource blocks that a client sends anyway are **discarded**, not
rendered into the prompt by a fallback path.

This is deliberate and it diverges from
[README.upstream.md](README.upstream.md): the capability flag is the consent
boundary for editor content, and editor selections may contain secrets. A
fallback that quietly forwarded resource text would let a client bypass that
consent, so the disabled state fails closed. Enable the flag when you want
editor context; do not rely on an implicit fallback. See divergence 16 in
[VENDORED.md](VENDORED.md).

## Package layout

- `bin/choco-pi-acp.ts` routes Zed setup commands and starts the ACP adapter.
- `src/index.ts` owns the stdio ACP connection, terminal login/trust entry
  points, and adapter shutdown.
- `src/acp/` implements ACP sessions, commands, authentication, extension UI,
  persistence mappings, and `src/acp/translate/`, which converts ACP prompts,
  Pi messages, Pi tool events, and bash output between the two protocols.
- `src/pi-rpc/` resolves and owns the Pi RPC subprocess.
- `src/translate/tool-presentation.ts` normalizes translated tool calls into the
  editor-facing presentation (titles, locations, diffs, terminal metadata).
- `src/zed/` implements Zed setup, doctor, and removal.
- `tests/` contains the retained upstream suite plus choco-pi integration and
  regression tests.

The executable adapter is not a Pi extension and therefore has no `pi` or
`pi.extensions` manifest entry.

## Tests

Run the package suite from the repository root:

```sh
pnpm --dir .pi/packages/choco-pi-acp test
```

Real-Pi tests are skipped by default. Opt in only when a working `pi`
executable and disposable test environment are available:

```sh
PI_ACP_REAL_PI=1 pnpm --dir .pi/packages/choco-pi-acp test
```

The repository-wide gates also cover this package:

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm test
```
