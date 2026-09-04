# Zed runtime E2E evidence

Evidence record for running choco-pi inside real Zed through the ACP adapter.
It records what was actually observed, attempt by attempt: steps that could not
be observed are BLOCKED, and steps where the adapter misbehaved are FAIL, not
passes. Earlier attempts record defects that later commits fixed; read the
summary below for the current state and the attempt sections for the history.

## Current state

Latest verdict per step, with the attempt that produced it. Each attempt ran
against Zed 1.18.0 with a throwaway profile and fixture; the adapter revision is
named in each attempt's header.

| #   | Step                                                            | Verdict | Attempt |
| --- | --------------------------------------------------------------- | ------- | ------- |
| 0   | Isolated profile setup, apply, and doctor                       | PASS    | 2       |
| 1   | Create a new local ACP thread with the `choco-pi` agent         | PASS    | 2       |
| 2   | Verify startup information and model controls                   | PASS    | 3       |
| 3   | Attach a selected code range and submit a prompt                | PASS    | 2       |
| 4   | Extension command, prompt-template command, skill command       | PASS    | 3       |
| 5   | Trigger and complete a generic selection dialog                 | PASS    | 5       |
| 6   | Run a built-in tool and a choco-pi custom tool                  | PASS    | 2       |
| 7   | File-location navigation and structured edit diff               | PASS    | 3       |
| 8   | Sync focused context through a Zed Task to the intended session | PASS    | 6       |
| 9   | Resume the session from Zed history                             | PASS    | 2       |
| 10  | Disconnect during streaming and during elicitation              | PASS    | 5       |
| 11  | SSH project                                                     | BLOCKED | 2       |
| 12  | Terminal Thread fallback independent of the ACP session         | PASS    | 2       |

Step 11 has not been exercised: no SSH target was available, and the remote
path remains the documented-manual procedure in `docs/zed-setup.md`. Step 4's
attempt-3 pass carries a deviation (the stop attempt missed and `/check`
completed instead of being cancelled). Attempt 4 was blocked before UI input and
changed no verdict.

## Attempt 2 — full run

Attempt 2 re-ran the steps that attempt 1 could not reach.

### Run header

- Date: 2026-09-03, 15:04–15:32 EAT
- Zed: 1.18.0 (`/Applications/Zed.app`)
- Node: v26.8.1 (`/opt/homebrew/Cellar/node/26.8.1/bin/node`)
- Adapter under test: this working tree at `HEAD` `a6f8d70e`
  ("feat: harden ACP adapter and ship Zed setup docs"), executed from source as
  `node /Users/Nebuleto/Workspace/choco-pi/.pi/packages/choco-pi-acp/bin/choco-pi-acp.ts`.
  The only uncommitted file during the run was this document. No Git write
  command was executed.
- Result: 6 PASS, 3 FAIL, 3 BLOCKED, over the 12 numbered steps.
- Screenshots: window-scoped captures of the isolated Zed window only, under
  `/tmp/choco-pi-zed-e2e2/shots/`. No full-screen capture was taken.

### Fixture project

Throwaway Git repository at `/tmp/choco-pi-zed-e2e2/fixture.gBoGnM`, created
with `git init`, two harmless files and one commit (`1e166f1 init fixture`):

- `greet.js` — two exported functions, `greet(name)` and `add(a, b)`
- `README.md` — three lines of placeholder text

No secrets. The repository is outside the choco-pi checkout.

### Isolation method

Throwaway Zed profile at `/tmp/choco-pi-zed-e2e2/profile.u7Xneo`, configured
through the adapter's own setup command against the isolated configuration
directory only, then launched through LaunchServices:

```sh
PROFILE_DIR=$(mktemp -d); FIXTURE=$(mktemp -d)
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --dry-run --zed-config-dir "$PROFILE_DIR/config"
node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
  --apply --zed-config-dir "$PROFILE_DIR/config"
open -n -a /Applications/Zed.app --args --user-data-dir "$PROFILE_DIR" "$FIXTURE"
```

Isolation was verified before any UI was driven. For the instance actually used
for this run, pid 37591:

```text
$ ps -ww -o pid=,command= -x | grep 'Zed.app/Contents/MacOS/zed'
37591 /Applications/Zed.app/Contents/MacOS/zed --user-data-dir /tmp/choco-pi-zed-e2e2/profile.u7Xneo /tmp/choco-pi-zed-e2e2/fixture.gBoGnM

$ lsof -p 37591 | grep -c "$PROFILE_DIR/db"        -> 30
$ lsof -p 37591 | grep -c "Library/Application Support/Zed/db" -> 0
```

Thirty open handles on `/private/tmp/choco-pi-zed-e2e2/profile.u7Xneo/db/...`
including `db/0-stable/db.sqlite`, and zero handles on the real user profile
database. The real user profile was never a setup target.

#### Attempt-1 isolation defect (carried forward)

Attempt 1 proved that the recipe previously published in `docs/zed-setup.md`
does not isolate:

```sh
zed --user-data-dir "$PROFILE_DIR" <fixture-project>
```

The launched instance used the **real** user profile. Attempt-1 evidence:

- `ps -o command= -p 86390` printed `/Applications/Zed.app/Contents/MacOS/zed`
  with no `--user-data-dir` argument.
- `lsof -p 86390` showed
  `/Users/Nebuleto/Library/Application Support/Zed/db/0-stable/db.sqlite` and
  `.../db/0-global/db.sqlite` open.

Attempt 1 also acknowledged one side effect, repeated here: that first,
non-isolated Zed instance wrote to the user's Zed workspace database while it
was open. `settings.json` was provably unchanged; other user profile state was
not checksummed before that run and so cannot be asserted unchanged.

#### Anomaly on this run's first launch

The first `open -n` launch of this run (pid 29153) was itself observed
non-isolated: `ps -ww` showed the binary with **no** arguments, and `lsof`
showed the real user profile `db/0-stable/db.sqlite` and `db/0-global/db.sqlite`
open, with zero handles on the throwaway profile. It was terminated
(`pkill -x zed`) immediately, before any UI action, observation, or screenshot.

This observation is not fully explained: the throwaway profile tree
nonetheless contained `db/0-stable/db.sqlite` timestamped during that same
launch window. The runner cannot say from the data collected whether a second,
isolated instance existed briefly. Recorded as an anomaly, not as a diagnosis.
The relaunch (pid 37591) was verified isolated by the counts above before any
UI was driven. As with attempt 1, that first instance is assumed to have
touched the user's Zed workspace database; `settings.json` is provably
unchanged.

