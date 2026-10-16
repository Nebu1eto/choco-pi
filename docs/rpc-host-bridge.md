# RPC host bridge

Waku launches choco-pi through the installed Pi 1.3.0 RPC driver. The bridge
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
  "pi": { "version": "1.3.0", "launcher": "/absolute/path/to/pi" },
  "hostBridge": {
    "schema": 1,
    "entryPrefix": "choco-pi:host-bridge",
    "statusKey": "choco-pi.host-bridge",
    "reportStatusKey": "choco-pi.report"
  }
}
```

`reportStatusKey` names the status key of [structured reports](#structured-reports).
Markers written before it existed omit it and remain valid.

The installer resolves the launcher from `--pi-launcher`, then
`CHOCO_PI_LAUNCHER`, then the first `pi` on `PATH` reporting version 1.3.0.
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

Subagent sessions are ordinary Pi session files in the same session
directory. Each freshly created one starts with a `choco-pi:subagent` custom
entry (`{ schemaVersion: 1, agentId, agentType, parentSessionId }`, nulls
when unknown). Hosts that list Pi session files for a resume picker should
hide sessions carrying it. Do not use the header's `parentSession` as the
signal: user `/branch` sessions carry it too. Sessions written before this
marker existed can only be recognised by their `session_info` name, which the
subagent runner sets to `<agent name>#<first 8 hex of agentId>`.

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

## Structured reports

In every non-TUI mode, `/status`, `/context`, and `/usage` (alias `/quota`)
publish their data as a `setStatus` frame keyed `choco-pi.report`, then send
the same plain-text `notify` as before. A host that does not recognise the key
keeps rendering the notice; a host that does can render a native view and
suppress the notice that follows. `/preferences` sends no report.

```json
{
  "type": "extension_ui_request",
  "id": "<request-id>",
  "method": "setStatus",
  "statusKey": "choco-pi.report",
  "statusText": "{\"schema\":1,\"kind\":\"context\",...}"
}
```

A context report is also published automatically, under the same gate as
progress frames (`ctx.mode === "rpc"` and `CHOCO_PI_HOST === "waku"`): on
`session_start`, after each `turn_end`, and on `model_select`, with a 500 ms
trailing debounce, and only when its figures changed. Pi gives event handlers
no system-prompt options, so the first automatic report waits until a
`before_agent_start` or a `/status`/`/context` command has supplied them for
the current session; a `session_start` alone sends nothing.

A usage report is published automatically under the same gate, but because
each one queries every connected provider it is not sent on every turn: it
follows the context report of the session's first `turn_end`, and after that
of a `turn_end` only once 10 minutes have passed since the last automatic
query. `session_start` and `model_select` never trigger one. An automatic
query in which no provider reported a quota window publishes nothing and
still waits out the interval; a user-invoked `/usage` always publishes,
including providers that only carry a `status` such as
`API key; no subscription quota window` or `unavailable (HTTP 401)`.
Providers without credentials are never queried; they appear only in the
`Not signed in` section.

`statusText` is schema-1 JSON (`.pi/extensions/lib/host-bridge/report-schema.ts`,
all objects closed):

| Field       | Type                                   | Meaning                                                       |
| ----------- | -------------------------------------- | ------------------------------------------------------------- |
| `schema`    | `1`                                    | Report schema version.                                        |
| `kind`      | `"status"` \| `"context"` \| `"usage"` | Which command produced it.                                    |
| `at`        | ISO-8601 string                        | Build time.                                                   |
| `sessionId` | string                                 | The reporting session; ignore reports for another session.    |
| `title`     | string                                 | `"Status"`, `"Context Usage"`, or `"Usage"`.                  |
| `sections`  | `{ title, rows }[]`                    | Generic rows `{ label, value, hint? }`; render them in order. |
| `context`   | object, `kind: "context"` only         | Typed figures for a breakdown bar (below).                    |
| `usage`     | object, `kind: "usage"` only           | Typed provider quota windows (below).                         |

