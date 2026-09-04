# Use choco-pi in Zed

This guide configures a repository checkout of choco-pi as a custom Zed ACP
agent. It does not install or fetch a published package.

## Prerequisites

- Node.js 24 LTS or newer. Bun is not supported. The current checkout is
  source-executed TypeScript and produces no build output.
- Zed. The currently installed and verified editor is Zed 1.18.0; that is a
  baseline, not a hard minimum. Older Zed releases receive best-effort support.
- A local clone of this repository whose path will remain stable.
- `pi` installed and available on `PATH`, with a model provider configured.
  Set `PI_ACP_PI_COMMAND` to an executable path if `pi` is elsewhere.

From the repository root, install dependencies and install the choco-pi
profile:

```sh
pnpm install
pnpm install:profile
```

The `install:profile` step is required. It adds the
`choco-pi-editor-context` package from this checkout to Pi's global profile;
without it, Tasks can publish context but a Pi session will not consume it.
The installer reports every linked or updated path. If it finds conflicting
profile files, review them and rerun `pnpm install:profile --backup` only if
you want it to preserve and replace those files.

## Preview and apply Zed setup

Back up your Zed configuration before applying changes. Then preview the exact
result:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --dry-run
```

The preview reads the existing JSON-with-comments files and prints the full
intended settings and Tasks documents without writing anything. Review the
absolute Node and checkout paths in that output. Apply only after the preview
is correct:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --apply
```

There is no interactive confirmation prompt: passing `--apply` is the explicit
confirmation that permits writes. Existing changed files are copied to a
single `.bak` file before replacement, but keep your own backup as well.

On macOS, setup reads and writes:

- `~/.config/zed/settings.json`
- `~/.config/zed/tasks.json`

Linux uses `$XDG_CONFIG_HOME/zed/` when `XDG_CONFIG_HOME` is an absolute path,
and otherwise uses `~/.config/zed/`. Windows default-path detection is not
implemented; use `--zed-config-dir` with an explicit directory there.

To target a different Zed configuration directory, add
`--zed-config-dir <dir>`. Relative values are resolved from the setup command's
working directory. The command prints the resolved configuration directory and
the exact `settings.json` and `tasks.json` paths. Dry runs and `doctor` do not
create the directory; `setup --apply` creates it when needed. An invalid path
fails instead of falling back to the platform default.

Setup makes these changes and no others:

1. It adds `agent_servers.choco-pi` to `settings.json`. The custom server runs
   the current absolute Node executable with the checkout's absolute
   `.pi/packages/choco-pi-acp/bin/choco-pi-acp.ts` path and sets
   `PI_ACP_ENABLE_EMBEDDED_CONTEXT` to `"true"`.
2. It adds six definitions to `tasks.json`: **Sync Focused Context**, **Sync
   Focused Context (No Selection)**, **Sync Saved File Context**, **List Live
   Sessions**, **Select Context Target**, and **Open Terminal Thread**.

Unrelated settings and Tasks are retained. Rewriting `tasks.json` normalizes
it to plain JSON, so Task-file comments and formatting are not retained. An
existing, different `choco-pi` agent or one of the six Task labels is treated
as a conflict. Setup refuses to write unless you deliberately add `--replace`:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --apply --replace
```

`--replace` is limited to the `choco-pi` agent and those six labels.

Zed's `--user-data-dir <DIR>` option isolates a throwaway Zed profile under
`<DIR>/config`. Point setup at that configuration directory before starting the
profile:

```sh
PROFILE_DIR="$(mktemp -d)"
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --dry-run --zed-config-dir "$PROFILE_DIR/config"
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --apply --zed-config-dir "$PROFILE_DIR/config"
open -n -a /Applications/Zed.app --args --user-data-dir "$PROFILE_DIR" <project>
```

Start the isolated profile through LaunchServices as shown above. On macOS the
`zed` CLI wrapper does not apply `--user-data-dir`: `zed --user-data-dir <DIR>`
hands the request to the already-running editor, so the launched instance uses
the real user profile instead. This was observed during the Phase 5 runtime E2E
run; `lsof` on that process showed
`~/Library/Application Support/Zed/db/0-stable/db.sqlite` open and the user's
installed extensions running, while the throwaway directory stayed empty except
for the `config/` directory written by setup. The `open -n -a` form was verified
to open `<DIR>/db/0-stable/db.sqlite` instead. See
[the runtime E2E evidence](./zed-e2e-evidence.md) for the full record.

Inspect and remove the same isolated configuration explicitly:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed doctor \
  --zed-config-dir "$PROFILE_DIR/config"
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove \
  --apply --zed-config-dir "$PROFILE_DIR/config"
```