#### settings.json SHA-256

| Point          | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| Before the run | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |
| After the run  | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |

Equal. The user's Zed `settings.json` was not modified.
`~/.config/zed/tasks.json` still does not exist.

### Step verdicts

| #   | Step                                                            | Verdict                                     |
| --- | --------------------------------------------------------------- | ------------------------------------------- |
| 0   | Isolated profile setup, apply, and doctor                       | PASS                                        |
| 1   | Create a new local ACP thread with the `choco-pi` agent         | PASS                                        |
| 2   | Verify startup information and model controls                   | FAIL (model controls pass, no startup info) |
| 3   | Attach a selected code range and submit a prompt                | PASS                                        |
| 4   | Extension command, prompt-template command, skill command       | BLOCKED (no prompt template exists)         |
| 5   | Trigger and complete a generic selection dialog                 | BLOCKED (no elicitation could be triggered) |
| 6   | Run a built-in tool and a choco-pi custom tool                  | PASS                                        |
| 7   | File-location navigation and structured edit diff               | FAIL (navigation passes, no diff rendered)  |
| 8   | Sync focused context through a Zed Task to the intended session | FAIL (`WORKSPACE_NOT_APPROVED`)             |
| 9   | Resume the session from Zed history                             | PASS                                        |
| 10  | Disconnect during streaming and during elicitation              | BLOCKED (streaming half passes)             |
| 11  | SSH project                                                     | BLOCKED (documented-manual, no SSH target)  |
| 12  | Terminal Thread fallback independent of the ACP session         | PASS                                        |

### Per-step evidence

#### Step 0 — Isolated profile setup, apply, and doctor — PASS

```text
$ node .pi/packages/choco-pi-acp/bin/choco-pi-acp.ts zed setup \
    --dry-run --zed-config-dir "$PROFILE_DIR/config"
Project execution: local
Zed config directory: /tmp/choco-pi-zed-e2e2/profile.u7Xneo/config
Command path: /opt/homebrew/Cellar/node/26.8.1/bin/node
PI_ACP_ENABLE_EMBEDDED_CONTEXT=true
Dry run: no files written.
```

The dry run printed the intended `agent_servers.choco-pi` entry with
`"type": "custom"`, the absolute Node path, the absolute
`.pi/packages/choco-pi-acp/bin/choco-pi-acp.ts` argument, and
`"PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true"`.

`--apply` reported `Applied setup settings; backup: not needed` and
`Applied setup tasks; backup: not needed`, creating `settings.json` (327 bytes)
and `tasks.json` (2911 bytes), both mode `0600` in a `0700` directory.

`zed doctor --zed-config-dir "$PROFILE_DIR/config"` printed
`Settings status: Status: configured`, `Tasks status: Status: configured`,
`Status: configured`, exit code 0.

All six documented Task labels were present in the generated `tasks.json`:
Sync Focused Context, Sync Focused Context (No Selection), Sync Saved File
Context, List Live Sessions, Select Context Target, Open Terminal Thread. The
focused-context Task carried the selection through
`env.CHOCO_PI_ZED_SELECTION = "$ZED_SELECTED_TEXT"` and never as a command
argument, with `"save": "none"`, `"show_command": false`,
`"show_summary": false`.

Unlike attempt 1, this configuration was then genuinely consumed by a running
Zed instance (see step 1).

#### Step 1 — Create a new local ACP thread with the `choco-pi` agent — PASS

On first open, Zed showed an "Unrecognized Project / Restricted Mode" dialog
for `/private/tmp/choco-pi-zed-e2e2/fixture.gBoGnM`
(`/tmp/choco-pi-zed-e2e2/shots/01-zed-window.png`). The dialog was dismissed by
a runner-issued coordinate click and the "Restricted Mode" title-bar badge
cleared, so the throwaway fixture became trusted
(`shots/02-after-click.png`). The runner cannot state with certainty which
control the click landed on; the trusted end state is what was observed. Only
the runner's own throwaway fixture was trusted, inside the throwaway profile.

UI actions: clicked the agent-panel icon in the status bar, then the `+`
new-thread control in the panel header. The menu rendered
(`shots/09-newthread-menu.png`):

```text
Zed Agent        ⌘N
Terminal
External Agents
  choco-pi
+ Add More Agents
```

`choco-pi` appearing under "External Agents" is direct evidence that Zed read
and accepted the generated isolated `settings.json`.

Clicking `choco-pi` created the thread, titled "New choco-pi Thread"
(`shots/10-chocopi-thread.png`), with the composer placeholder
`Message choco-pi — @ to include context, / for commands`.

The adapter was spawned by the isolated Zed instance:

```text
$ ps -ww -o pid=,ppid=,command= -x | grep choco-pi-acp
8944 37591 /opt/homebrew/Cellar/node/26.8.1/bin/node \
  /Users/Nebuleto/Workspace/choco-pi/.pi/packages/choco-pi-acp/bin/choco-pi-acp.ts
```

Parent pid 37591 is the verified-isolated Zed instance.

#### Step 2 — Startup information and model controls — FAIL

Model controls: PASS. The composer footer rendered two adapter-provided
controls, `openai-codex/GPT-5.6 Sol` and `Thinking: low`. Opening the model
control produced a populated `Select an option...` picker
(`shots/11-model-selector.png`) listing, among others:

```text
anthropic/Claude Fable 5
anthropic/Claude Haiku 4.5 (latest)
anthropic/Claude Opus 4.5 (latest)
anthropic/Claude Opus 5
anthropic/Claude Sonnet 4.5 (latest)
anthropic/Claude Sonnet 4.6
```

Startup information: NOT observed. The newly created thread rendered no startup
banner, no version line, no model/effort summary, and no session-id line — only
the empty composer placeholder (`shots/10-chocopi-thread.png`). Nothing
resembling startup information appeared before or after the first prompt.

Because half of the step's required observation is absent, the step is FAIL,
not a partial pass. The runner did not determine whether a `quietStartup`
setting suppressed it; `getQuietStartup` exists in
`.pi/packages/choco-pi-acp/src/acp/pi-settings.ts`, but its effective value for
this session was not read, so no cause is claimed.

#### Step 3 — Attach a selected code range and submit a prompt — PASS

UI actions: clicked line 1 of `greet.js`, pressed `shift+down` twice and
`shift+end`; Zed's status bar read `3:2 (3 lines, 58 characters)`. Ran
`agent: add selection to thread` from the command palette
(`shots/12-addsel-palette.png`).

