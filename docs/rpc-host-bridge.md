# RPC host bridge

Waku launches choco-pi through the installed Pi 1.0.4 RPC driver. The bridge
adds durable background-work and goal entries to Pi sessions and transient
progress frames to RPC stdout. It does not replace Pi's RPC protocol.

## Identify and launch the profile

`pnpm install:profile` writes `<agentDir>/choco-pi/profile.json`. The marker
identifies the profile and records the checkout, revision, installation time,
observed Pi version, launcher, and bridge schema:

```json
{
  "schema": 1,
  "name": "choco-pi",
  "checkout": "/absolute/path/to/choco-pi",
  "revision": "<git-revision-or-null>",
  "installedAt": "<ISO-8601-time>",
  "pi": { "version": "1.0.4", "launcher": "/absolute/path/to/pi" },
  "hostBridge": {
    "schema": 1,
    "entryPrefix": "choco-pi:host-bridge",
    "statusKey": "choco-pi.host-bridge"
  }
}
```

The installer resolves the launcher from `--pi-launcher`, then
`CHOCO_PI_LAUNCHER`, then the first `pi` on `PATH` reporting version 1.0.4.
Both `pi.version` and `pi.launcher` are nullable: if no compatible PATH candidate
is found, both are null and installation warns. An explicit launcher override
retains its absolute path and observed version (or null if unavailable), even
when incompatible, and warns. The version comes from the launcher, not the
SDK dependency. A marker identifies a profile; it does not prove that a
launcher is usable. Run `harness_check` to check the installed launcher and
profile.

Set `CHOCO_PI_HOST=waku` when starting Pi in RPC mode:

```sh
CHOCO_PI_HOST=waku /absolute/path/to/pi --mode rpc --approve
```

Do not substitute an older `pi` found on `PATH`. Keep credentials and
machine-local configuration outside Git.

## Durable entries and transient progress

The session stores these custom entry types in **all modes**, including TUI
and RPC without `CHOCO_PI_HOST`:

- `choco-pi:host-bridge/subagent`: lifecycle transitions, agent metadata,
  transcript `outputFile`, and current live IDs.
- `choco-pi:host-bridge/shell`: process transitions and current live IDs.
- `choco-pi:host-bridge/goal`: the current goal, or `goal: null` when cleared.
- `choco-pi:host-bridge/workflow`: workflow creation, completion, or cancellation.

Their schema is frozen in §6.4 of the [integration design](waku-integration.md).
These are session records, not assistant messages. On connection, send
`/host-bridge snapshot` and consume its `entry_appended` frames. Do not fetch
the full session history with `get_entries` during the handshake. That command
remains available for manual diagnostics.

Progress is emitted only when **both** `ctx.mode === "rpc"` and
`CHOCO_PI_HOST === "waku"`. The bridge uses changed, 250 ms-debounced
`setStatus` frames:

```json
{
  "type": "extension_ui_request",
  "id": "<request-id>",
  "method": "setStatus",
  "statusKey": "choco-pi.host-bridge",
  "statusText": "{\"schema\":1,\"at\":0,\"subagents\":[],\"shells\":[]}"
}
```

Parse `statusText` as schema-1 JSON. A host must create background-work items
from durable entries first, then update known IDs from progress frames.
`setStatus` is fire-and-forget: do not reply to it. Requesting a newer schema
through `CHOCO_PI_HOST_BRIDGE_SCHEMA` does not negotiate a new wire contract;
versions above 1 warn and still emit schema 1.

A restored live subagent from another session with no owning runtime becomes
`event: "lost"`, `agent.status: "lost"`; its `finishedAt` is the detection time.
The envelope gains no session-ID field. A live owning runtime must not be
reported as lost.

## Snapshot and controls

The RPC-only `/host-bridge` command accepts these positional arguments:

| Command                           | Effect                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/host-bridge snapshot`           | Appends the current goal (or null), pending terminal transitions, then live work; requests progress. |
| `/host-bridge stop subagent <id>` | Stops the identified subagent.                                                                       |
| `/host-bridge stop shell <id>`    | Stops the identified managed shell.                                                                  |
| `/host-bridge goal complete`      | Completes the current goal.                                                                          |

There are no `/host-bridge-state` or `/host-bridge-control` aliases, flag-based
controls, or separate state/control custom entry types. State is represented
by the four durable entry types above and streamed through `entry_appended`.
Snapshot emits the goal first, then any unrecorded subagent terminal transitions,
then live subagent and shell entries with `event: "started"` and the current live
list. Retired records emit completed, failed, or stopped; an evicted record emits
lost. Repeating a snapshot does not duplicate terminal transitions. Entries
precede the handled response. With no live work or pending terminal transitions,
only the goal entry is emitted.

Send an extension command through native RPC `prompt`:

```json
{"id":"snapshot-1","type":"prompt","message":"/host-bridge snapshot"}
{"id":"snapshot-1","type":"response","command":"prompt","success":true,"data":{"disposition":"handled"}}
```

A successfully handled extension command returns a normal `response` with
`data.disposition: "handled"`; it does not start a model turn. Correlate by ID,
not response order. Treat command failures and `extension_error` events as
errors; do not infer a successful stop from prompt acceptance alone. The
command is not registered for TUI use.

## User dialogs

Pi RPC forwards `select`, `input`, `editor`, and `confirm` as
`extension_ui_request` records. Waku maps all four to `UserInputRequested`.
In particular, **confirm is not a Permission event**: FullAccess must not
automatically approve a yes/no user decision.

Reply with the request's `id`:

```json
{"type":"extension_ui_response","id":"<select-input-or-editor-id>","value":"<answer>"}
{"type":"extension_ui_response","id":"<confirm-id>","confirmed":false}
{"type":"extension_ui_response","id":"<cancelled-request-id>","cancelled":true}
```

Dialog responses have no RPC acknowledgement. A request's `timeout`, when
present, lets Pi resolve a default value; the host should also close its
local dialog when that timeout expires. Do not answer notifications, status
frames, or widgets as dialogs.

## Manual live probe

[`tests/live/rpc-host-bridge.ts`](../tests/live/rpc-host-bridge.ts) launches a
real installed Pi subprocess. It is not included in `pnpm test`. Running it
uses provider credentials, makes billable model calls, and starts one
background subagent. Do not run it without authorization.

Use Node 24 or later and an explicit compatible launcher and model:

```sh
node tests/live/rpc-host-bridge.ts \
  --pi-launcher "$HOME/.local/pi-shim/pi" \
  --model openai-codex/gpt-6.1-sol \
  --scratch-dir /tmp/choco-pi/<approved-task>/probe \
  --capture /tmp/choco-pi/<approved-task>/probe/bridge-manual.jsonl \
  --timeout-ms 180000
```

`--source-agent-dir` defaults to `~/.pi/agent`. The probe copies settings,
authentication, models, agent definitions, themes, and the marker into private scratch;
it does not symlink mutable configuration or edit the source profile. The
source settings must load this checkout's installed packages and extensions.
The runtime working directory, session files, and transcript temp files are
isolated under a generated scratch directory. Temporary runtime data is
removed after the child exits. The capture remains at the requested path,
created with mode 0600 and exclusive creation; use a fresh filename per run.

The probe checks:

- Native LF-delimited RPC stdout and correlated command responses.
- Select/input/editor/confirm round trips with a probe-only extension and a
  durable UI result entry. Only these harmless probe dialogs are approved;
  unrelated dialogs are cancelled.
- `/host-bridge snapshot` handling, durable completed subagent entries read
  through `entry_appended`, a snapshot goal entry before the handled response,
  and schema-1 `setStatus` progress frames.
- A real spawn transcript containing the child's answer, followed by a second
  parent model run caused by background completion.

The JSONL capture contains the child's RPC stdout, including dialog stream
lines and durable `entry_appended` frames. It may contain model and tool content;
treat it as private evidence. A passing probe does not establish Waku UI
rendering, process-stop controls, fork recovery, or every goal/workflow
transition. Those require their own tests.

Installed protocol references:
[RPC](../node_modules/@earendil-works/pi-coding-agent/docs/rpc.md),
[commands](../node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md),
and [extension UI](../node_modules/@earendil-works/pi-coding-agent/docs/rpc-extension-ui.md).