Rows are generic so a new status row needs no host change. `value` is one
line; `hint` holds secondary detail, such as the inventory behind a count or
the cost breakdown, and may span lines. A status report has a `Session Info`
section (name, file, ID, messages, tokens, cache warming, cost) and an
`Environment` section (every `/status` row, including reasoning effort,
Daybreak, and Fast mode).

The `context` block:

| Field                | Meaning                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `model`              | `provider/id`, or `""` with no model.                                                                                                |
| `contextWindow`      | Window size in tokens.                                                                                                               |
| `measuredTokens`     | Provider-measured context tokens; `null` before a response or when the sample predates compaction.                                   |
| `estimatedTokens`    | Sum of `categories`, the figure the text bar draws.                                                                                  |
| `autocompactReserve` | Tokens reserved for compaction.                                                                                                      |
| `categories`         | `{ label, tokens, estimated }` in bar order: system prompt, system tools, MCP tools, custom agents, context files, skills, messages. |
| `tools`              | `{ active, deferred }` tool counts.                                                                                                  |
| `mcp.servers`        | `{ name, tools, tokens, state? }`; `state` is `registered` or `disabled` for registered servers.                                     |
| `skills`             | `{ count, tokens }`.                                                                                                                 |
| `contextFiles`       | `{ count, tokens }`.                                                                                                                 |

Free space is `contextWindow - (measuredTokens ?? estimatedTokens) - autocompactReserve`,
floored at zero. Reports carry paths (session file, cwd, context files) but no
credentials or MCP configuration beyond the enable flag.

A usage report has one section per signed-in provider (`Claude`, `ChatGPT`, `Synthetic`, `Grok`) with `Plan`,
`Status`, and `Snapshot` rows when present and one row per quota window. Providers without
credentials get no provider section and no `usage.providers` entry; when there are any, a last
section titled `Not signed in` lists one row per provider (`label` the provider name, `value`
`not signed in`). `Grok` carries the subscription credit window (such as `Weekly`) with an OAuth
sign-in and only a `Status` row with an API key. `ChatGPT` reports the
active model's provider when it is a configured `openai-codex` or `openai`, else `openai-codex`
(Codex usage windows), else `openai` (signed in, no quota window). Each quota window row has (`value` such as `42% used`; `hint` the reset time, pace,
and provider detail as the Usage tab prints them). The `usage` block:

| Field                                 | Meaning                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `observedAt`                          | ISO-8601 time the provider queries finished.                                                        |
| `providers[].name`                    | Provider display name.                                                                              |
| `providers[].plan`                    | Plan label, such as `Max (5x)` or `Pro 200`, when known.                                            |
| `providers[].status`                  | Free text: sign-in state, `unavailable (<error>)`, credits, or extra-usage state.                   |
| `providers[].cached`                  | `{ at, reason? }` when the reading was served from the store instead of a live response.            |
| `providers[].windows[].label`         | Window name, such as `5h`, `7d`, `Opus 7d`, or `Weekly credits`.                                    |
| `providers[].windows[].percent`       | 0–100 as reported, read with `qualifier` (`"used"` or `"remaining"`).                               |
| `providers[].windows[].resetsAt`      | ISO-8601 time of the next reset or regeneration; `resetLabel` names it (`resets`, `regenerates …`). |
| `providers[].windows[].detail`        | Provider detail, such as remaining requests or credits.                                             |
| `providers[].windows[].windowSeconds` | Fixed window length; pace is `(windowSeconds - (resetsAt - now)) / windowSeconds`.                  |
| `providers[].windows[].pace`          | `{ health: "over" \| "under", label }` decided by the provider for refilling buckets.               |

Usage reports carry no account ID, token, cookie, or other credential.

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
  --pi-launcher "$HOME/.pi/agent/bin/pi" \
  --model openai/gpt-6.1-sol \
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