Observed: the mention chip `greet.js (1:3)` was inserted into the composer
(`shots/13-selection-attached.png`).

Submitted prompt (verbatim as it reached the thread):

```text
state the exact first line of the attached selection, then reply zed-e2e-step3-ok
```

Observed reply (`shots/14-step3-response.png`):

```text
export function greet(name) {
zed-e2e-step3-ok
```

The agent reproduced the exact first line of the attached range, so the
selection reached the adapter with correct content and bounds.

Tooling note: this prompt was typed with per-character `keypress` actions
before the correct `typeText` action name was known, which is why the submitted
text is lowercase. This is a harness artifact, not adapter behavior.

#### Step 4 — Extension, prompt-template, and skill commands — BLOCKED

Extension command: PASS with a rendering defect. Typing `/` opened a populated
command menu (`shots/15-slash-commands.png`) listing `context`, `rewind`,
`effort`, `fast`, `review`, `exit`, `clear`, `delete`, `session-new`,
`sessions`, `session-send`, with descriptions (`context` showed "Show context
usage by prompt, tools, MCP, agents, files, skills, and messages").

`/context` executed and returned a real report
(`shots/16-context-cmd.png`): `14k/600k tokens (2.3%)`, `Tools: 38 active · 57
deferred`, `MCP tools · /mcp └ 7 servers · 198 tools · 648 tokens`,
`Skills └ 21 skills · 1.7k tokens`.

**Adapter defect observed.** Raw ANSI SGR escape sequences leaked into the
rendered ACP output. The first line rendered literally as:

```text
[38;2;212;212;212mContext Usage
```

and the final line ended with a literal `[39m` after
`21 skills · 1.7k tokens`. Progress-bar block characters also rendered as
tofu boxes. The adapter is emitting terminal-styled text to an ACP client that
renders it verbatim.

Skill command: PASS. Filtering with `/skill` showed skill commands namespaced as
`skill:<name>` (`shots/18-skill-filter.png`): `skill:task`, `skill:figma`,
`skill:check`, `skill:review`, `skill:commit`, `skill:task-core`,
`skill:find-skills`, `skill:task-inline`, `skill:task-hotfix`,
`skill:task-dynamic`, `skill:mcp-scripting`, with descriptions. Running
`/skill:mcp-scripting` returned `Loaded the mcp-scripting skill.`
(`shots/19-skill-cmd.png`).

Prompt-template command: BLOCKED. Prompt templates are read from
`~/.pi/agent/prompts/*.md`
(`.pi/packages/choco-pi-acp/src/acp/agent.ts:1801`). That directory does not
exist on this machine, so no prompt-template command existed to invoke. The
runner is limited to writing `docs/zed-e2e-evidence.md` and `/tmp`, so creating
one was out of authority. No claim is made about prompt-template commands.

The step is BLOCKED because one of its three required commands could not be
exercised at all.

#### Step 5 — Trigger and complete a generic selection dialog — BLOCKED

No elicitation or generic selection dialog was produced by any action taken in
this run. File edits, shell execution, and tool calls were all carried out
without any Zed-side approval or selection prompt appearing.

The one approval-gated path that did surface (step 8) did not present a dialog:
the adapter returned an immediate `WORKSPACE_NOT_APPROVED` rejection instead of
asking. That is recorded under step 8, and is the closest the run came to an
elicitation.

No claim is made about elicitation rendering, completion, cancellation, timeout,
or release, because none was observed.

#### Step 6 — Built-in tool and choco-pi custom tool — PASS

Submitted prompt (verbatim):

```text
Do three things in order. 1) Use the Read built-in tool on README.md and quote its
first line. 2) Use the choco-pi custom tool symbol_search with query greet and
report the top file. 3) Use the edit tool to add the line // e2e-marker as a new
first line of greet.js.
```

Observed (`shots/20-tools-edit.png`): the thread rendered an interleaved run of
`Thinking` blocks and tool calls, including seven `exec` tool calls and one
`symbol_search` tool call, each with its own labelled row. Final answer:

```text
1. README.md first line: # Fixture
2. Top greet result: greet.js
3. Added // e2e-marker as the first line of greet.js.
```

`# Fixture` matches the fixture file exactly. `symbol_search` is a choco-pi
custom tool and rendered as a first-class tool call in Zed. The edit landed:
`greet.js` line 1 became `// e2e-marker` with a green change bar in the gutter.

Deviation worth recording: the agent satisfied "the Read built-in tool" with
`exec` rather than a `Read` tool call. Both a built-in tool (`exec`) and a
custom tool (`symbol_search`) were nonetheless exercised and rendered, which is
what this step requires.

#### Step 7 — File-location navigation and structured edit diff — FAIL

Navigation: PASS. `greet.js` was rendered as a clickable link inside the
assistant message. `README.md` was opened first so a change would be
observable, then the `greet.js` link in the thread was clicked. Zed switched the
active editor to `greet.js` and the project panel highlighted `greet.js`
(`shots/21-link-nav.png`).

Structured edit diff: NOT rendered. To rule out tool choice as the cause, a
second prompt explicitly demanded the patch path:

```text
Use the apply_patch tool (not exec, not shell) to change the first line of
greet.js from // e2e-marker to // e2e-marker-2.
```

The agent replied `I'll update only that first-line marker using apply_patch.`
and the file did change to `// e2e-marker-2`. But the thread rendered the
operation as a bare `exec` tool-call row followed by prose,
`Changed the first line of greet.js to // e2e-marker-2.`
(`shots/22-diff.png`). There was no diff card, no added/removed line rendering,
and no accept/reject affordance anywhere in the panel.

The adapter does not surface file edits to Zed as ACP diff content, so the user
sees an opaque tool call where a reviewable diff is expected. Recorded as FAIL.

#### Step 8 — Focused context through a Zed Task to the intended session — FAIL

CLI, against the fixture cwd:

```text
$ node .pi/packages/choco-pi-editor-context/src/cli.ts list --cwd /tmp/choco-pi-zed-e2e2/fixture.gBoGnM
Matching live sessions: 1
'... cli.ts' 'select' '--session-id' '01a06738-d889-74e6-9ced-54714b604ea4' \
  '--owner-id' '637ed99b-0913-403c-84b0-06d068caa3d6' \
  '--cwd' '/tmp/choco-pi-zed-e2e2/fixture.gBoGnM' # status=idle model="openai-codex/gpt-5.6-sol"

$ ... cli.ts select --session-id 01a06738-... --owner-id 637ed99b-... --cwd "$F"
Context target selected.
select_exit=0

$ CHOCO_PI_ZED_SELECTION='return a + b;' ... cli.ts publish --cwd "$F" \
    --path "$F/greet.js" --line 6 --column 2 --zero-based-position \
    --language javascript --symbol add --selection-env CHOCO_PI_ZED_SELECTION
Editor context published.
publish_exit=0
```

Both commands reported success with exit code 0. The next prompt in the
selected session was:

```text
Without using any tool, report the focused editor context you were given: file
path, line, symbol, and selected text.
```

Observed reply (`shots/23-editor-context.png`):

```text
Editor context rejected (WORKSPACE_NOT_APPROVED).No focused editor context was
provided: file path, line, symbol, and selected text are all unavailable.
```

The context did not reach the session's prompt. `publish` reported
`Editor context published.` and exit 0 while the consuming session rejected the
payload outright, so the failure is invisible at the Task and CLI layer where a
user would look. This is the observable defect. Note also the missing space in
the rendered message, `(WORKSPACE_NOT_APPROVED).No focused`.

Second finding, on targeting. Two ACP threads were created in the same Zed
window; both are sessions of the single adapter process 8944. After creating
the second thread, `list` still reported `Matching live sessions: 1`, and the
advertised session id had changed from `01a0672f-6c0f-7645-a51f-a37424ba9fd1`
to `01a06738-d889-74e6-9ced-54714b604ea4`. The first thread's session was no
longer listed, so it could not have been selected as a target. "Prove it reached
the INTENDED session" could therefore not be demonstrated as a choice between
two candidates; there was never more than one candidate to choose from.

#### Step 9 — Resume the session from Zed history — PASS

UI actions: panel overflow menu → `Toggle Threads Sidebar`
(`shots/24-panel-menu.png`). The sidebar listed both choco-pi threads
(`shots/25-threads-sidebar.png`). Clicked the older thread, "state the exact
first line of the attached s…".

Observed (`shots/26-resume.png`): the full prior transcript was restored,
including the original user messages, the `Thinking` blocks, all `exec` and
`symbol_search` tool-call rows, the `greet.js` links, and the final answers from
steps 3, 6 and 7.

Interactivity and context retention were then confirmed rather than assumed:

```text
Without tools: what marker string did you write into greet.js earlier in this
thread?
```

Reply (`shots/27-resume-continuity.png`):

```text
// e2e-marker-2
```

The resumed session answered correctly from restored history, so resume is
functional and not merely a rendered transcript.

#### Step 10 — Disconnect during streaming and during elicitation — BLOCKED

Streaming half: PASS. A long streaming turn was started in the resumed ACP
thread:

```text
Count slowly from 1 to 200, writing each number on its own line, with a short
sentence about each number.
```

At the moment of disconnect the thread was actively streaming, having reached
`40 — Forty` (`shots/31-streaming.png`), and the composer showed the stop
control. Adapter state immediately before: `ps -o pid=,stat= -p 8944` → `8944 Ss`.

Disconnect at 15:31:18 via `pkill -TERM -x zed`, then polled once per second:

```text
t=1s adapter=[gone] zed=[none]
t=2s adapter=[gone] zed=[none]
...
t=10s adapter=[gone] zed=[none]
--- final ---
no adapter, no zed
```

The adapter settled within one second of the client disconnect, mid-stream, and
left no orphaned process. Nothing needed to be reaped afterwards.

Elicitation half: BLOCKED. No elicitation could be triggered at any point in
this run (see step 5), so disconnecting during one could not be attempted. Turn
and adapter settlement under that condition is unverified.

Because the step explicitly requires both conditions and only one was observed,
the step is BLOCKED, not PASS.

#### Step 11 — SSH project — BLOCKED

Not attempted, by instruction. No SSH target is available. This remains a
documented-manual path, matching the existing statement in `docs/zed-setup.md`
that remote operation is documented but not verified end to end.

#### Step 12 — Terminal Thread fallback independent of the ACP session — PASS

UI actions: `+` new-thread menu → `Terminal`. A terminal thread opened, titled
`fixture.gBoGnM — zsh`, with its shell cwd in the fixture and the prompt
reporting the fixture's Git branch (`fixture.gBoGnM on main [!]`).

`pi --version` printed `0.84.4` (`shots/29-terminal-thread.png`).

The fallback TUI itself was then launched with `pi`
(`shots/30-pi-tui.png`). It rendered its own independent session: its own
composer, its own model line `gpt-5.6-sol OpenAI low`, its own footer
`fixture.gBoGnM on main [!] up for 15s` and `0.0%/600k (auto) · $0.000 (sub)`.
The fresh 0.0% context usage and $0.000 cost confirm it did not share state with
the ACP session, which was at 2.3% by that point.

Independence was also confirmed at the process level: throughout the terminal
thread and TUI launch, the adapter remained the single unchanged process
`8944 37591 ... choco-pi-acp.ts`. The TUI ran as a separate process tree under
Zed's terminal, not through the adapter. The two existing ACP threads remained
untouched in the threads sidebar.

### Cleanup

- All `zed` processes started by this run were terminated; `pgrep -x zed`
  reports none. The adapter process is gone.
- The throwaway profile `/tmp/choco-pi-zed-e2e2/profile.u7Xneo`, fixture
  `/tmp/choco-pi-zed-e2e2/fixture.gBoGnM`, and screenshots under
  `/tmp/choco-pi-zed-e2e2/shots/` were left in place for inspection.
- The only repository file written by this run is this document.
  `git status --porcelain` reports only `?? docs/zed-e2e-evidence.md`.

### Adapter defects found

1. ANSI escape sequences leak into ACP output. `/context` rendered
   `[38;2;212;212;212mContext Usage` and a trailing `[39m` verbatim in Zed, plus
   tofu boxes for progress-bar glyphs. The adapter emits terminal-styled text to
   a client that does not interpret it. Step 4.
2. File edits are not surfaced as structured diffs. Even when `apply_patch` was
   explicitly demanded, the edit rendered as a bare `exec` tool call with no
   diff card and no accept/reject affordance. Step 7.
3. Focused-context publish reports success while the session rejects it.
   `publish` printed `Editor context published.` with exit 0, but the session
   reported `Editor context rejected (WORKSPACE_NOT_APPROVED)`. The failure is
   invisible at the Task/CLI layer. The rendered message is also missing a space
   after the period. Step 8.
4. Only one live session is advertised per adapter process. With two ACP threads
   open in one Zed window, `choco-pi-editor-context list` reported
   `Matching live sessions: 1` and advertised only the newest session id, so the
   older thread could not be targeted. Step 8.
5. No startup information is presented in a new thread. Step 2.

### Limitations and unverified claims

Everything below is unproven by this run.

1. No claim about prompt-template commands. `~/.pi/agent/prompts/` does not
   exist on this machine and creating one was outside the runner's write
   authority, so none was ever invoked.
2. No claim about elicitation rendering, completion, cancellation, timeout, or
   release on disconnect. No elicitation or generic selection dialog was
   produced by any action in this run.
3. No claim about adapter or turn settlement on disconnect during an
   elicitation. Only the streaming disconnect was exercised.
4. No claim about SSH projects.
5. No claim that focused-context sync ever reaches a session successfully. The
   only attempt was rejected with `WORKSPACE_NOT_APPROVED`. The cause of that
   rejection was not investigated, and no workspace-approval flow was found or
   attempted.
6. No claim that focused-context sync can be routed to a chosen session among
   several, because only one live session was ever advertised.
7. The step 8 Task was exercised by invoking the CLI directly with the same
   arguments the generated Task carries, not by running the Zed Task entry from
   Zed's task picker. Zed's own Task execution path and its `$ZED_*` variable
   substitution are therefore unverified.
8. Step 6 exercised `exec` as the built-in tool because the agent chose it; a
   `Read` tool call was requested but not made, so `Read` specifically is
   unverified.
9. The cause of the missing startup information is not established; no
   `quietStartup` value was read for this session.
10. The reason the run's first Zed launch (pid 29153) appeared non-isolated is
    not established, and the contradictory profile-directory timestamps were not
    resolved. As with attempt 1, that instance is assumed to have written to the
    user's Zed workspace database. `settings.json` is provably unchanged; other
    user profile state was not checksummed before the run.
11. The Restricted Mode trust dialog was dismissed by a coordinate click whose
    exact target the runner cannot confirm; only the resulting trusted state was
    observed.
12. Prompt text in step 3 was submitted lowercase due to a harness limitation in
    the runner's keyboard input, not adapter behavior.
13. Zed is GPUI-rendered and exposes essentially no accessibility tree (the
    window reported six nodes, all window chrome; text search returned nothing).
    All UI verification therefore rests on window-scoped screenshots and
    coordinate-driven interaction rather than queried element state.

## Attempt 3 — closing-wave rerun

Attempt 3 ran on 2026-09-03 from 16:47 to 17:18 EAT against `HEAD`
`608f8a2b76896d8c2983c0ca804648238dc34794`, with the inherited implementation
changes still uncommitted. It reused one throwaway profile only after the first
launch proved isolation and performed no UI interaction.

### Attempt-3 fixture, profile, and isolation

- Evidence root: `/private/tmp/choco-pi-zed-e2e3-KVjDeB`
- Throwaway profile: `/private/tmp/choco-pi-zed-e2e3-KVjDeB/profile`
- Throwaway fixture: `/private/tmp/choco-pi-zed-e2e3-KVjDeB/fixture`
- Fixture commit: `95d430a` (`init fixture`)
- Screenshots: `shots/01-isolated-launch.png` through
  `shots/14-thread-closed-child-live.png`

Every launch used:

```sh
open -n -a /Applications/Zed.app --args \
  --user-data-dir /private/tmp/choco-pi-zed-e2e3-KVjDeB/profile \
  /private/tmp/choco-pi-zed-e2e3-KVjDeB/fixture
```

Retained isolation evidence: `logs/zed-lsof-existing-45360.txt` records pid 45360
with 42 isolated-profile lines and zero real-profile (`Application Support/Zed`)
lines, and `logs/zed-lsof-1.txt` records pid 87191 (a Zed process of this run
whose pid the narrative did not otherwise note) with 44 isolated-profile lines and
zero real-profile lines. The per-pid handle counts for the corrected relaunch
(pid 42808) and the item-H restart (pid 50661) were observed during the run, but
their `lsof` outputs were not retained; those two counts are unretained
observations, not reproducible evidence.

The first ACP startup attempt used
`PI_CODING_AGENT_DIR=/Users/Nebuleto/Workspace/choco-pi/.pi`; Zed's log recorded
`session/new` failing with `Authentication required`, and no Pi child started.
The run removed that override from the throwaway Zed profile, leaving the
authenticated global Pi profile in use. It copied the existing repository
template `.pi/prompts/check.md` verbatim to the fixture's project profile at
`.pi/prompts/check.md`, and added project-local `quietStartup: false` so the run
could exercise the shipped default startup behavior. No credential file was
read, copied, or changed.

### Attempt-3 settings hash

| Point          | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| Before the run | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |
| After the run  | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |

Equal. The after value is retained in `final-cleanup.txt`; the before value was observed at run start but not retained as an attempt-3 artifact (it matches the value retained by attempt 2). The profile and configuration operations described above are narrative observations without retained Zed logs.

### Attempt-3 requested verdicts

| Check   | Verdict             | Observed evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 2  | PASS                | After project-local `quietStartup: false`, the thread showed `pi v0.84.4`, Skills, and Extensions startup information. The composer showed `openai-codex/GPT-5.6 Sol` and `Thinking: low` (`shots/04-startup-model-controls.png`).                                                                                                                                                                                                                                                                                                                                                           |
| Step 4  | PASS with deviation | `/context` rendered its usage report without literal ANSI SGR fragments; `/skill:mcp-scripting` settled with `What MCP task would you like me to perform?`; `/check` was advertised beside `skill:check` from the copied project template (`shots/06-context-command.png`–`shots/08-prompt-template-check.png`). The stop attempt missed; `/check` completed instead of being cancelled.                                                                                                                                                                                                     |
| Step 5  | FAIL                | `/review` with no arguments rendered the generic `Review target` form with `Current session` and `Branch base: main`. `Branch base: main` was selected and Submit was clicked, but the visible result ended `Review target selection was cancelled.` (`shots/09-review-picker.png`, `shots/10-review-picker-result.png`).                                                                                                                                                                                                                                                                    |
| Step 7  | PASS                | The requested `tools.apply_patch` edit inserted `// e2e-u5b-marker`. Zed rendered an `exec (apply_patch)` diff card with the added line in green (`shots/11-apply-patch-diff-card.png`).                                                                                                                                                                                                                                                                                                                                                                                                     |
| Step 8  | FAIL                | `list --cwd` was observed to return two live sessions and `select` was observed to accept one session/owner pair, but no CLI transcript was retained, so those observations are unretained (`step10-process-after-close.txt`, which is retained, shows two Pi children without ids). Zed's Task picker listed List Live Sessions, Open Terminal Thread, and Select Context Target, but filtering for `Sync Focused Context` returned `No matches`; the configured focused-context Task could not be run and no `[Editor context]` block was observed (`shots/12-focused-task-no-match.png`). |
| Step 10 | FAIL                | With the second thread's `/review` picker open, `cmd+w` closed the agent thread pane. Its Pi child, pid 94721, was still running after the five-second bounded check and remained a child of adapter pid 51732 (`shots/13-review-picker-before-close.png`, `shots/14-thread-closed-child-live.png`, `step10-process-after-close.txt`).                                                                                                                                                                                                                                                       |
| Item H  | PASS                | After the first ACP thread existed, the isolated Zed was restarted with the same profile. **Search threads…** showed the prior `New Agent Thread` entry before the untouched **Import Threads** button, while the reopened thread showed choco-pi startup content and composer (`shots/05-item-h-search-threads.png`). No import action was used.                                                                                                                                                                                                                                            |

### Attempt-3 process evidence and deviations

On the successful first thread, Zed pid 42808 spawned adapter pid 43715, which
spawned Pi child pid 43732. After the item-H restart, Zed pid 50661 spawned
adapter pid 51732. Creating a second ACP thread left two simultaneous Pi
children, pids 51749 and 94721; `choco-pi-editor-context list` returned both
distinct session and owner pairs.

The `/check` prompt-template turn was supposed to be stopped before model or
tool execution. The coordinate stop action opened the model picker instead,
and the turn completed visibly with Node.js v26.8.1 and Pi 0.84.4 checks. This
deviated from the instruction that no additional Pi process run during E2E; the
run did not repeat the command. No separate Pi process was started to inspect
E2E state; the wave's separately authorized real-Pi test suite is outside this
runtime attempt.

`cmd+w` closed the thread pane but did not stop its Pi child, so step 10 did not
meet its shutdown requirement. On final cleanup, `SIGTERM` was sent only to the
task-owned isolated Zed pid 50661; the Zed process, adapter, and both Pi children
all exited within 500 ms. The cleanup log is retained at `final-cleanup.txt`.
No macOS permission prompt appeared.

## Attempt 4 — final defect wave

Attempt 4 was prepared on 2026-09-03 at 21:29 EAT against repository `HEAD`
`a1a3f12b` plus the uncommitted final-wave changes. The focused regression
tests and all four root gates passed before launch. The real-Zed portion was
then blocked at the mandatory isolation check, before any UI input.

### Attempt-4 fixture and retained artifacts

- Evidence root: `/private/tmp/choco-pi-zed-e2e4-aRbhPO`
- Throwaway profile: `/private/tmp/choco-pi-zed-e2e4-aRbhPO/profile`
- Throwaway fixture: `/private/tmp/choco-pi-zed-e2e4-aRbhPO/fixture`
- Run metadata and fixture revision: `run-header.txt`
- Setup dry run, apply, and doctor: `logs/setup-dry-run.txt`,
  `logs/setup-apply.txt`, and `logs/setup-doctor.txt`
- Required gate outputs: `logs/root-lint.txt`, `logs/root-fmt-check.txt`,
  `logs/root-typecheck.txt`, and `logs/root-test.txt`

The profile's agent environment set `PI_ACP_SESSION_IDLE_MS=60000`, the
documented minimum, and routed ACP through the task-owned `relay.mjs` so a raw
Zed elicitation response could be retained without adding adapter debug code.
The relay was never started because no isolated Zed process was created.

### Attempt-4 isolation block

A non-task-owned Zed process, pid 79907, already existed before the attempt.
`logs/zed-processes-before.txt` records its command as
`/Applications/Zed.app/Contents/MacOS/zed` with no `--user-data-dir` argument.
Two launches used the required command:

```sh
open -n -a /Applications/Zed.app --args \
  --user-data-dir /private/tmp/choco-pi-zed-e2e4-aRbhPO/profile \
  /private/tmp/choco-pi-zed-e2e4-aRbhPO/fixture
```

Neither launch created a new PID. `logs/zed-processes-after-launch.txt` and
`logs/zed-processes-after-relaunch.txt` contain only the same pre-existing pid
79907 and its crash handler. The retained full `lsof` output is
`logs/lsof-preexisting-79907.txt`; `logs/isolation-verdict.txt` records zero
handles under the throwaway profile and 86 handles under
`~/Library/Application Support/Zed`. Per the run authority, pid 79907 was
neither driven nor terminated. No UI action occurred, no adapter or Pi child
started, and no macOS permission prompt appeared.

### Attempt-4 settings hash

| Point          | Artifact                     | SHA-256                                                            |
| -------------- | ---------------------------- | ------------------------------------------------------------------ |
| Before launch  | `settings-sha256-before.txt` | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |
| After stopping | `settings-sha256-after.txt`  | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |

Equal. The user's Zed `settings.json` was unchanged.

### Attempt-4 requested verdicts

| Check   | Verdict | Observed evidence                                                                                                                                                                       |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 5  | BLOCKED | The isolation prerequisite failed before UI input, so `/review`, form submission, and the raw Zed response shape were not observed. The relay transcript files were never created.      |
| Step 8  | BLOCKED | Setup installed the revised focused-context Task descriptions, but no isolated editor existed in which to focus `greet.js`, open the Task picker, run a Task, or observe the next turn. |
| Step 10 | BLOCKED | The isolated profile was configured with the minimum 60-second idle timeout, but no adapter or Pi child started, so pane-close reaping could not be observed.                           |

These BLOCKED verdicts do not weaken the earlier attempt-3 FAIL evidence and
do not claim that the runtime defects are fixed. They record that the required
real-Zed re-check could not safely begin while the pre-existing non-isolated Zed
instance remained open.

## Attempt 5 — final real-Zed re-check

Attempt 5 ran on 2026-09-03 from 22:16 to 22:49 EAT against clean repository
`HEAD` `18d523873383a057637a31df7f17a4c7d863053a`. It exercised only steps 5,
8, and 10. No source file or user Zed configuration was changed. The evidence
root is `/private/tmp/choco-pi-zed-e2e5-x6edgm24`; its concise inventory is
`artifact-manifest.txt`.

### Attempt-5 fixture, profiles, and isolation

- Fixture: `/private/tmp/choco-pi-zed-e2e5-x6edgm24/fixture`, commit
  `62aa17f00a8d0b04e41dfa8a1ac1753d01cc542e`. `greet.js` contains the same
  two small exported functions used by the earlier runs; `README.md` is
  placeholder text.
- Primary profile for steps 5 and 8:
  `/private/tmp/choco-pi-zed-e2e5-x6edgm24/profile`.
- Clean sibling profile used for the definitive step-10 observation:
  `/private/tmp/choco-pi-zed-e2e5-x6edgm24/profile-step10`.
- Zed: `1.18.0+stable.351.49448afcab82f219b0ef4c58471cf81d23412475`.
- Node: `v26.8.1`.

Before each launch,
`pgrep -fl 'Zed.app/Contents/MacOS/zed'` returned no process. Both profiles were
created by `zed setup --apply --zed-config-dir <profile>/config`, and both were
launched with `open -n -a /Applications/Zed.app --args --user-data-dir
<profile> <fixture>`.

The primary Zed pid was 1235. `logs/lsof-before-driving-1235.txt` retained 44
handles under the primary throwaway profile and zero under
`~/Library/Application Support/Zed`; `logs/isolation-verdict.txt` records the
counts. The clean step-10 Zed pid was 43315.
`logs/step10-lsof-before-driving-43315.txt` retained 14 handles under its
throwaway profile and zero under the real Zed profile;
`logs/step10-isolation-verdict.txt` records those counts.

The relay configuration is retained in `logs/relay-config.txt`. It kept the
generated absolute Node and adapter paths, inserted the task-owned `relay.mjs`
to retain both ACP directions, and added this exact agent environment entry:

```json
"PI_ACP_SESSION_IDLE_MS": "60000"
```

The generated `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` entry remained present.
The 60,000 ms value is the documented minimum clamp.

### Attempt-5 settings hash

| Point         | Artifact                     | SHA-256                                                            |
| ------------- | ---------------------------- | ------------------------------------------------------------------ |
| Before launch | `settings-sha256-before.txt` | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |
| After cleanup | `settings-sha256-after.txt`  | `ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` |

Equal. The user's Zed `settings.json` was unchanged.

### Attempt-5 requested verdicts

| Check   | Verdict                        | Observed evidence                                                                                                                                                                                                                                          |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 5  | PASS                           | The `Review target` form offered and selected `Branch base: main`; Submit produced the adapter's `Review: main…HEAD` summary rather than cancellation. The exact accepted Zed response was retained.                                                       |
| Step 8  | FAIL                           | The Zed Tasks and explicit target selection succeeded, but the response was `greet.js:4:3` while the editor cursor was visibly on one-based line 3, column 2. Both coordinates were incremented by one.                                                    |
| Step 10 | PASS with controlled keepalive | At close, adapter pid 47627 owned survivor Pi pid 64612 and picker Pi pid 67495. At the retained follow-up 85 seconds later, pid 67495 was gone while the same adapter and survivor pid remained. The surviving Zed thread then replied `step10-final-ok`. |

### Step 5 — generic review selection — PASS

The primary Zed process spawned relay pid 29757 and adapter pid 29758. In a new
choco-pi thread, `/review` with no arguments rendered the `Review target` form.
`Branch base: main` was selected and Submit was activated. The successful form
and result are retained in:

- `shots/03-step5-review-picker-retry-before-submit.png`
- `shots/04-step5-review-summary-after-submit.png`

The result included:

```text
Review: main…HEAD
0 files, 0 hunks, 0 insertions, 0 deletions; 0 risky files, 0 risk findings
```

`logs/reconstructed-agent-messages.txt` retains that text from raw ACP chunks.
The relay also captured the exact Zed response to the elicitation in
`logs/step5-zed-elicitation-response.txt`:

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "action": "accept", "content": { "value": "choice-0" } } }
```

Deviation: two earlier submissions in the same profile were delayed long
enough by coordinate calibration that the configured 60-second reaper closed
their Pi child before the form could settle. Zed then displayed `Pi RPC process
is shutting down`. The same thread was restored and the successful form was
submitted immediately. These preliminary observations are not used as the
step-5 verdict.

### Step 8 — focused context Task and target — FAIL

`greet.js` was focused with the cursor visibly on line 3; Zed's status bar
showed `3:2`. The Task picker was opened from that editor focus. The first
**Choco Pi: List Live Sessions** run occurred after the Pi child had reached the
60-second idle clamp and correctly reported zero matches. After restoring the
thread, the Task was rerun successfully. Evidence:

- `shots/05-step8-live-sessions-terminal.png` shows the successful Zed Task
  output with the session/owner targeting command.
- `logs/step8-list-cli.txt` retains the same full session-id/owner-id pair from
  a supplementary read-only CLI capture.
- `logs/step8-select-terminal-transcript.txt` records the exact command entered
  in Zed's terminal and the observed `Context target selected.` result. The
  file is explicitly labelled as a manual transcription, not raw terminal
  capture.

The initial targeting command became stale when its session child idled out and
returned `LIVE_SESSION_NOT_FOUND`. After the thread was restored, the refreshed
owner id `48d47a79-1eff-4461-9908-5a203439d750` was selected successfully in
Zed's terminal.

With `greet.js` still focused on line 3, **Choco Pi: Sync Focused Context (No
Selection)** ran from the Task picker and printed `Editor context published.`
(`shots/08-step8-sync-focused-context.png`). The next prompt was exactly:

```text
Without using any tool, report the focused location from the editor context.
```

The reply was:

```text
greet.js:4:3
```

`shots/09-step8-focused-context-reply.png` retains the cursor on editor line 3
and the reply together. `logs/reconstructed-agent-messages.txt` independently
reconstructs `greet.js:4:3` from the raw ACP chunks.

The generated Task passes `$ZED_ROW` and `$ZED_COLUMN` with
`--zero-based-position`. On this installed Zed, the visible one-based cursor
`3:2` reached the model as `4:3`. This is the only attempt-5 result that needs a
code change: the generated Task/CLI position boundary must stop incrementing
the already one-based Zed values, with a real-Zed regression covering both row
and column.

### Step 10 — picker-thread idle reaping — PASS with controlled keepalive

Preliminary close cycles in the primary profile were retained but are not used
for this verdict. Because the 60-second clamp applies to every idle thread, UI
calibration also reaped the unrelated idle thread before a same-pid continuity
comparison could be completed. The definitive observation therefore used the
fresh `profile-step10` profile and exactly two relevant live children.

To keep the survivor active without creating another Pi process, its prompt
started a task-owned `sleep 100` through `shell_start` and waited for it. This
created a non-Pi `sleep` child under survivor Pi pid 64612. Active turns are not
eligible for idle reaping; the sleep completed before the follow-up process
snapshot, leaving the same Pi child available. This is a controlled test
keepalive, not product behavior being claimed.

A second choco-pi thread opened `/review` and left its picker pending
(`shots-step10/03-active-survivor-picker-before-close.png`). `cmd+w` closed that
thread pane. `logs/step10-active-survivor-immediate-after-close.txt` records:

```text
adapter 47627
  survivor Pi 64612
  closed-picker Pi 67495
