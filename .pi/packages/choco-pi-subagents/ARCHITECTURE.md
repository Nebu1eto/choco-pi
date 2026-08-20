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
dismissible read-only `/btw` conversations, and root-orchestrated dynamic DAG
workflows with parallel subagents and aggregate results.

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

| Module | Role |
| --- | --- |
| `index.ts` | Extension factory: tool registration (`Agent`, `get_subagent_result`, `steer_subagent`), the `/agents` command tree, settings menus, the `input` mention hook, batch grouping, and every lifecycle handler. |
| `agent-manager.ts` | Record lifecycle: spawn, queue, concurrency, abort, steer, resume, completion callbacks, handle allocation and tombstones, `maxConcurrent` scheduling. Workflow steps carry aggregate/step ids but otherwise use this lifecycle unchanged. |
| `workflow.ts` | TypeBox workflow definition, graph/type/reference validation, bounded prompt rendering, mutable DAG scheduler, failure policy, cancellation and aggregate results. The runner interface keeps scheduling tests independent of live agents. |
| `agent-runner.ts` | Builds and drives the child `AgentSession`: tool allow/denylists, `ext:` narrowing, extension filtering, model runtime inheritance, turn limits, final-status classification. |
| `agent-types.ts` | The registry of spawnable types: defaults overlaid by user agents, `enabled` filtering, `resolveType`/`resolveSpawnType`, fallback policy. |
| `nested-tools.ts` | The scoped `Agent`/`get_subagent_result`/`steer_subagent` a subagent receives when its frontmatter sets `allowed_subagents`, plus the depth cap. |
| `cross-extension-rpc.ts` | `subagents:rpc:ping` / `:spawn` / `:stop` over the `pi.events` bus, with scoped reply channels. |

### Configuration

| Module | Role |
| --- | --- |
| `custom-agents.ts` | Parses `agents/*.md` frontmatter into `AgentConfig`. Discovery precedence: global < `.agents/agents/` < `.pi/agents/`. Unparseable files are skipped with a warning unless `strictAgentFiles`. |
| `default-agents.ts` | The three built-ins (`general-purpose`, `Explore`, `Plan`), skipped entirely under `disableDefaultAgents`. |
| `settings.ts` | `.pi/subagents.json` load/save and the `subagents:settings_loaded` / `changed` events. |
| `invocation-config.ts` | Collapses agent frontmatter and caller parameters into one invocation (`resolveAgentInvocationConfig`), and owns the shared `isolation` parameter schema. |
| `model-resolver.ts`, `model-scope.ts`, `enabled-models.ts` | Forgiving `model:` resolution and the Model Scope gate. |
| `skill-loader.ts`, `memory.ts` | Skill inheritance and per-agent memory scopes. |

### Execution context

| Module | Role |
| --- | --- |
| `worktree.ts` | `isolation: "worktree"` — create, work-path resolution for a subdirectory cwd, base-SHA capture, `--no-verify` preservation commit, prune. |
| `schedule.ts`, `schedule-store.ts` | Cron and interval jobs (`croner`), persisted across sessions. |
| `group-join.ts` | Holds a group of background agents and delivers one consolidated notification. |
| `output-file.ts` | Per-agent `.output` JSON-lines transcript under `<tmpdir>/choco-pi-subagents-<uid>/`, compaction-safe streaming. |
| `abortable.ts`, `child-context.ts`, `context.ts`, `env.ts`, `usage.ts`, `status-note.ts`, `prompts.ts` | Cancellation, child-session detection, message extraction, environment block, token accounting, result status notes, prompt assembly. |

### Prompt mentions (`@handle`)

| Module | Role |
| --- | --- |
| `mention.ts` | `parseMention`, handle derivation and collision numbering, `@main` reservation, `@agent-` alias stripping. |
| `mention-clone.ts` | The off-screen session clone that writes an agent's starting prompt from the conversation, holding only the `Agent` tool. |
| `ui/agent-mention.ts` | The autocomplete provider stacked on pi's own, merging handle rows into the file suggestions. |

### UI

| Module | Role |
| --- | --- |
| `ui/agent-widget.ts` | The `aboveEditor` widget and the `subagents` status-bar key. `WidgetMode` (`all`/`background`/`off`) is read live at render. |
| `ui/fleet-list.ts` | The `belowEditor` FleetView. All key handling goes through `ui.onTerminalInput`, gated on pi's prompt editor being the focused component. |
| `ui/conversation-viewer.ts` | The live conversation overlay: scroll, stop (two-press), inline steering/reply composer, and focus handoff. |
| `ui/side-conversation.ts` | BTW launch defaults, dismissible overlay ownership, continuation, and notice-only completion delivery. |
| `ui/schedule-menu.ts`, `ui/select-item.ts`, `ui/viewer-keys.ts` | Scheduled-job menu, list row formatting, keybinding resolution through `tui.select.*`. |

## The choco-pi role convention is not an upstream feature

`.pi/agents/*.md` in this repository carry `default_model:` and
`default_thinking:`. **Upstream parses neither.** `custom-agents.ts` reads
`model:` and `thinking:`, and unknown frontmatter keys are ignored.

