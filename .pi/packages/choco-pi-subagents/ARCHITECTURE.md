# choco-pi-subagents — module map and extension seams

This document exists for the choco-pi phases that build **on top of** the
vendored core: focused-agent fullscreen takeover, dismissible side
conversations, and dynamic workflow fan-out. It maps the modules that matter and
names the exact attachment point for each of those three, so a later phase does
not have to re-derive them from a 3,000-line entry file.

Most sections are a module map. Seams A, B and C record the implemented
focus-mode, side-conversation and dynamic-workflow designs so future changes can
compose with their UI ownership, scheduling and delivery rules.

Current choco-pi additions over the vendored core are fullscreen subagent focus,
dismissible read-only `/btw` conversations, root-orchestrated dynamic DAG
workflows, runtime limits, and tree-wide agent messaging.

## Load path

`package.json` declares `pi.extensions: ["./src/index.ts"]`. Pi loads that
TypeScript through jiti; there is no build step. `src/index.ts` exports a single
default factory `(pi: ExtensionAPI) => void`, plus two helpers the widget layer
shares (`formatToolsSuffix`, `renderRunningAgentStatus`).

The factory registers nothing at call time. Everything — the RPC handlers, the
`subagents:ready` broadcast, the widget, the fleet list, the autocomplete
provider — is wired on the first bound `session_start`, because pi runs every
extension factory before applying an agent's `extensions:` filter and only
delivers lifecycle events to the survivors. A subagent session that filtered
this extension out must stay completely silent.

## Modules

### Orchestration core

| Module                     | Role                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                 | Extension factory: root tool registration (`Agent`, result/steer/stop, `agent_message`, workflows and limits), the `/agents` command tree, settings menus, the `input` mention hook, batch grouping, and lifecycle handlers.                                                                                                                     |
| `agent-manager.ts`         | Record lifecycle: spawn, queue, concurrency, abort, steer, resume, completion callbacks, globally unique handle allocation and tombstones, `maxConcurrent` scheduling. Before disposing an owned child session it invokes the optional shell cleanup bridge. Workflow steps carry aggregate/step ids but otherwise use this lifecycle unchanged. |
| `child-session-cleanup.ts` | Optional cross-extension disposal seam: resolves `Symbol.for("choco-pi-shells:manager")`, starts `cleanupOwner` for the child session id, and contains missing/malformed registries and cleanup rejection without delaying `AgentSession.dispose()`.                                                                                             |
| `workflow.ts`              | TypeBox workflow definition, graph/type/reference validation, bounded prompt rendering, mutable DAG scheduler, failure policy, cancellation and aggregate results. The runner interface keeps scheduling tests independent of live agents.                                                                                                       |
| `agent-runner.ts`          | Builds and drives the child `AgentSession`: tool allow/denylists, always-on child messaging, `ext:` narrowing, extension filtering, model runtime inheritance, turn limits, final-status classification.                                                                                                                                         |
| `agent-types.ts`           | The registry of spawnable types: defaults overlaid by user agents, `enabled` filtering, `resolveType`/`resolveSpawnType`, fallback policy.                                                                                                                                                                                                       |
| `nested-tools.ts`          | The scoped `Agent`/`get_subagent_result`/`steer_subagent`/`stop_subagent` a subagent receives when its frontmatter sets `allowed_subagents`, plus the depth cap.                                                                                                                                                                                 |
| `limits.ts`                | Pure runtime-limit and turn-start reminder formatting, root/nested persisted status registration, plus the root-only `subagent_limits` tool.                                                                                                                                                                                                     |
| `messaging.ts`             | Pure tree-path computation, whole-tree recipient resolution, agent-message envelope formatting/parsing and delivery classification.                                                                                                                                                                                                              |
| `agent-message.ts`         | Root/nested `agent_message` tool delivery through child sessions, `pendingSteers`, or the root follow-up queue; emits `subagents:message`.                                                                                                                                                                                                       |
| `cross-extension-rpc.ts`   | `subagents:rpc:ping` / `:spawn` / `:stop` over the `pi.events` bus, with scoped reply channels.                                                                                                                                                                                                                                                  |