## Start the agent

Restart Zed or reload its settings, open the Agent Panel, and choose the
`choco-pi` custom agent. Zed launches:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts
```

The settings generated by setup use absolute paths rather than the relative
form above. The adapter speaks ACP over standard input/output and starts Pi
with `pi --mode rpc` in the selected project directory. Pi remains responsible for
provider authentication, commands, tools, extensions, and persisted session
history.

### Startup information

A new thread normally opens with a startup block that reports the Pi version,
context, skills, prompts, and extensions, mirroring what `pi` prints in a
terminal. That block is suppressed when Pi's `quietStartup` setting is enabled
in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`; the shipped
default is `quietStartup: false`, so the block appears unless you turned it off.
With `quietStartup: true` the adapter still emits a "New version available"
notice when the installed Pi is outdated. If a fresh thread shows no startup
block, check that setting before treating it as a defect.

### Live threads

Each open ACP thread keeps its own live Pi child process, so several threads in
one Zed window remain independently usable and independently targetable by
editor-context sync. The adapter retains the eight most recently used threads by
default and closes the least recently used beyond that bound; set
`PI_ACP_MAX_LIVE_SESSIONS` to an integer from 1 through 32 in the agent
environment to change it. Closing a thread's Pi child does not delete its Pi
session: reopening the thread restores it from Pi's session history.

ACP v1 does not notify the adapter when a Zed thread pane closes. An otherwise
idle Pi child is therefore reaped by a per-session timer instead: ten minutes by
default, configured with `PI_ACP_SESSION_IDLE_MS` and clamped to 60,000 through
7,200,000 milliseconds (one through 120 minutes). Active and queued turns are
never reaped. If the timer expires with a dialog pending, the dialog is cancelled
through the normal exactly-once settlement path before shutdown. A later prompt
for that thread transparently restores the persisted Pi session in a new child.
ACP transport disconnect still shuts every child down immediately.

### Existing Pi sessions in Zed's thread history

`session/list` reports every main Pi session recorded for the current project,
newest first, with the title Pi stored, the session's absolute working
directory, and its last activity time. Project scoping compares real filesystem
paths, so a worktree opened through a symlink (for example `/tmp/project`
against the realpath `/private/tmp/project` on macOS) still matches. Subagent
sidechain transcripts are excluded; ordinary continuations and branches of a
main session are kept.

Zed does not add external-agent threads to Thread History automatically. Per
Zed's [External Agents documentation](https://zed.dev/docs/ai/external-agents),
you open the Threads Sidebar, open Thread History, and use **Import Threads**;
Zed then connects to the agent over ACP and adds the sessions it does not
already have, as archived entries you open to restore. Because the adapter
always reports an absolute working directory for each session, none of them are
skipped by Zed's "sessions without an associated working directory" rule.

## Zed Tasks and one-key context sync

Open Zed's Task picker to run any installed Choco Pi Task:

Focus a text editor before opening the picker for the three context-sync Tasks.
Zed hides Tasks whose `$ZED_FILE`, `$ZED_ROW`, `$ZED_COLUMN`, or
`$ZED_SELECTED_TEXT` variables are unavailable, so opening the picker from the
Agent Panel makes the focused-context Tasks appear to be missing. For **Sync
Focused Context**, create the selection before opening the picker. The no-selection
variant needs an editor focus but does not require a selection.
Zed's `$ZED_ROW` and `$ZED_COLUMN` values are one-based, so the installed Tasks
pass them through unchanged as the editor-context line and column.

- **Choco Pi: Sync Focused Context** publishes the current file, one-based Zed
  row and column unchanged, language, symbol, worktree,
  and optional selected text. It does not save the buffer.
- **Choco Pi: Sync Focused Context (No Selection)** publishes the same path,
  cursor, language, symbol, and worktree metadata but never reads or publishes
  selection text.
- **Choco Pi: Sync Saved File Context** saves the current buffer and publishes
  its file, language, symbol, and worktree without cursor or selection text.