That is deliberate and load-bearing: because the role file leaves
`AgentConfig.model` and `.thinking` undefined, `resolveAgentInvocationConfig`
lets the caller's spawn parameters win (`modelFromParams: true`). The
`default_*` keys are read by the **orchestrating agent** as documented baselines
it may adjust per unit, never by this extension. A later phase that wants the
extension itself to honor them must add the fields in `custom-agents.ts` *and*
decide the precedence question the current split avoids — pinning `model:`
there would make every spawn override inert.

`tests/subagent-config.test.ts` pins this: `implementer.model === undefined`,
`implementer.thinking === undefined`, and a caller-supplied model surviving
resolution.

## Seam A — focused agent fullscreen takeover

The modal remains the default conversation viewer. FleetView uses **Enter** to
open it and **f** on a selected agent to enter fullscreen focus directly; the
modal also exposes **f focus**. Focus mode uses the existing
`ConversationViewer` with `profile: "focus"`, so message extraction, tool-call
rows, nested `Agent` calls, activity text and `session.subscribe()` streaming
stay on the same data flow. Pi's main transcript scroll view owns clipping and
follow-end behavior in this profile instead of the modal's 70% viewport.

### State machine

```text
orchestrator (default)
  -- FleetView f / modal f --> focused(agentId, session)
focused(agentId, session)
  -- Esc / session switch / shutdown --> orchestrator
focused(A) -- focus(B) --> orchestrator -- focus(B)
```

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

`ui/focus-mode.ts::FocusedAgentController` holds two instance-scoped adapters:

1. `focused-conversation-render` wraps Pi's first TUI root, the stable main
   document container, and returns the focused `ConversationViewer` output.
   The orchestrator container and its streaming components remain mounted and
   continue receiving events behind the adapter; no conversation state is
   copied or cleared.
2. `focused-editor-input` wraps the current editor instance's `handleInput`.
   It snapshots the orchestrator draft, presents an empty focused buffer, and
   temporarily substitutes `onSubmit` only for one predecessor invocation, so
   zentui's `Symbol.for("pi-zentui.*")` factory and the prompt-stash instance
   wrapper remain in the chain. Esc exits focus. Submit calls the manager steer
   path and clears the focused buffer only when accepted; exit restores the
   orchestrator draft.

`ui/method-patch-registry.ts` stores adapters under
`Symbol.for("choco-pi-subagents.method-patch-registry")`. Each wrapper records
its exact predecessor descriptor. Cleanup restores that descriptor only when
its own wrapper is still outermost; if another extension wrapped it later, the
focus behavior is deactivated and the newer wrapper is left untouched. The
conversation wrapper rechecks the editor root every render and moves only the
input adapter if another extension legitimately replaces the editor while focus
is active.

Restoration is ordered: set state to `orchestrator`; deactivate/restore editor
input; deactivate/restore document render; unsubscribe and dispose the focused
viewer; clear the `subagent-focus` indicator; request a forced render. This
prevents a visible orchestrator transcript from briefly retaining subagent
input ownership. The subtle above-editor indicator names the focused handle and
keeps `Esc returns to main` visible. FleetView renders no rows and claims no
global input while focus is active.

## Seam B — dismissible side-conversation overlay

`/btw <question>` launches an ordinary top-level `AgentRecord` with
`sideConversation: true`. It uses the resolved `general-purpose` type, carries
no `parentAgentId` (the package's representation of orchestrator ownership), and
sets `isBackground: true`, so `AgentManager` applies the same `maxConcurrent`
queue as every other root background agent. The child session is persisted and
nested under the main pi session by the existing session-manager path.

### Context and capability profile

The launch sets `inheritContext: true`; `agent-runner.ts` therefore prepends
`buildParentContext(ctx)` through the existing subagent context-fork path before
the BTW question. No main-model turn is created and no side answer is injected
as a main-session message.

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

BTW history is session-scoped. `rememberAgents` persists each child transcript,
but manager records and tombstones live in memory and are cleared on session
start or switch, and the persisted `subagents:record` entry carries the BTW
marker without the session file, handle, or alias. Restoring side conversations
across restarts therefore needs a durable record-to-session index, so after a
restart `/btw` starts from an empty list.

FleetView includes side conversations as normal root agents, prefixes their row
with `[btw]`, and delegates Enter to the side controller's replyable overlay.
Its existing `f` path and the overlay's `f focus` callback both feed the same
`FocusedAgentController` used for ordinary subagents. Session switch dismisses
the overlay before focus restoration; shutdown disposes it before manager
cleanup.

## Seam C — dynamic workflow fan-out

The root extension registers four workflow tools beside `Agent`:
`workflow_run`, `workflow_update`, `get_workflow_result` and `workflow_cancel`.
Child sessions return before registering extension tools, and their scoped
nested tool set remains exactly `Agent`, `get_subagent_result` and
`steer_subagent`. A workflow step therefore cannot launch another workflow; the
existing child-session/depth boundary remains the privilege boundary.

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
`workflow_update({ finish: true })`.

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
once sealed and settled.

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
- Nested agent records stay internal to their parent: absent from top-level
  tools, lifecycle events and the agent UI, and stopped when the parent ends.
- A run that never started fails the tool call; a run that started and failed
  settles on its record. Do not collapse the two.
