# Use choco-pi in Zed

[한국어](../ko/zed-setup.md)

This guide sets up choco-pi as a custom ACP agent in Zed. It works with both install methods: a repository checkout installed as a profile into Pi (called the legacy install below; it shares `~/.pi` with `pi`), or a standalone `choco-pi` install (state under `$CHOCO_PI_HOME`, by default `~/.choco-pi`). The guide does not install or fetch a published package. [Standalone install](#standalone-install-choco-pi-launcher) collects what differs for a standalone install; everything else applies to both.

## Prerequisites

- Node.js 24 LTS or newer. Bun is not supported. The checkout runs its TypeScript sources directly and has no build output.
- Zed. This guide was verified with Zed 1.18.0, which is a baseline, not a hard minimum. Older Zed releases get best-effort support.
- A local clone of this repository at a path that will not change.
- For the legacy install: `pi` on `PATH`, with a model provider configured. If `pi` is elsewhere, set `PI_ACP_PI_COMMAND` to its executable path. A standalone install needs neither, because it runs its own pinned Pi.

For the legacy install, install the dependencies and the choco-pi profile from the repository root, as [Install the profile into Pi](installation.md#install-the-profile-into-pi) describes:

```sh
pnpm install --frozen-lockfile
npm run install:profile
```

In the legacy install, the `install:profile` step is required. It adds the `choco-pi-editor-context` package from this checkout to Pi's global profile; without it, the Tasks can publish context, but Pi sessions outside this checkout do not consume it. The installer reports every path it links or updates. If it finds conflicting profile files, review them, and rerun `npm run install:profile -- --backup` only if you want it to back up and replace those files.

A standalone install skips both commands. `install.sh` and `choco-pi self setup` already install the profile, including `choco-pi-editor-context`, into `$CHOCO_PI_HOME/agent`.

## Standalone install (`choco-pi` launcher)

A standalone install runs every entry point through the `choco-pi` launcher. Before Node starts, the launcher sets its environment contract: `CHOCO_PI_STANDALONE=1`, `CHOCO_PI_HOME`, `CHOCO_PI_LAUNCHER`, `PI_CODING_AGENT_DIR=$CHOCO_PI_HOME/agent`, and `PI_ACP_PI_COMMAND` set to the launcher. Run the Zed commands in this guide as `choco-pi self acp ...` instead of `node packages/choco-pi-acp/bin/choco-pi-acp.ts ...`:

```sh
choco-pi self acp zed setup --dry-run
choco-pi self acp zed setup --apply
choco-pi self acp zed doctor
choco-pi self acp zed remove --apply
```

Under this contract, setup writes definitions that start the launcher. `editors/zed/settings.standalone.example.json` and `editors/zed/tasks.standalone.example.json` are maintained copies of them:

- `agent_servers.choco-pi` runs the launcher's absolute path with `["self", "acp"]`, so the adapter, every Pi child it starts, `/changelog`, the version header, and terminal login (`self acp --terminal-login`) all use the pinned Pi and `$CHOCO_PI_HOME`.
- The five context Tasks run `<launcher> self exec <node> <app>/packages/choco-pi-editor-context/src/cli.ts ...`, so the editor-context CLI reads the same agent directory as the sessions.
- **Open Terminal Thread** runs the launcher instead of `pi`.

In standalone mode, the adapter keeps its session map in `$CHOCO_PI_HOME/pi-acp/` instead of `~/.pi/pi-acp/`, lists prompts and extensions from `$CHOCO_PI_HOME/agent/`, and never reads `~/.pi`. It shows no "New version available" notice, because the lockfile pins Pi and `npm i -g` cannot update it.

Setup refuses to run when `CHOCO_PI_STANDALONE=1` is set without an absolute `CHOCO_PI_LAUNCHER`, rather than write a definition that would start outside the contract. A legacy setup and a standalone setup write the same `choco-pi` agent key and the same six Task labels, so switching from one to the other needs `--replace`. Setup records the launcher's absolute path, so rerun setup after you move the install.

## Preview and apply Zed setup

Back up your Zed configuration before you apply changes. Then preview the exact result:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --dry-run
```

The preview reads your existing settings and Tasks files (JSON with comments) and prints the complete documents that setup would write, without writing anything. Check the absolute Node and checkout paths in the output, and apply only when the preview is correct:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --apply
```

Setup does not ask for confirmation: passing `--apply` is the explicit confirmation that allows it to write. Before it replaces an existing file that it changes, setup copies the file to a single `.bak` file, but keep your own backup as well.

On macOS, setup reads and writes:

- `~/.config/zed/settings.json`
- `~/.config/zed/tasks.json`

On Linux, setup uses `$XDG_CONFIG_HOME/zed/` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/zed/` otherwise. On Windows, setup cannot detect the default path; pass the directory with `--zed-config-dir`.

To target a different Zed configuration directory, add `--zed-config-dir <dir>`. A relative path is resolved from the directory you run setup in. The command prints the resolved configuration directory and the exact `settings.json` and `tasks.json` paths. Dry runs and `doctor` do not create the directory; `setup --apply` creates it when needed. An invalid path fails instead of falling back to the platform default.

Setup makes these changes and no others:

1. It adds `agent_servers.choco-pi` to `settings.json`. This custom server runs the current Node executable, by absolute path, with the checkout's absolute `packages/choco-pi-acp/bin/choco-pi-acp.ts` path, and sets `PI_ACP_ENABLE_EMBEDDED_CONTEXT` to `"true"`.
2. It adds six definitions to `tasks.json`: **Sync Focused Context**, **Sync Focused Context (No Selection)**, **Sync Saved File Context**, **List Live Sessions**, **Select Context Target**, and **Open Terminal Thread**.

Setup keeps unrelated settings and Tasks. Rewriting `tasks.json` turns it into plain JSON, so comments and formatting in that file are lost. An existing `choco-pi` agent, or a Task with one of the six labels, that differs from what setup would write is a conflict. Setup then refuses to write unless you deliberately add `--replace`:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup --apply --replace
```

`--replace` affects only the `choco-pi` agent and those six labels.

To try the integration in a throwaway Zed profile, use Zed's `--user-data-dir <DIR>` option, which keeps that profile's configuration in `<DIR>/config`. Point setup at that configuration directory before you start the profile:

```sh
PROFILE_DIR="$(mktemp -d)"
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --dry-run --zed-config-dir "$PROFILE_DIR/config"
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --apply --zed-config-dir "$PROFILE_DIR/config"
open -n -a /Applications/Zed.app --args --user-data-dir "$PROFILE_DIR" <project>
```

Start the isolated profile through LaunchServices, as shown above. On macOS, the `zed` CLI wrapper does not apply `--user-data-dir`: `zed --user-data-dir <DIR>` hands the request to the editor that is already running, so the launched instance uses your real user profile. The recorded runtime E2E run observed this: `lsof` on that process showed `~/Library/Application Support/Zed/db/0-stable/db.sqlite` open and the user's installed extensions running, while the throwaway directory stayed empty apart from the `config/` directory that setup wrote. The `open -n -a` form was verified to open `<DIR>/db/0-stable/db.sqlite` instead. [The runtime E2E evidence](../zed-e2e-evidence.md) has the full record.

To inspect or remove the isolated configuration, pass the same directory:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed doctor \
  --zed-config-dir "$PROFILE_DIR/config"
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove \
  --apply --zed-config-dir "$PROFILE_DIR/config"
```

## Start the agent

Restart Zed or reload its settings, open the Agent Panel, and choose the `choco-pi` custom agent. Zed launches:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts
```

The settings that setup generates use absolute paths instead of this relative form. The adapter speaks ACP over standard input and output and starts Pi with `pi --mode rpc` in the selected project directory. Pi still handles provider authentication, commands, tools, extensions, and the saved session history.

### Startup information

A new thread normally opens with a startup block that reports the Pi version, context, skills, prompts, and extensions, like the one `pi` prints in a terminal. The block is hidden when Pi's `quietStartup` setting is `true` or `"header"`, either in `settings.json` in Pi's agent directory (`~/.pi/agent`, or `$CHOCO_PI_HOME/agent` in a standalone install) or in `<project>/.pi/settings.json`. Pi's default is `quietStartup: false`, so the block appears unless you turned it off; a standalone install's [first-run settings](installation.md#first-run-settings) set it to `"header"`. When the block is hidden, the adapter still shows a "New version available" notice if the installed Pi is outdated (a standalone install never shows it; see [Standalone install](#standalone-install-choco-pi-launcher)). If a new thread shows no startup block, check this setting before you treat it as a defect.

### Live threads

Each open ACP thread keeps its own live Pi child process, so several threads in one Zed window work independently, and editor-context sync can target each one. By default, the adapter keeps the eight most recently used threads and closes the least recently used ones beyond that limit. To change the limit, set `PI_ACP_MAX_LIVE_SESSIONS` in the agent environment to an integer from 1 through 32. Closing a thread's Pi child does not delete its Pi session: reopening the thread restores it from Pi's session history.

ACP v1 does not tell the adapter when a Zed thread pane closes, so a per-session timer stops idle Pi children instead. The timeout is ten minutes by default. Set it with `PI_ACP_SESSION_IDLE_MS`; values are clamped to 60,000 through 7,200,000 milliseconds (1 through 120 minutes). A child with an active or queued turn is never stopped. If the timer expires while a dialog is pending, the adapter cancels the dialog through the normal exactly-once settlement path before it shuts the child down. The next prompt in that thread automatically restores the saved Pi session in a new child. When the ACP transport disconnects, the adapter still shuts every child down immediately.

### Existing Pi sessions in Zed's thread history

`session/list` reports every main Pi session recorded for the current project, newest first, with the title Pi stored, the session's absolute working directory, and its last activity time. To decide which sessions belong to the project, the adapter compares real filesystem paths, so a worktree opened through a symlink still matches (for example, `/tmp/project` against its realpath `/private/tmp/project` on macOS). Subagent sidechain transcripts are left out; ordinary continuations and branches of a main session are included.

Zed does not add external-agent threads to Thread History on its own. As Zed's [External Agents documentation](https://zed.dev/docs/ai/external-agents) describes, open the Threads Sidebar, open Thread History, and use **Import Threads**. Zed then connects to the agent over ACP and adds the sessions it does not have yet, as archived entries that you open to restore. The adapter reports an absolute working directory for every session, so Zed's rule that skips "sessions without an associated working directory" skips none of them.

## Zed Tasks and one-key context sync

Setup installs six Choco Pi Tasks, which you run from Zed's Task picker:

- **Choco Pi: Sync Focused Context** publishes the current file, the row and column (one-based, passed on unchanged from Zed), the language, symbol, and worktree, and the selected text if there is one. It does not save the buffer.
- **Choco Pi: Sync Focused Context (No Selection)** publishes the same path, cursor, language, symbol, and worktree metadata, but never reads or publishes the selected text.
- **Choco Pi: Sync Saved File Context** saves the current buffer and publishes its file, language, symbol, and worktree, without the cursor or selected text.
- **Choco Pi: List Live Sessions** lists the live Pi sessions for the current canonical worktree and prints a ready-to-run targeting command.
- **Choco Pi: Select Context Target** does the same listing and tells you to run the chosen command in Zed's terminal.
- **Choco Pi: Open Terminal Thread** runs `pi` (the `choco-pi` launcher in a standalone install) in the worktree, as the fallback for workflows that need the terminal UI.

For the three context-sync Tasks, focus a text editor before you open the picker. Zed hides a Task when its `$ZED_FILE`, `$ZED_ROW`, `$ZED_COLUMN`, or `$ZED_SELECTED_TEXT` variables are unavailable, so if you open the picker from the Agent Panel, the focused-context Tasks seem to be missing. For **Sync Focused Context**, make the selection before you open the picker. The no-selection variant needs a focused editor but no selection. Zed's `$ZED_ROW` and `$ZED_COLUMN` values are one-based, so the installed Tasks pass them on unchanged as the editor-context line and column.

Setup does not change your keymap. To make focused sync a one-key action, merge the binding from `editors/zed/keymap.example.json` into `~/.config/zed/keymap.json`:

```json
{
  "context": "Workspace && !Terminal",
  "bindings": {
    "ctrl-alt-c": ["task::Spawn", { "task_name": "Choco Pi: Sync Focused Context" }]
  }
}
```

Each sync takes an explicit snapshot; nothing tracks the editor automatically. Run the binding again after the focus, cursor, symbol, or selection changes. Immediately before the next agent turn, the extension consumes the newest accepted snapshot. Snapshots expire after 30 seconds.

## Embedded ACP context and selection privacy

The generated agent definition sets:

```json
"PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true"
```

Only the exact string `true` enables the capability. When it is enabled, the adapter deduplicates attached ACP resource and resource-link blocks and appends them to the Pi prompt in a clearly delimited **untrusted editor context** section. Resource metadata and text are kept; binary resource data is left out, and only its decoded size is noted. The whole embedded section is capped at 64 KiB of UTF-8 and contains a truncation marker when it is cut. When the variable is absent or has another value, the adapter does not advertise embedded context and discards any resource blocks a client sends anyway.

The focused-context Task passes the selected text in the `CHOCO_PI_ZED_SELECTION` environment variable, never in a command argument. It rejects selected text larger than 16 KiB, and the whole editor-context document is also limited to 64 KiB.

Use **Choco Pi: Sync Focused Context (No Selection)** when the snapshot should carry path, cursor, language, symbol, and worktree metadata without the selected text. That generated Task passes `--no-selection-text` and does not put the selection in its Task environment. `editors/zed/tasks.example.json` includes a maintained copy of it.

The `publish` command also accepts either opt-out directly:

```sh
node packages/choco-pi-editor-context/src/cli.ts publish \
  --cwd "$PWD" --no-selection-text

CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1 \
  node packages/choco-pi-editor-context/src/cli.ts publish --cwd "$PWD"
```

Only the exact environment value `1` enables the opt-out. The opt-out takes precedence over `--selection-env` and `--selection-file`: the CLI does not read the given selection source and leaves `selection` out of the context document. This order is deliberate, to protect privacy. To apply the opt-out to the regular focused-context Task without editing the Task JSON, start Zed from an environment that contains `CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1`. The dedicated no-selection Task remains the portable way to choose per sync.

To turn off all explicit ACP resource content, including attached selection resources, remove `PI_ACP_ENABLE_EMBEDDED_CONTEXT` from the agent environment or set it to any value other than `true`.

## Choose a context target

Publishing context matches live Pi sessions by canonical worktree. If exactly one session matches, it is selected automatically. If more than one matches, publishing fails instead of guessing, because choosing the wrong session could send file or selection context to the wrong conversation.

Every open thread keeps its own live Pi child, so more than one match is normal as soon as you have two threads open in the same worktree. In that case, run **Choco Pi: List Live Sessions** and select a target explicitly.

Canonical worktree matching resolves symbolic links on both sides, so a project opened as `/tmp/project` matches a Pi session whose working directory is the realpath `/private/tmp/project`. A worktree that cannot be resolved on the filesystem is rejected rather than compared as a plain string.

Before it writes anything, `publish` runs the receiving session's own validation against that session's working directory. Context that the session would reject now fails in the Task and the CLI with bounded diagnostic codes and a nonzero exit status, and no context file is written. Earlier revisions reported `Editor context published.` and exited with status 0 even when the session rejected the payload.

To select a target, run **Choco Pi: List Live Sessions** and copy one of the printed `select` commands into Zed's terminal. From a checkout, the command looks like this:

```sh
node packages/choco-pi-editor-context/src/cli.ts select \
  --session-id <session-id> \
  --owner-id <owner-id> \
  --cwd <absolute-worktree-path>
```

The saved target applies only to its canonical worktree and is checked again before every publish. To clear it, run:

```sh
node packages/choco-pi-editor-context/src/cli.ts select \
  --clear \
  --cwd <absolute-worktree-path>
```

Passing `--session-id` and `--owner-id` to a `publish` command overrides the saved target. You must pass both identifiers together.

## Local and remote projects

For a local Zed project, Zed launches Node, the adapter, Pi, and the Tasks on the local machine, so paths and credentials are those of that machine.

For a remote project over SSH, the intended design runs the checkout, Tasks, adapter, and Pi on the remote host while the UI stays local. Install Node 24+, Pi, the repository dependencies, and the choco-pi profile on the remote host, and run setup there so that the generated absolute paths are valid on that host. Pi credentials stay on the host that runs Pi; Zed does not copy them. Tool locations reach Zed through ACP, not through a local `zed` command.

Remote use is documented but has not been verified end to end, because no SSH target was available. Treat it as a manual setup, and check it with `zed doctor`, the context diagnostics, and a test file with nothing sensitive in it before you use selected text.

## Migrate from another Pi ACP entry

Setup manages only the `choco-pi` key. It leaves existing `pi`, `pi-acp`, or registry agent entries untouched, and they may appear next to it. Try a new `choco-pi` thread first, then remove the old entry by hand if you no longer need it. `--replace` does not migrate or remove entries with other names.

The adapter keeps using Pi's session files as the authoritative record of each conversation, so removing a Zed agent definition does not delete Pi sessions. Keep the checkout at the path that setup recorded, or rerun setup after you move it.

## Remove the Zed integration

Preview the removal before changing any files:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove --dry-run
```

Then apply it explicitly:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed remove --apply
```

Removal deletes only `agent_servers.choco-pi` and the six Choco Pi Task labels, including both focused-context variants. It keeps other agents, settings, and Tasks, and backs up each existing file it changes to `.bak`. It does not remove the keymap binding you added by hand; delete that entry from `keymap.json` yourself. It also leaves the choco-pi profile, dependencies, checkout, Pi sessions, and adapter session mappings in place. The profile installed into Pi has no uninstall command. To remove a standalone install, run `choco-pi self uninstall`; it keeps your login, sessions, and settings unless you add `--purge` (see [Update and uninstall](installation.md#update-and-uninstall)).

## Security and privacy

- Treat file and selection content as sensitive. It is sent only after you attach it explicitly in ACP or run a Task sync. The integration does not log selected text, and rejection diagnostics contain bounded codes rather than the text.
- Editor-context files live under `~/.pi/agent/choco-pi/session-bridge/editor-context/` by default (`$CHOCO_PI_HOME/agent/choco-pi/session-bridge/editor-context/` in a standalone install). Directories are created with owner-only `0700` permissions, and files are written atomically through temporary files with `0600` permissions. A consumed file is removed whether validation accepts or rejects it. A bounded cleanup removes expired leftovers whose owner it has verified, and never deletes a file that belongs to another live owner.
- Context is accepted only for the matching live session, owner, generation, and canonical worktree, and only before the capture expires. Symlinks and context files owned by another user are rejected where the platform exposes ownership.
- ACP is a transport and presentation protocol, not a sandbox. Pi and its tools run with the permissions of the Node/Pi process. Review project-local Pi configuration before you trust it; the adapter never adds `--approve`.

## Troubleshooting

Check whether the generated settings and Tasks match the current checkout:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts zed doctor
```

`doctor` accepts none of the flags that change files. It accepts `--zed-config-dir <dir>` for another profile, and exits nonzero when the setup is missing or conflicts. To inspect the live sessions that match an absolute worktree, run:

```sh
node packages/choco-pi-editor-context/src/cli.ts diagnose \
  --cwd <absolute-worktree-path>
```

`diagnose` currently behaves the same as `list`: it prints at most 20 matching live sessions and exits nonzero when there are none. If sync reports `LIVE_TARGET_AMBIGUOUS`, select a target as described in [Choose a context target](#choose-a-context-target). If it reports `LIVE_TARGET_NOT_FOUND`, first start a Pi-backed choco-pi thread in that worktree. A saved target that has gone stale is cleared automatically before matching runs again.

If Pi rejects project-local configuration as untrusted, review the project and answer Pi's one-time trust prompt from a terminal:

```sh
node packages/choco-pi-acp/bin/choco-pi-acp.ts \
  --terminal-trust <absolute-project-path>
```

The path must be an existing absolute directory. Exit Pi after it records your choice. To log in to a provider or set up an API key, run the same entry point with `--terminal-login` instead. If the adapter cannot find Pi, install `@earendil-works/pi-coding-agent` or set `PI_ACP_PI_COMMAND` to its executable path.

In a standalone install, run these through the launcher so that they use its state directories: `choco-pi self acp zed doctor`, `choco-pi self acp --terminal-trust <absolute-project-path>`, `choco-pi self acp --terminal-login`, and `choco-pi self exec node <app>/packages/choco-pi-editor-context/src/cli.ts diagnose --cwd <absolute-worktree-path>` (`<app>` is `$CHOCO_PI_HOME/app`; any Node 24 or newer works for `self exec`).

## Related records

- [Compatibility baseline](../zed-acp-compatibility.md): the Pi, ACP, Zed, and Node.js versions recorded as the integration baseline.
- [Command parity inventory](../zed-command-parity.md): each command, classified by whether it completes in Zed without the terminal UI.
- [Runtime E2E evidence](../zed-e2e-evidence.md): what was observed when choco-pi ran inside a real Zed.