- **Choco Pi: List Live Sessions** lists live Pi sessions for the current
  canonical worktree and prints a ready-to-run targeting command.
- **Choco Pi: Select Context Target** performs the same listing and tells you
  to run the chosen command in Zed's terminal.
- **Choco Pi: Open Terminal Thread** runs `pi` in the worktree as the fallback
  for TUI-only workflows.

Setup does not change your keymap. To make focused sync a one-key action, merge
the binding from `editors/zed/keymap.example.json` into
`~/.config/zed/keymap.json`:

```json
{
  "context": "Workspace && !Terminal",
  "bindings": {
    "ctrl-alt-c": ["task::Spawn", { "task_name": "Choco Pi: Sync Focused Context" }]
  }
}
```

This is an explicit snapshot, not automatic ambient tracking. Run the binding
again after focus, cursor, symbol, or selection changes. The extension consumes
the newest accepted snapshot immediately before the next agent turn; snapshots
expire after 30 seconds.

## Embedded ACP context and selection privacy

The generated agent definition sets:

```json
"PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true"
```

Only the exact string `true` enables the capability. When enabled, attached
ACP resource and resource-link blocks are deduplicated and appended to the Pi
prompt in a clearly delimited **untrusted editor context** section. Resource
metadata and text are retained; binary resource data is omitted with its
decoded size. The complete embedded section is capped at 64 KiB of UTF-8 and
contains a truncation marker when necessary. When the flag is absent or has
another value, the adapter does not advertise embedded context and discards
resource blocks sent despite that disabled capability.

The focused-context Task carries selection text in the
`CHOCO_PI_ZED_SELECTION` environment variable, never in a command argument. It
rejects selection text over 16 KiB; the complete editor-context document also
has a 64 KiB limit.

Use **Choco Pi: Sync Focused Context (No Selection)** when the snapshot should
retain path, cursor, language, symbol, and worktree metadata without selection
text. That generated Task passes `--no-selection-text` and does not place the
selection in its Task environment. The maintained equivalent is included in
`editors/zed/tasks.example.json`.

The `publish` command also accepts either opt-out directly:

```sh
node .pi/packages/choco-pi-editor-context/src/cli.ts publish \
  --cwd "$PWD" --no-selection-text

CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1 \
  node .pi/packages/choco-pi-editor-context/src/cli.ts publish --cwd "$PWD"
```

Only the exact environment value `1` enables the opt-out. Disabling selection
text wins over `--selection-env` or `--selection-file`: the CLI does not read
the supplied selection source and omits `selection` from the context document.
This precedence is intentionally privacy-preserving. To apply the setting to
the regular focused-context Task without changing Task JSON, launch Zed from
an environment containing `CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1`; the
dedicated no-selection Task remains the portable per-sync choice.

To disable all explicit ACP resource content, including attached selection
resources, remove `PI_ACP_ENABLE_EMBEDDED_CONTEXT` from the agent environment
or set it to any value other than `true`.

## Choose a context target

Context publication matches live Pi sessions by canonical worktree. With one
match, publication selects it automatically. With more than one match, it
fails instead of guessing: choosing the wrong session could send file or
selection context to the wrong conversation.

Because every open thread keeps its own live Pi child, more than one match is
the normal case as soon as you have two threads open in the same worktree. Run
**Choco Pi: List Live Sessions** and select a target explicitly.

Canonical worktree matching resolves symbolic links on both sides, so a project
opened as `/tmp/project` matches a Pi session whose working directory is the
realpath `/private/tmp/project`. A worktree that cannot be resolved on the
filesystem is rejected rather than compared lexically.

`publish` runs the consuming session's own validation, against that session's
working directory, before it writes anything. A context that the session would
reject now fails at the Task and CLI layer with bounded diagnostic codes and a
nonzero exit status, and no context file is written. Earlier revisions reported
`Editor context published.` with exit 0 while the session rejected the payload.

Run **Choco Pi: List Live Sessions**, then copy one printed `select` command
into Zed's terminal. Its source form is:

```sh
node .pi/packages/choco-pi-editor-context/src/cli.ts select \
  --session-id <session-id> \
  --owner-id <owner-id> \
  --cwd <absolute-worktree-path>
```

The stored target is scoped to the canonical worktree and is revalidated
before every publish. Clear it with:

```sh
node .pi/packages/choco-pi-editor-context/src/cli.ts select \
  --clear \
  --cwd <absolute-worktree-path>
```

Explicit `--session-id` plus `--owner-id` on a `publish` command takes
precedence over the stored target. Both identifiers are required together.

## Local and remote projects

For a local Zed project, Zed launches Node, the adapter, Pi, and Tasks on the
local machine. Paths and credentials therefore belong to that machine.

The designed Zed SSH flow runs the checkout, Tasks, adapter, and Pi on the
remote host while the UI remains local. Install Node 24+, Pi, repository
dependencies, and the choco-pi profile on the remote host; run setup there so
the generated absolute paths are remote-native. Pi credentials stay on the
host running Pi and are not copied from Zed. Tool locations travel through ACP
rather than a local `zed` command.

Remote operation is documented but was not verified end-to-end in this
initiative because no SSH target was available. Treat it as manual setup, and
validate with `zed doctor`, context diagnostics, and a non-sensitive test file
before using selected text.

## Migrate from another Pi ACP entry

Setup owns only the `choco-pi` key. Existing `pi`, `pi-acp`, or registry agent
entries remain untouched and may appear alongside it. Validate a new
`choco-pi` thread first, then remove the old entry manually if you no longer
need it. `--replace` does not migrate or remove differently named entries.

The adapter continues to use Pi's session files as the conversation source of
truth. Removing a Zed agent definition does not delete Pi sessions. Keep the
checkout at the path captured by setup, or rerun setup after moving it.

## Remove the Zed integration

Preview removal before changing files:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove --dry-run
```

Then explicitly apply it:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove --apply
```

Removal deletes only `agent_servers.choco-pi` and the six Choco Pi Task
labels, including both focused-context variants. It preserves other agents,
settings, and Tasks and backs up each
existing changed file to `.bak`. It does not remove the manual keymap binding;
delete that entry from `keymap.json` yourself. It also does not uninstall the
global choco-pi profile, dependencies, checkout, Pi sessions, or adapter
session mappings. No profile-uninstall command is shipped.

## Security and privacy

- Treat file and selection content as sensitive. It is transmitted only after
  an explicit ACP attachment or Task sync action. The integration does not log
  selection text, and rejection diagnostics contain bounded codes rather than
  the text.
- Editor-context files live under
  `~/.pi/agent/choco-pi/session-bridge/editor-context/` by default. Directories
  are created with owner-only `0700` permissions and atomic temporary files
  with `0600` permissions. A consumed file is removed whether validation
  accepts or rejects it; bounded cleanup removes expired owner-verified
  leftovers without deleting another live owner's file.
- Context is accepted only for the matching live session, owner, generation,
  canonical worktree, and unexpired capture. Symlinks and foreign-owned context
  files are rejected where the platform exposes ownership.
- ACP is a transport and presentation protocol, not a sandbox. Pi and its tools
  run with the permissions of the Node/Pi process. Review project-local Pi
  configuration before trusting it; the adapter never adds `--approve`.

## Troubleshooting

Check whether the generated settings and Tasks match the current checkout:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed doctor
```

`doctor` accepts no mutation flags, accepts `--zed-config-dir <dir>` for an
alternate profile, and returns nonzero for missing or conflicting setup. To
inspect live sessions matching an absolute worktree, run:

```sh
node .pi/packages/choco-pi-editor-context/src/cli.ts diagnose \
  --cwd <absolute-worktree-path>
```

`diagnose` currently has the same behavior as `list`: it prints at most 20
matching live sessions and returns nonzero when there are none. If sync reports
`LIVE_TARGET_AMBIGUOUS`, select a target as described above. If it reports
`LIVE_TARGET_NOT_FOUND`, start a Pi-backed choco-pi thread in that worktree
first. A stale saved target is cleared automatically before matching again.

If Pi rejects project-local configuration as untrusted, review the project and
complete Pi's one-time trust prompt from a terminal:

```sh
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts \
  --terminal-trust <absolute-project-path>
```

The path must be an existing absolute directory. Exit Pi after recording the
choice. For provider login or API-key setup, run the source entry with
`--terminal-login` instead. If the adapter cannot locate Pi, install
`@earendil-works/pi-coding-agent` or set `PI_ACP_PI_COMMAND` to its executable
path.
