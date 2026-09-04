# choco-pi-editor-context

`choco-pi-editor-context` carries editor state (file, cursor, language, symbol,
worktree, optional selection) from an editor into a running Pi session. Editor
integrations such as the Zed Tasks installed by `choco-pi-acp` publish a
snapshot through the CLI; the Pi extension in this package consumes the newest
accepted snapshot immediately before the next agent turn and injects a bounded
`[Editor context]` block.

The package is private and repository-local. It requires Node.js 24 or newer
and runs from TypeScript source with no build step.

## Installation

Pi loads the extension only from the global choco-pi profile:

```sh
pnpm install
pnpm install:profile
```

Without `install:profile`, `publish` can still write a snapshot, but no Pi session
will consume it.

## CLI

All commands run through
`node .pi/packages/choco-pi-editor-context/src/cli.ts`.

| Command                                                                               | Effect                                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `publish --cwd <dir> --path <file> [--line N --column N] [--language L] [--symbol S]` | Validate and write a snapshot for the targeted live session in `<dir>`. Line and column are one-based.               |
| `publish ... --selection-env <VAR>` or `--selection-file <file>`                      | Include selected text read from an environment variable or a file, subject to the size bound.                        |
| `publish ... --no-selection-text`                                                     | Publish location metadata only; never read or write selection text.                                                  |
| `publish ... --zero-based-position`                                                   | Treat `--line` and `--column` as zero-based and convert them. Zed supplies one-based values, so its Tasks omit this. |
| `publish ... --session-id <id> --owner-id <id>`                                       | Target one session explicitly; both identifiers are required together and override a stored target.                  |
| `list --cwd <dir>`                                                                    | Print up to 20 live Pi sessions whose canonical worktree matches `<dir>`, each with a ready-to-run `select` command. |
| `diagnose --cwd <dir>`                                                                | Same output as `list`; nonzero when nothing matches.                                                                 |
| `select --cwd <dir> --session-id <id> --owner-id <id>`                                | Persist the target session for that worktree; it is revalidated before every publish.                                |
| `select --cwd <dir> --clear`                                                          | Forget the stored target.                                                                                            |

Target precedence is explicit `--session-id`/`--owner-id`, then the stored target,
then a single live match. With more than one live match and no target, `publish`
fails with `LIVE_TARGET_AMBIGUOUS` rather than guessing. Worktree matching resolves
symbolic links on both sides. `publish` runs the consuming session's own validation
before writing anything and reports bounded diagnostic codes with a nonzero exit
when the session would reject the payload.

Snapshots expire after 30 seconds and are consumed once. Publishing is an
explicit action, not ambient tracking; run it again after focus, cursor, or
selection changes.

## Package layout

- `index.ts` is the Pi extension entry and re-exports the public API.
- `src/protocol.ts` defines editor-context protocol v1.
- `src/security.ts` validates documents, paths, and size limits.
- `src/context-store.ts` owns the atomic, mode 0600 context store with
  ownership, expiry, and crash-leftover cleanup.
- `src/context-target.ts` persists the per-worktree selected target.
- `src/live-session-client.ts` discovers live Pi sessions.
- `src/context-extension.ts` injects the `[Editor context]` block before an
  agent turn.
- `src/cli.ts` implements `publish`, `select`, `list`, and `diagnose`.

## Tests

```sh
pnpm --dir .pi/packages/choco-pi-editor-context test
```

The repository gates (`pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm test`)
also cover this package. See [the Zed setup guide](../../../docs/zed-setup.md)
for the editor-side workflow.
