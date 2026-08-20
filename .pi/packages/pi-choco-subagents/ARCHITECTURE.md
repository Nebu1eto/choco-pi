# pi-choco-subagents — module map and extension seams

This document exists for the choco-pi phases that build **on top of** the
vendored core: focused-agent fullscreen takeover, dismissible side
conversations, and dynamic workflow fan-out. It maps the modules that matter and
names the exact attachment point for each of those three, so a later phase does
not have to re-derive them from a 3,000-line entry file.

Nothing here is a design. It is a map.

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
| `agent-manager.ts` | Record lifecycle: spawn, queue, concurrency, abort, steer, resume, completion callbacks, handle allocation and tombstones, `maxConcurrent` scheduling. |
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
| `output-file.ts` | Per-agent `.output` JSON-lines transcript under `<tmpdir>/pi-choco-subagents-<uid>/`, compaction-safe streaming. |
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
| `ui/conversation-viewer.ts` | The live conversation overlay: scroll, stop (two-press), and the inline steering composer. |
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

**What exists.** An agent conversation is already a modal overlay with a single
owner. Two call sites open it, both with the same shape:

- `ui/fleet-list.ts` → `FleetList.openViewer()` (Enter on a fleet row)
- `index.ts` → `viewAgentConversation()` (`/agents → Running agents`)