`subagents:message` is a cross-extension event with `{ from, to, toId, type,
queued }`; paths are canonical tree identities and `toId` is undefined for
`/root`.

The child-session cleanup bridge is deliberately one-way and optional. The
subagents package imports no shell implementation; it looks up the shell
manager's process-global registry only at AgentManager-owned disposal points.
`cleanupOwner` is invoked before `AgentSession.dispose()` because shell cleanup
starts process signals synchronously, while its returned promise is observed
only to contain rejection and never extends the synchronous disposal path.

### Configuration

| Module                                                     | Role                                                                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom-agents.ts`                                         | Parses `agents/*.md` frontmatter into `AgentConfig`. Discovery precedence: global < `.agents/agents/` < `.pi/agents/`. Unparseable files are skipped with a warning unless `strictAgentFiles`. |
| `default-agents.ts`                                        | The three built-ins (`general-purpose`, `Explore`, `Plan`), skipped entirely under `disableDefaultAgents`.                                                                                     |
| `settings.ts`                                              | `.pi/subagents.json` load/save and the `subagents:settings_loaded` / `changed` events.                                                                                                         |
| `invocation-config.ts`                                     | Collapses agent frontmatter and caller parameters into one invocation (`resolveAgentInvocationConfig`), and owns the shared `isolation` parameter schema.                                      |
| `model-resolver.ts`, `model-scope.ts`, `enabled-models.ts` | Forgiving `model:` resolution and the Model Scope gate.                                                                                                                                        |
| `skill-loader.ts`, `memory.ts`                             | Skill inheritance and per-agent memory scopes.                                                                                                                                                 |

### Execution context

| Module                                                                                                 | Role                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `worktree.ts`                                                                                          | `isolation: "worktree"` — create, work-path resolution for a subdirectory cwd, base-SHA capture, `--no-verify` preservation commit, prune. |
| `schedule.ts`, `schedule-store.ts`                                                                     | Cron and interval jobs (`croner`), persisted across sessions.                                                                              |
| `group-join.ts`                                                                                        | Holds a group of background agents and delivers one consolidated notification.                                                             |
| `output-file.ts`                                                                                       | Per-agent `.output` JSON-lines transcript under `<tmpdir>/choco-pi-subagents-<uid>/`, compaction-safe streaming.                           |
| `abortable.ts`, `child-context.ts`, `context.ts`, `env.ts`, `usage.ts`, `status-note.ts`, `prompts.ts` | Cancellation, child-session detection, message extraction, environment block, token accounting, result status notes, prompt assembly.      |

Root and nested sessions add a hidden `subagent-status` custom message from
`before_agent_start` only while the shared ownership tree is active. Pi persists
that message before sending it to the model after the user prompt, so the next
reconstructed request retains the exact prior request followed by its assistant
response; the next turn's status message appends after that prefix. Each message
labels itself as a turn-start snapshot that becomes historical after its turn,
reports scheduled/cap and whole-tree counts, and carries the inherited depth
ceiling plus a nested session's current depth. No `context` handler is registered,
so provider/tool loops cannot duplicate reminders inside one agent-run start.

### Prompt mentions (`@handle`)

| Module                | Role                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mention.ts`          | `parseMention`, handle derivation and collision numbering, `@main` reservation, `@agent-` alias stripping.                |
| `mention-clone.ts`    | The off-screen session clone that writes an agent's starting prompt from the conversation, holding only the `Agent` tool. |
| `ui/agent-mention.ts` | The autocomplete provider stacked on pi's own, merging handle rows into the file suggestions.                             |

### UI

| Module                                                          | Role                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui/agent-tree.ts`                                              | Pure parent-first tree ordering shared by FleetView and the widget; siblings retain `startedAt` order and orphan records remain visible.                                                               |
| `ui/agent-widget.ts`                                            | The `aboveEditor` whole-tree widget and the `subagents` status-bar key. The status text is the tree-wide `active / cap` summary; `WidgetMode` (`all`/`background`/`off`) is read live at render.       |
| `ui/fleet-list.ts`                                              | The `belowEditor` parent/child FleetView. Nested rows retain the ordinary focus/view/stop actions. All keys go through `ui.onTerminalInput`, gated on pi's prompt editor being focused.                |
| `ui/conversation-viewer.ts`                                     | The live conversation overlay: scroll, stop, steering/reply and focus handoff. Ordinary messages use the main transcript components; agent-message envelopes render as a sender/type header plus body. |
| `ui/notification-render.ts`                                     | Pure completion and compact `subagents:message` notification formatters, independent of host/TUI side effects.                                                                                         |
| `ui/side-conversation.ts`                                       | BTW launch defaults, dismissible overlay ownership, continuation, and notice-only completion delivery.                                                                                                 |
| `preferences-section.ts`                                        | Shared `/agents` and `/preferences` setting rows, numeric ranges, live appliers, and the private root-owned preferences provider.                                                                      |
| `ui/schedule-menu.ts`, `ui/select-item.ts`, `ui/viewer-keys.ts` | Scheduled-job menu, list row formatting, keybinding resolution through `tui.select.*`.                                                                                                                 |

## The choco-pi role convention is not an upstream feature

`.pi/agents/*.md` in this repository carry `default_model:` and
`default_thinking:`. **Upstream parses neither**; this fork does, as
non-pinning defaults.

`custom-agents.ts` maps them to `AgentConfig.defaultModel` / `.defaultThinking`,
kept distinct from `model:` / `thinking:` so the precedence stays four-tiered in
`resolveAgentInvocationConfig` (and mirrored in `runAgent` for direct runner
callers):

1. `model:` / `thinking:` in frontmatter — a hard pin that outranks the caller.
2. the caller's spawn parameter — how an orchestrator moves a unit off an
   overloaded provider; it still beats the role default, which is what keeps
   that fallback usable.
3. `default_model:` / `default_thinking:` — the role's own preference.
4. the parent session's model runtime, last.

Tier 3 is why an omitted `model` no longer inherits the orchestrator's provider:
before it existed, an Anthropic orchestrator silently produced Anthropic
children whatever the role declared. Pinning `model:` instead of adding tier 3
would have made every spawn override inert, which is the trap this split avoids.

`tests/subagent-config.test.ts` pins it: `implementer.model === undefined` and
`implementer.thinking === undefined` (no pin), the parsed `defaultModel` /
`defaultThinking`, a caller-supplied model surviving resolution, and the
no-parameter case resolving to the role default.

## Seam A — focused agent fullscreen takeover

The modal remains the default conversation viewer. FleetView uses **Enter** to
open it, and its selection doubles as the focus: moving the cursor with ↑/↓ onto
a subagent row focuses that agent, and moving onto `main` restores the
orchestrator. **f** still focuses the selected row explicitly; the
modal also exposes **f focus**. Focus mode uses the existing
`ConversationViewer` with `profile: "focus"`, so message extraction, tool-call
rows, nested `Agent` calls, activity text and `session.subscribe()` streaming
stay on the same data flow. Pi's main transcript scroll view owns clipping and
follow-end behavior in this profile instead of the modal's 70% viewport. The
viewer also owns its tool/bash expansion flag and renders the focused session's
steering and follow-up queues in place of Pi's root pending-message area, with
each pending value clipped to its first terminal line before width truncation.

### State machine

```text
orchestrator (default)
  -- FleetView ↑↓ onto an agent row / FleetView f / modal f --> focused(agentId, session)
focused(agentId, session)
  -- FleetView ↑↓ onto main or a [btw] row / session switch / shutdown --> orchestrator
focused(A) -- ↑↓ onto B / focus(B) --> orchestrator -- focus(B)
```

Esc is not part of this machine. In FleetView it only leaves list navigation,
and the focused editor adapter swallows it, so a prompt addressed to a subagent
can neither exit focus by accident nor interrupt the main session. The adapter
asks `hasSwitcher()` (wired to the FleetView enabled flag) first: with the
switcher turned off there is no other way back, so Esc still exits. `/btw` rows
are excluded from selection-focus because they own a dismissible overlay opened
with Enter; selecting one restores the orchestrator transcript.

A finished agent may remain focused as a read-only transcript. Submitting text
there is consumed and retained in the editor; it never falls through to the
orchestrator. A running or queued target sends through `AgentManager.steer`, the
same dispatch boundary used by `steer_subagent`, and emits
`subagents:steered`. A settled target with a live session is resumed in the
background through `AgentManager.resume`, the same path `/btw` replies use; only
a session-less record rejects input, with the draft restored. The focused agent
owns any nested children, so steering is always addressed to its top-level
record id rather than a child tool call.

### Host patches held while focused

`ui/focus-mode.ts::FocusedAgentController` holds three instance-scoped adapters:

1. `focused-conversation-render` wraps Pi's first TUI root, the stable main
   document container, and returns the focused `ConversationViewer` output.
   The orchestrator container and its streaming components remain mounted and
   continue receiving events behind the adapter; no conversation state is
   copied or cleared.
2. A second instance-local render adapter wraps Pi's root pending-message
   sibling. It ignores the mounted orchestrator queue while focused and renders
   only the active child session's live `getSteeringMessages()` and
   `getFollowUpMessages()` values. While this adapter hides the root queue, the
   editor adapter also claims the configured `app.message.dequeue` action so Pi
   cannot move an orchestrator message into the focused prompt. A focus switch
   restores and disposes the old viewer/subscription before installing the new
   renderer, so the old child and main queue cannot leak into the next focused
   frame.
3. `focused-editor-input` wraps the current editor instance's `handleInput`.
   It snapshots the orchestrator draft, presents an empty focused buffer, and
   temporarily substitutes `onSubmit` only for one predecessor invocation, so
   zentui's `Symbol.for("pi-zentui.*")` factory and the prompt-stash instance
   wrapper remain in the chain. Esc follows the switcher rule above. Submit
   calls the manager steer path and clears the focused buffer only when
   accepted. Before invoking that predecessor, it resolves
   `app.message.dequeue` and `app.tools.expand` through pi-tui's live keybinding
   manager; the former is swallowed while the root queue is hidden and the
   latter toggles only the active viewer. The controller retains that flag per
   agent, so switching A → B starts/restores
   B independently and returning to A restores A. Exit restores the orchestrator
   draft and leaves Pi's main queue, expansion flag, and actions untouched.

`ui/method-patch-registry.ts` stores adapters under
`Symbol.for("choco-pi-subagents.method-patch-registry")`. Each wrapper records
its exact predecessor descriptor. Cleanup restores that descriptor only when
its own wrapper is still outermost; if another extension wrapped it later, the
focus behavior is deactivated and the newer wrapper is left untouched. The
conversation wrapper rechecks the editor root every render and moves only the
input adapter if another extension legitimately replaces the editor while focus
is active.

Restoration is ordered: set state to `orchestrator`; deactivate/restore editor
input; retain the viewer's per-agent expansion flag; restore pending and
document renderers; unsubscribe and dispose the focused viewer; clear the
`subagent-focus` indicator; request a forced render. This prevents a visible
orchestrator transcript or queue from briefly retaining subagent ownership. The
above-editor indicator renders nothing while FleetView is up — the switcher
already names the focused agent and its keys — and speaks only when the switcher
is off, where it is the sole signal focus is active and Esc is the exit.
FleetView keeps rendering its
rows while focus is active — it is the switcher — and keeps claiming ↑/↓, Enter,
`f` and Esc through `onTerminalInput` whenever list navigation is active, which
focusing leaves on. Its cursor is clamped to the focused record's row on every
refresh, and its roster keeps that record listed even after the finished-agent
linger window expires.

## Seam B — dismissible side-conversation overlay

`/btw <question>` launches an ordinary top-level `AgentRecord` with
`sideConversation: true`. It uses the resolved `general-purpose` type for record
naming, is prefixed with `[btw]` in FleetView and conversation views, carries no
`parentAgentId` (the package's representation of
orchestrator ownership), and sets `isBackground: true`, so `AgentManager` applies
the same `maxConcurrent` queue as every other root background agent. Its runtime
identity comes from the main agent rather than that record type.

### Context and capability profile

At launch, `captureMainSessionFork` clones the main session manager's active
branch into `SessionManager.inMemory()`. Pi 0.84.2 has native persisted fork APIs
but exposes the extension's current manager as read-only and has no non-mutating
in-memory fork operation, so the clone replays typed branch entries through
public `SessionManager` append APIs. Messages, tool calls/results, compactions,
branch summaries, custom messages, model changes and ordering remain model
context rather than becoming a text digest. The BTW question is sent unchanged;
ordinary `Agent(... inherit_context: true)` callers keep the existing
`buildParentContext(ctx)` preamble behavior.

The fork also captures the main model, thinking level and effective system
prompt. The runner uses those values instead of the selected subagent type's
runtime identity, then adds only the read-only BTW instruction block. No
main-model turn is created and no side answer is injected as a main-session
message.

Side conversations set the internal `readOnly` spawn option. The runner:

- admits only `read`, `grep`, `find`, and `ls` built-ins;
- loads no extensions and injects no nested delegation tools;
- keeps configured skills available as instructions;
- adds an explicit read-only side-conversation block to the child system prompt.

`spawnTopLevel` strips both `sideConversation` and `readOnly`, so RPC and global
registry callers cannot forge the marker to suppress ordinary result delivery.
The `/btw` controller calls the manager directly after resolving the type.

### Overlay lifecycle

`ui/side-conversation.ts::SideConversationController` waits for
`onSessionCreated`, then opens the existing `ConversationViewer` through
`ctx.ui.custom(..., { overlay: true })`. The viewer renders a `[btw]` tag and
uses its inline composer in `reply` mode. During an active run, submit routes to
`AgentManager.steer`. After settlement, submit calls background
`AgentManager.resume`, preserving the same child session and read-only tool
registry. Only one BTW overlay is shown at a time; multiple side records may run
concurrently.

`Esc` or `q` closes only the overlay. It does not call `AgentManager.abort`, so
the record keeps running or remains completed and reopenable. Dismissal also
cancels automatic presentation for that run: completion never steals focus.
When a dismissed side conversation settles, the manager completion callback
uses `ctx.ui.notify` and does not call `pi.sendMessage`, so no follow-up turn or
main transcript message is produced. `/btw` with no question lists current side
records and reopens the selected one.

BTW history is session-scoped and deliberately non-persistent. The fork uses an
in-memory session manager regardless of `rememberAgents`; manager records are
cleared on session start or switch. After a restart `/btw` therefore starts from
an empty list, with no durable record index or side-session transcript to
restore.

FleetView includes side conversations as normal root agents, prefixes their row
with `[btw]`, and delegates Enter to the side controller's replyable overlay.
Its existing `f` path and the overlay's `f focus` callback both feed the same
`FocusedAgentController` used for ordinary subagents. Session switch dismisses
the overlay before focus restoration; shutdown disposes it before manager
cleanup.

## Seam C — dynamic workflow fan-out

The root extension registers four workflow tools beside `Agent`:
`workflow_run`, `workflow_update`, `get_workflow_result` and `workflow_cancel`.
Child sessions return before registering root extension tools. They always get
`agent_message`; below the depth cap, eligible agents also receive the scoped
`Agent`, `get_subagent_result`, `steer_subagent` and `stop_subagent` set. A
workflow step therefore cannot launch another workflow; the existing child-
session/depth boundary remains the privilege boundary.

### Definition and validation

`workflow.ts::WorkflowDefinitionSchema` is the single JSON/TypeBox definition.
A definition has a name, an optional `dynamic` flag and one or more steps. Each
step has `id`, `subagent_type`, `prompt`, optional `needs`, `model`, `thinking`,
`max_turns`, `timeout_ms`, `isolation`, and `continue_on_error`. Launch and every
runtime update validate:

- structural schema and duplicate ids;
- enabled agent types, without the ordinary Agent fallback;
- unknown dependencies and cycles;
- `{{steps.<id>.output}}` references, which must name a transitive upstream
  dependency. Only the `output` field is available.

A static example:

```json
{
  "name": "inspect then implement",
  "steps": [
    { "id": "inspect", "subagent_type": "Explore", "prompt": "Find the cause." },
    {
      "id": "build",
      "subagent_type": "implementer",
      "needs": ["inspect"],
      "prompt": "Implement from this evidence:\n{{steps.inspect.output}}",
      "max_turns": 20
    }
  ]
}
```

### Scheduler and dynamic updates

`WorkflowManager` owns aggregate runs; each run has a pure DAG controller and a
`WorkflowStepRunner`. The controller starts definition-order ready steps up to
the manager's `maxConcurrent` snapshot. The production runner then uses normal
`AgentManager.spawn`, so workflow work also shares the live global pool with
ordinary agents. A step starts only after all `needs` are terminal. Independent
steps fan out and completion pumps newly ready dependents.

Failure is fail-fast unless the failed step sets `continue_on_error: true`.
Fail-fast marks pending steps skipped and aborts running siblings. A continued
failure permits dependents to run and makes the aggregate
`completed_with_errors`. `workflow_cancel` marks pending steps cancelled and
aborts running agent records.

A caller can replace only pending steps or add new steps atomically through
`workflow_update`; the combined graph is revalidated before mutation. A static
workflow may be updated while work remains. A definition with `dynamic: true`
stays `waiting` when idle so the orchestrator can inspect a completed result,
add result-dependent steps, and finally seal the graph with
`workflow_update({ finish: true })`. `get_workflow_result({ wait: true })`
blocks while an open workflow has running steps, then returns when it becomes
idle; the result's `sealed` field distinguishes an updateable idle graph from a
sealed run that will settle normally.

### Result passing, limits and delivery

Every final step output is captured in the aggregate. Prompt rendering replaces
an upstream reference immediately before launch. Each reference contributes at
most 32,000 characters including its truncation marker; repeated references are
bounded independently. `get_workflow_result` returns workflow status plus every
step's status, agent id, output, error and timestamps.

Each step resolves model, thinking, isolation and turn limits through the same
agent-frontmatter/caller precedence as `Agent`. Omitting `max_turns` inherits the
agent/package default. Omitting `timeout_ms` preserves the package's no
wall-clock-timeout behavior; setting it aborts that step at the given duration.

Workflow steps are ordinary top-level agent records tagged with `workflowId`
and `workflowStepId`. FleetView prefixes them `[wf:<step>]`; Enter and fullscreen
focus continue to operate on the underlying session. Static workflows suppress
individual result nudges and send one aggregate completion notification.
Dynamic workflows relay step completion notifications while open, allowing the
orchestrator to choose the next update, and send the aggregate notification
once sealed and settled. Settled aggregate records remain available for repeat
result reads for 10 minutes; a 60-second cleanup timer then removes the workflow
and its consumed marker together.

## Seam D — cooperative fleet navigation

FleetView and the shell widget install independent terminal-input listeners, and
the shells package normally loads first. They coordinate only through optional
read-only methods on the existing process-global
`Symbol.for("pi-subagents:manager")` entry. The root entry exposes
`hasFleetRows()` and `isFleetActive()` through a runtime FleetList source; before
FleetList construction both safely report false. No package imports the other's
runtime implementation.

Each shell keypress probes those methods again. Visible agent rows keep Down and
Left activation; Right activates shell navigation and is shown in the shell
widget hint. With no agent rows, shells retain Down activation. If FleetView is
already active, the earlier shell listener deactivates itself and yields every
navigation/action key, leaving a single active list. Root-first registry
ownership and identity-checked cleanup remain unchanged, so a child activation
cannot replace, mutate, or clear the root peer-state source.

## Invariants a later phase should not casually break

- The factory registers nothing; first bound `session_start` does. A subagent
  session must stay silent on the RPC channels.
- `Symbol.for("pi-subagents:manager")` is claimed by the first activation and
  released only by the owning one, identity-checked. Child activations must
  leave it alone.
- Every source file is erasable-syntax-only (no enums, namespaces, decorators or
  constructor parameter properties). Relative imports use explicit `.ts`
  extensions. Both are what let `node --test` import this package directly; new
  code must keep them true.
- Nested agent records stay hidden from top-level lifecycle events, prompt
  mentions and the agent UI, but are addressable by path through `agent_message`;
  they are stopped when the parent ends.
- A run that never started fails the tool call; a run that started and failed
  settles on its record. Do not collapse the two.