```

The follow-up snapshot was taken 85 seconds after close: the 70-second wait was
started 15 seconds after the immediate snapshot. In
`logs/step10-active-survivor-after-70s.txt`, adapter pid 47627 and the same
survivor pid 64612 remain, while closed-picker pid 67495 is absent. The
remaining thread then accepted a new prompt and replied `step10-final-ok`
(`shots-step10/04-definitive-survivor-reply.png`).

### Attempt-5 cleanup and retained limitations

The primary task-owned Zed pid 1235 was terminated before the clean step-10
profile was launched; `logs/first-zed-cleanup.txt` shows no surviving process.
Finally, task-owned Zed pid 43315 was terminated. `logs/final-cleanup.txt`
records no matching Zed process and no task-owned relay, adapter, Pi, sleep, or
code-mode-host process afterward.

Only window-scoped Zed screenshots were retained. Zed still exposed no useful
accessibility tree, so text and control verification used the window images and
the raw ACP relay. No helper agent or separate Pi process was started. The only
non-Pi helper inside the tested survivor turn was the explicitly recorded
`sleep 100` keepalive described above.

## Attempt 6 — step-8 one-based position re-check

Attempt 6 ran on 2026-09-03 from 23:29 to 23:48 EAT against clean repository
`HEAD` `6c1de6685863c3d25795220ecb4c95947c9320e9`. It exercised only step 8.
No source file or user Zed configuration was changed. The evidence root is
`/private/tmp/choco-pi-zed-e2e6b-M2AAF3nP`; its inventory is
`artifact-manifest.txt`.

### Attempt-6 fixture, isolation, and processes

- Fixture: `/private/tmp/choco-pi-zed-e2e6b-M2AAF3nP/fixture`, commit
  `cdefd05651790d1fff0ef24029456a62afca1b77`.
- Throwaway profile:
  `/private/tmp/choco-pi-zed-e2e6b-M2AAF3nP/profile`.
- Zed: `1.18.0`; Node: `v26.8.1`.
- Zed pid 15928 spawned adapter pid 64246, which spawned its sole Pi child,
  pid 64247. No helper agent, relay, or separate Pi process was used.

Before launch, `pgrep -fl 'Zed.app/Contents/MacOS/zed'` returned no process.
`logs/lsof-before-driving-15928.txt` retains the complete pre-driving handle
list; `logs/isolation-verdict.txt` records 48 throwaway-profile handles and
zero handles under `~/Library/Application Support/Zed`.

The generated no-selection Task is retained in
`logs/generated-task-check.txt`. Its `$ZED_ROW` and `$ZED_COLUMN` arguments are
passed directly as `--line` and `--column`; it contains no
`--zero-based-position` argument.

The user's `~/.config/zed/settings.json` SHA-256 was
`ddef44401c15ad9514dea5faa042b589c155e98f5f6115272a6a8f9b6c702328` both
before and after the run (`settings-sha256-before.txt` and
`settings-sha256-after.txt`).

### Step 8 — focused context Task and target — PASS

`greet.js` was focused with its cursor at one-based line 3, column 2. The Zed
status bar visibly showed `3:2`; `shots/02-greet-line3-column2.png` retains that
prerequisite.

**Choco Pi: List Live Sessions** ran from Zed's Task picker and reported one
matching session. Its terminal output is retained in
`shots/05-list-live-sessions.png`; `logs/step8-list-cli.txt` retains the exact
session/owner pair. The advertised target was session
`01a068fd-5a45-7fc7-b4e1-ebd7f643385d`, owner
`61f635ce-6217-4258-99fe-9807e2420bad`. The corresponding `select` command
returned `Context target selected.` with exit 0
(`logs/step8-select-cli.txt`).

With `greet.js` still focused at `3:2`, **Choco Pi: Sync Focused Context (No
Selection)** ran from the Task picker and printed `Editor context published.`
(`shots/06-sync-focused-context.png`). The exact prompt was:

```text
Without using any tool, report the focused location from the editor context.
```

The definitive reply was:

```text
greet.js:3:2
```

`shots/07-step8-pass-reply.png` retains the reply and the editor status bar's
simultaneous `3:2`. Both one-based coordinates therefore passed through the
generated Zed Task unchanged. Step 8 is PASS.

### Attempt-6 deviations and cleanup

The setup subcommand does not accept `zed setup --help`; that failed probe is
retained in `logs/setup-help.txt`, and `zed --help` was retained instead. The
first restricted-mode dialog action selected **Stay in Restricted Mode**; the
dialog was reopened immediately and the task-owned fixture was then trusted
before creating the ACP thread or running any Task.

To preserve exact identifiers, a supplementary read-only `list` CLI capture
was made after the Zed Task. The `select` command was run directly from the
shell rather than typed into Zed's terminal. Both were Node CLI processes, not
additional Pi processes.

Two prompt submissions were rejected with `CONTEXT_EXPIRED` because
per-character UI entry exceeded the snapshot lifetime. One further sync was
not consumed while the exact prompt was prepared. For the definitive
observation, the already-prepared exact prompt was submitted immediately after
a fresh run of the same no-selection Zed Task. The passing verdict relies only
on that final fresh snapshot and reply; the earlier rejections remain visible
in `shots/07-step8-pass-reply.png`.

The isolated Zed instance was quit with `cmd+q`. `logs/final-cleanup.txt`
records no surviving task-owned Zed pid 15928, crash-handler pid 15937, adapter
pid 64246, Pi pid 64247, language-server child pid 64697, relay, or process
whose command contains the evidence-root path.