Both call `ctx.ui.custom<undefined>(factory, { overlay: true, overlayOptions: {
anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` } })` and
construct a `ConversationViewer`.

**Where a takeover attaches.**

1. *Geometry*: `VIEWPORT_HEIGHT_PCT` (exported from
   `ui/conversation-viewer.ts`) is the single constant both the overlay's
   `maxHeight` and the viewer's own `viewportHeight()` read, precisely so the
   two cannot disagree. A fullscreen profile is a second pair of values threaded
   through the same two places — not a new cap in one of them.
2. *Renderer*: `ConversationViewer` is a plain `Component` with `render(width)`,
   `handleInput(data)` and `chromeLines()`. A takeover mode is a constructor
   option that changes `viewportHeight()` and the chrome it draws; the steering
   composer, the two-press stop guard and the `session.subscribe` live update
   need no change.
3. *Input ownership*: while an overlay is open, `FleetList.handleKey` returns
   early and lets the overlay own every key (`if (this.viewerClose) …`). That is
   the existing modality guarantee a takeover would inherit.
4. *Focus*: `FleetList.setUICtx` registers a global `ui.onTerminalInput` handler
   that fires **before** the focused component, and deliberately drops keys
   unless pi's prompt `Editor` is focused. A fullscreen mode that must capture
   keys while nothing else is focused changes that predicate, and only it.
5. *Selection continuity*: `viewingAgentId` + `clearViewer()` already restore
   the cursor to the viewed agent by id after the list reorders. Reuse it rather
   than adding parallel state.

**What a takeover must not break.** The widget (`aboveEditor`) and FleetView
(`belowEditor`) are separate registrations from the overlay, and they clean up
differently. `FleetList.setEnabled(false)` is the supported way to drop the
fleet row. The widget has no equivalent: it is registered and cleared inside
`AgentWidget.update()` (`setWidget("agents", …)` / `setStatus("subagents", …)`)
and torn down in `dispose()`. A fullscreen mode that must hide the widget should
add the toggle there rather than calling `setWidget("agents", undefined)`
directly, or the next `update()` re-registers it.

## Seam B — dismissible side-conversation overlay

**What exists.** Addressing an agent from the prompt already works end to end,
and the whole flow funnels through one handler.

- `pi.on("input", …)` in `index.ts` is the only place typed text is claimed.
  It returns `{ action: "continue" | "transform" | "handled" }`, so a side
  conversation is a fourth branch of an existing decision, not a new hook.
- `mention.ts::parseMention` decides what counts as a mention; only a leading
  `@handle` followed by a message qualifies.
- `AgentManager.resolveMention(handle)` returns `{ kind: "live", record }`,
  `{ kind: "tombstone", entry }`, or nothing — the three states a side
  conversation would have to render differently.
- `mention-clone.ts::runMentionClone` starts an agent from conversation context
  through a throwaway session clone, without a visible main-model turn. That is
  the existing precedent for "do work without putting a turn in the transcript",
  which is the same property a side conversation needs.
- `ui/agent-mention.ts::createMentionProvider` is stacked on pi's autocomplete
  via `ctx.ui.addAutocompleteProvider`; handle rows are merged into pi's own
  suggestion list rather than replacing it.

**Where a side conversation attaches.**

1. *Entry*: a new branch in the `input` handler, after `parseMention` and after
   the `@main` reservation check, returning `{ action: "handled" }` so no main
   turn is spent. `agentMentions` (`"model" | "direct" | "off"`) is the existing
   mode setting; a side-conversation mode belongs in that union rather than in a
   parallel flag.
2. *Surface*: a sibling of `ConversationViewer` opened through the same
   `ctx.ui.custom(..., { overlay: true })` path. "Dismissible" is the difference
   that matters: `ConversationViewer` is modal and calls `done(undefined)` on
   `Esc`/`q`, and `FleetList` tracks exactly one open overlay through
   `viewerClose`/`viewingAgentId`. A dismissible overlay that survives dismissal
   needs its own owner — that single-viewer assumption in `FleetList` is what a
   later phase has to revisit, and it is confined to those two fields.
3. *Reply delivery*: `AgentManager` completion callbacks already fan out to
   `groupJoin.onAgentComplete`, `sendIndividualNudge`, the widget refresh and
   the lifecycle events. A side conversation is another consumer of that same
   completion callback, addressed by record id.
4. *Identity*: handles, aliases (`Agent(name:)`) and tombstones already give a
   stable address that outlives the in-memory record, including reopening a
   session from disk under `rememberAgents`. A side conversation should address
   agents by handle, not by record id, or it inherits the ~10-minute eviction
   bug that tombstones were added to fix.

## Seam C — dynamic workflow fan-out

**What exists.** Fan-out is already implemented for the one-turn case, and every
spawn source converges on one function.

- `index.ts::spawnTopLevel` is the single validated entry point. The `Agent`
  tool, the scheduler at fire time, cross-extension RPC and nested delegation
  all resolve their type through `resolveSpawnType` and then reach
  `spawnResolved` → `AgentManager.spawn`. A refused type never reaches
  `runAgent`. A workflow engine adds a caller here; it does not add a path.
- `index.ts::finalizeBatch` debounce-groups background spawns from one turn:
  each new agent resets a 100 ms window, and 2+ agents in `smart`/`group` join
  mode become a group. Agents that completed during the window are fed in
  retroactively.
- `group-join.ts::GroupJoinManager` holds a group until all members finish or a
  30 s timeout fires (15 s for stragglers after a partial delivery), then calls
  one `DeliveryCallback(records, partial)`. That is a join barrier with a
  timeout — the primitive a fan-out/fan-in workflow step needs.
- `types.ts::JoinMode` is `'async' | 'group' | 'smart'`;
  `invocation-config.ts::resolveJoinMode` decides it per spawn.
- `schedule.ts::SubagentScheduler` + `schedule-store.ts` provide time-triggered
  spawns that survive restarts.

**Where fan-out attaches.**

1. *Grouping*: `finalizeBatch` groups by *arrival time*, which is right for
   "the model made four parallel tool calls" and wrong for "step 3 of a workflow
   spawns four units". An explicit group id passed through `SpawnOptions` and
   registered directly with `groupJoin.registerGroup` bypasses the debounce
   without touching it. `AgentRecord.groupId` already exists and is already what
   `onAgentComplete` keys off.
2. *Barriers*: extend `JoinMode` rather than adding a second completion path.
   Everything downstream — deferred notifications, partial-delivery labelling,
   straggler re-batching — reads that one field.
3. *Dependencies between steps*: nothing models them today. `AgentManager`
   queues on `maxConcurrent` only. A dependency-aware scheduler belongs beside
   the queue in `agent-manager.ts`, not in the tool handler, because nested
   children deliberately do **not** occupy `maxConcurrent` slots (queueing them
   behind their waiting parent would deadlock) and any new gate inherits that
   constraint.
4. *Depth and privilege*: `nested-tools.ts` caps nesting via `maxSubagentDepth`
   and gates delegation on `allowed_subagents`. Fan-out driven by a workflow
   definition still runs through those checks — the allowlist is a privilege
   boundary, not a routing hint, so a workflow cannot widen what an agent may
   spawn.
5. *Out-of-process drivers*: `cross-extension-rpc.ts` already exposes spawn and
   stop with a versioned envelope (`PROTOCOL_VERSION = 2`). A workflow engine
   living in another extension needs no new transport.

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
