# Vendored: choco-pi-subagents

This directory is a **vendored, renamed fork** of the upstream open-source
package **@tintinweb/pi-subagents**. This is not the original source repository.

- Original source code: https://github.com/tintinweb/pi-subagents
- Package on npm: https://www.npmjs.com/package/@tintinweb/pi-subagents
- Base version: `0.17.1`
- Base artifact: `tintinweb-pi-subagents-0.17.1.tgz`, `dist.shasum`
  `ff11f1edb8741309bad25e4452010351d432c5e1` (registry value, confirmed against
  `shasum -a 1` of the downloaded tarball)
- Forked on: 2026-08-20
- License: MIT (upstream `LICENSE` copied verbatim)
- Compile baseline: `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` at
  `0.84.2` — the same pin upstream declares as devDependencies in `0.17.1`

The fork exists so choco-pi can extend the sub-agent core in-tree (focused-agent
fullscreen takeover, dismissible side conversations, dynamic workflow fan-out)
without carrying a patch stack against a published package. See
`ARCHITECTURE.md` for the module map and the seams those phases attach to.

## What was taken

The tarball ships both `src/` (TypeScript) and `dist/` (built JS), and declares
`pi.extensions: ["./src/index.ts"]` — pi loads the TypeScript directly through
jiti. The fork keeps the source form:

- `src/**` — all 39 modules, verbatim except for the renames listed below
- `LICENSE` — verbatim
- `examples/agent-tool-description.md` — the starting point the `custom`
  `toolDescriptionMode` expects users to copy
- `CHANGELOG.upstream.md` — upstream `CHANGELOG.md`, kept for provenance and
  renamed so it cannot be mistaken for this fork's own history

## What was removed

Nothing functional. No feature, tool, setting, agent field, event or UI surface
was dropped, and no `src/` module is orphaned — `src/index.ts` transitively
reaches all 39 files (verified by a reachability walk over the import graph).

Removed items are upstream build, test and publish scaffolding that a vendored
source package cannot use:

| Removed                                                                                                                              | Why                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dist/**`                                                                                                                            | The package is loaded from `src/`; a second copy of every module would drift silently.                                                                             |
| `vitest.config.ts`                                                                                                                   | Upstream's `test/` directory is not part of the npm tarball, so the config points at nothing here.                                                                 |
| `CONTRIBUTING.md`, `SECURITY.md`                                                                                                     | Upstream project process; routes reports to the upstream repository.                                                                                               |
| Upstream `README.md`                                                                                                                 | Replaced by this fork's `README.md`, which documents the fork's name, wiring and load mechanism. Upstream's full feature manual stays available in its repository. |
| `package.json`: `repository`, `homepage`, `bugs`, `author`, `publishConfig`, `pi.video`, `pi.image`                                  | Point at the upstream project; this fork is `private` and not published.                                                                                           |
| `package.json`: `devDependencies`, `scripts.build`/`test`/`test:watch`/`test:e2e`/`test:coverage`/`lint`/`lint:fix`/`prepublishOnly` | The fork has no build step, no vendored test suite and no Biome config. `scripts.typecheck` is kept.                                                               |

## What was changed

### Identity

- `package.json` `name`: `@tintinweb/pi-subagents` → `choco-pi-subagents`;
  `version` → `0.17.1-choco.0`; added `"private": true` and `"type": "module"`.
- Console warning prefix `[pi-subagents]` → `[choco-pi-subagents]` (7 sites).
- Transcript temp root `<tmpdir>/pi-subagents-<uid>/` →
  `<tmpdir>/choco-pi-subagents-<uid>/` in `src/output-file.ts`, so this fork's
  `.output` transcripts cannot collide with a concurrently installed upstream
  copy. Owner-only `0700` and the per-agent layout below it are unchanged.

**Deliberately NOT renamed** — these are a cross-extension interface other
packages resolve by literal string, so renaming them would disconnect consumers
without producing a compile error:

- `Symbol.for("pi-subagents:manager")`, the global manager registry slot
- every `subagents:*` event name (`subagents:ready`, `subagents:started`,
  `subagents:completed`, `subagents:failed`, `subagents:steered`, `subagents:stopped`,
  `subagents:settings_loaded`, `subagents:record`, the `subagents:rpc:*`
  channels)
- the `subagents` status-bar key and `.pi/subagents.json` settings filename

One consequence of the package rename **is** user-visible: an extension answers
to its package's unscoped short name (upstream #143), which is derived at
runtime from the owning `package.json`. Agent frontmatter that allowlisted
`extensions: [pi-subagents]` must now say `choco-pi-subagents`. No agent file in
this repository names it, so nothing here needed updating.

### Import specifiers: `./x.js` → `./x.ts`

Upstream writes relative imports with the `.js` extension, the standard pattern
for a package compiled by `tsc` to `dist/`. Node's own type stripping does not
resolve `./x.js` to `./x.ts`, so a source-only package written that way can only
be loaded through jiti — which put the fork's modules out of reach of
`node --test` and of any direct-import check.

All 49 relative specifiers were rewritten to `.ts`. jiti resolves explicit
`.ts` specifiers, `tsc` accepts them under `allowImportingTsExtensions` (set in
this package's `tsconfig.json`), and plain `node` now loads every module.

### Constructor parameter properties desugared

Node's strip-only TypeScript mode rejects `constructor(private x: T)`. Four
classes used it — `GroupJoinManager`, `ConversationViewer`, `FleetList`,
`AgentWidget` — which made `src/index.ts` unloadable outside jiti. Each was
rewritten to an explicit field declaration plus an assignment at the top of the
constructor body, in the same parameter order and with the same visibility and
defaults that TypeScript would have emitted. `ConversationViewer` keeps
`keybindings` as a plain parameter, as upstream had it.

Every source file is now erasable-syntax-only, which is what lets the repository
test suite import the fork directly.

### Focused-subagent fullscreen mode

The fork adds `src/ui/focus-mode.ts` and `src/ui/method-patch-registry.ts` and
extends FleetView and `ConversationViewer` with fullscreen focus. Moving the
FleetView cursor onto a subagent row (or pressing `f`, or `f focus` in its modal
viewer) replaces Pi's main transcript rendering with that agent's live
conversation and binds the existing main editor to `AgentManager.steer`; moving
the cursor back onto `main` restores the exact orchestrator renderer and editor
input predecessor. FleetView therefore keeps rendering and keeps owning ↑/↓ while
an agent is focused, and Esc neither exits focus nor reaches the main session —
except with FleetView turned off, where Esc stays the only escape hatch and still
exits.
The above-editor focus indicator follows the same rule: silent while the switcher
is up, since it would only repeat it.
`/exit` (and `/quit`) typed at a focused prompt stops that agent and returns to
the orchestrator instead of quitting the session: the prompt belongs to the
subagent while focus is active, so the focused editor adapter claims the key
before Pi's command dispatch sees it.
`/btw` rows are excluded from selection-focus because they own a dismissible
overlay. `/agents` propagates a focus request through both nested menu
levels instead of reopening the parent selector, which would consume the first
Esc. The method registry uses an additive, instance-scoped wrapper so pi-zentui
and prompt-editor adapters remain composed. `tests/focus-mode.test.ts` pins
transcript swapping, streaming refresh, steering ownership, focus propagation,
Esc being swallowed, and restoration on exit; `tests/fleet-list.test.ts` pins
selection-driven focus switching, the `main` return, Esc leaving navigation only,
and the `/btw` exclusion.

### BTW side conversations

The fork adds `src/ui/side-conversation.ts`, the `/btw` command, an
orchestrator-owned `AgentRecord.sideConversation` marker, and a read-only runner
profile. BTW launches clone the main session's typed active branch into an
in-memory `SessionManager`, inherit the main model, thinking level and effective
system prompt, and send the side question without the ordinary text context
preamble. They share `maxConcurrent`, handles, FleetView and fullscreen focus,
but restrict runtime tools to `read`, `grep`, `find` and `ls` with extensions and
delegation disabled. `ConversationViewer` gains an opt-in reply-after-completion
mode so the dismissible overlay can steer a live run or resume the same settled
session. Completion outside the overlay uses a UI notice rather than a
main-transcript follow-up. `tests/side-conversation.test.ts` pins branch/tool
history cloning, non-persistence, unchanged prompting, the marker, dismissal and
steering behavior. Ordinary `inherit_context` callers retain the upstream text
preamble path.

### Dynamic subagent workflows

The fork adds `src/workflow.ts` and the root-only `workflow_run`,
`workflow_update`, `get_workflow_result` and `workflow_cancel` tools. A TypeBox
schema defines mutable DAGs of agent steps; launch/update validation rejects
unknown types or dependencies, cycles and invalid output references. The pure
scheduler fans out ready steps under `maxConcurrent`, renders bounded upstream
outputs into dependent prompts, supports fail-fast or `continue_on_error`, and
aggregates per-step status/output. Production steps use ordinary
`AgentManager` records tagged for FleetView and fullscreen focus. Dynamic runs
may wait idle for runtime additions before sealing; an aggregate wait returns
at that idle point with the `sealed` state so callers can update or finish the
workflow. Settled workflow records remain queryable for 10 minutes, then a
60-second cleanup timer evicts them and their consumed markers together. Nested
sessions receive no workflow tools. `tests/workflow.test.ts` uses a stub runner
to pin validation, topological scheduling, result bounds, failure policies,
dynamic updates, idle waits, retention and cancellation.

### LLM-callable subagent stopping

The fork adds root and ownership-scoped nested `stop_subagent` tools. Both use
`AgentManager.abort`, keep partial transcripts readable, and no-op after
settlement. Root stops resolve ids or handles, exclude nested children, emit
`subagents:stopped`, and consume the result before aborting so completion cannot
trigger a redundant follow-up turn. Workflow-step stops remain allowed: the
workflow runner observes the manager's terminal record and settles the step as
an error, preserving scheduler state and failure policy. `src/stop-subagent.ts`
holds the pure decision logic; `tests/stop-subagent.test.ts` pins every outcome.

### Runtime-adjustable subagent limits and reminders

- `maxConcurrent: 0` now means unlimited concurrency while the scheduler still
  enforces a 1024-agent machine-safety cap. Persisted settings accept 0, runtime
  changes drain the shared manager queue immediately, and workflow fan-out uses
  the concrete capped value rather than treating 0 as no capacity.
- The root session gains the runtime-only `subagent_limits` tool. It reads or
  updates concurrency and depth without writing `.pi/subagents.json`; nested
  sessions do not receive the tool.
- Root and nested model contexts receive one fresh, hidden `<system-reminder>`
  line while any running or queued record exists. It compares the active
  top-level background records governed by `maxConcurrent` with that cap and
  separately reports the whole ownership-tree total. Nested reminders also
  carry the current agent depth and inherited depth ceiling. The root-only
  limits tool reports the same scheduled and whole-tree counts.
  `tests/limits.test.ts` pins parsing, capped unlimited scheduling, tool output,
  reminder suppression/formatting and non-accumulating context injection.

### Tree-wide agent messaging

The fork gives every live record a globally unique handle and alias, auto-numbered
on collisions, and uses the bare `alias ?? handle` as its agent-message identity.
Root and every child session receive `agent_message`, including isolated,
read-only and depth-capped leaves; recipients resolve across the whole tree by
alias, handle or id. Legacy `/root/...` input remains accepted by its final
segment. `/root` reuses the completion-notification follow-up path:
`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.
Running sessions receive messages immediately, pre-session records reuse
`pendingSteers`, and settled records reject delivery.

When a spawn has `name`, that globally unique alias becomes its preferred flat
address and its fleet/widget label while the type-derived handle remains valid.
The nested `Agent` tool forwards `name` just like the root tool. Both schemas
guide callers to use distinct role-prefixed, goal-derived aliases; duplicate
names anywhere in the live tree are numbered. Tombstone reservation remains
top-level-scoped.

Agent-originated text is always wrapped as `<agent-message from="…"
type="MESSAGE|TASK|FINAL">…</agent-message>` at the tool boundary. Root and
nested `steer_subagent` now use the same MESSAGE wrapper while prompt mentions,
focus mode and UI composers continue to steer with unwrapped user text.
Envelope-like opening and closing delimiters inside agent-authored bodies are
neutralized case-insensitively with U+200B before wrapping, so body text cannot
escape or forge an envelope; parsing round-trips that neutralized body. A real
user who literally types a complete envelope can still make the viewer render
it as an agent message; this accepted divergence is cosmetic.
Successful delivery emits the new cross-extension `subagents:message` event;
`tests/messaging.test.ts` pins identities, resolution, envelopes and delivery
classification without a live extension host.

Recipient resolution no longer depends on parent lookup, so a nested record that
outlives an evicted parent keeps its flat identity. Records without any identity
are skipped, and missing callers return ordinary tool errors.

The fork also exposes a pure compact event formatter (`✉ from → to [TYPE]`,
with `(queued)` when applicable) in `ui/notification-render.ts`. It is separate
from steer notifications so only `agent_message` traffic is eligible.
The main bound session now surfaces those events through a lightweight UI
notice.

Child tool registry gates now explicitly re-admit the always-on `agent_message`
custom tool in extension-enabled sessions as well as no-extension sessions.
The same centralized exclusion list now includes the root-only
`subagent_limits` tool, preventing standalone child sessions from inheriting
process-wide limit mutation when no lean-surface registry is present.

### Whole-tree agent UI

Upstream's FleetView and persistent agent widget filtered out every record with
`parentAgentId`, making nested workers invisible. The fork adds a shared pure
parent-first tree ordering helper, renders descendants with two-space depth
indentation and globally unique flat aliases, and keeps the existing FleetView row
selection/focus/view/stop paths for nested records. Active descendants retain
their ancestor rows, while orphan records remain visible at depth zero. The
`subagents` status-bar text now compares the scheduled top-level background
count with the configured concurrency cap, including `unlimited`, and adds the
whole-tree active count when it differs.

`tests/fleet-tree.test.ts` pins recursive grouping, launch ordering and orphan
visibility; the existing FleetView/focus tests continue to exercise the shared
row actions.

Named rows now retain both identity layers: nested rows render the alias first
with the agent role beside it, while top-level rows keep their type-name rendering
and add a dim `@alias`. Unnamed nested rows keep the existing `@handle` fallback.

### Role model and effort defaults

The fork parses `default_model:` and `default_thinking:` from agent frontmatter
into `AgentConfig.defaultModel` / `.defaultThinking` and resolves model and
effort as frontmatter pin, then caller parameter, then role default, then the
parent runtime. Upstream has no such tier: an omitted `model` fell straight
through to the parent session's model, so an orchestrator on one provider
produced children on that provider regardless of the role's declared
preference. An explicit caller value still wins, which preserves provider
fallback on overload. `tests/subagent-config.test.ts` pins the parsed fields and
the resolution order.

### No prompt-mode label on append-mode agents

The fork removes upstream's `twin` UI label from append-mode agents. Every
choco-pi role uses `prompt_mode: append`, so the label carried no distinguishing
information and conflicted with the `[btw]` marker reserved for side
conversations; thinking and background invocation tags are unchanged.

### Background-by-default spawn guidance

Upstream's `Agent` tool prose named the foreground the recommended mode ("use
foreground (default) when you need the agent's results before you can
proceed"), which contradicted this repository's `.pi/SYSTEM.md` delegation
policy: a foreground child holds the main conversation for its whole run, so
the user cannot steer the orchestrator while it works. The prose now states one
policy in all three places it appears — `fullAgentToolDescription`,
`compactAgentToolDescription`, and the `run_in_background` parameter
description in `src/index.ts` — plus `examples/agent-tool-description.md`,
which exists to reproduce the full description for `toolDescriptionMode:
"custom"` and would otherwise reintroduce the old advice for anyone who copied
it. Each says to pass `run_in_background: true` by default, that omitting the
parameter still runs foreground, and that a background result must be read back
with `get_subagent_result` rather than polled for. The full description's
bullets were reordered so the default-mode rule precedes the parallel-spawn
rule that depends on it.

**The behavioral default is deliberately unchanged.** `run_in_background` stays
`Type.Optional(Type.Boolean())` with no JSON Schema `default` keyword — no tool
schema in this package uses one — so the only real default is
`resolveAgentInvocationConfig`'s `agentConfig?.runInBackground ??
params.run_in_background ?? false` in `src/invocation-config.ts`, and that
fallback is shared with the nested delegation tool. Flipping it to `true` would
silently convert every nested `Agent` call that omits the flag from an inline
result to a bare agent ID, and a nested child produces no completion
notification at all (the manager's `onComplete` returns early on
`record.parentAgentId`, `src/index.ts`), so its parent would be left with an ID
it was never told to retrieve — through a parameter whose nested schema carries
no description. Guidance moves; the mechanism does not.

The `schedule` parameter description said it "Forces run_in_background", which
upstream's own 0.15.2 changelog records as wrong: an explicit
`run_in_background: false` alongside `schedule` is refused, not overridden. It
now says so.

### Anti-slop type hardening

The fork names settings, frontmatter, RPC, workflow, host-message and UI adapter
interfaces that upstream leaves anonymous or `unknown`. JSON/frontmatter and
cross-extension payloads are parsed at their boundaries; Pi compatibility
assertions carry local safety invariants. Live TUI adapter guards inspect only
the known members they consume instead of running enumerating object schemas
over host-owned instances. This is type-only hardening: tool schemas, event
names, persistence formats and valid runtime paths are unchanged.

### Lean tool surface for sub-agents

`installExtensionToolScope` in `src/agent-runner.ts` intersects the extension
tools it admits with the lean surface choco-pi's `tool-search` extension
publishes on `Symbol.for("choco-pi.tool-search.lean-surface")`, and remembers
what a turn earned through `tool_search` so the next re-narrow does not take it
back. Upstream admits every tool of every loaded extension: probe evidence put
child sessions at 78-83 tool schemas against the main agent's 22-28, all of it
carried in the cached prefix for the life of the task.

Tool names the agent's own configuration lists stay active regardless, so a
role with an explicit `tools:` set is unaffected. When the extension is absent
the symbol is unset and scope falls back to upstream behavior, so the package
still runs standalone.

### Main-transcript message rendering in the conversation viewer

Upstream's `ConversationViewer` draws messages as plain text: accent `[User]` /
bold `[Assistant]` / dim `[Result]` labels, unrendered markdown, and a one-line
`[Tool: name]` stub per call. The fork rebuilds every message through the exact
components the main Pi transcript uses — `UserMessageComponent`,
`AssistantMessageComponent`, `ToolExecutionComponent` (with the child session's
registered tool definition, so extension and MCP tools keep their own renderers)
and `BashExecutionComponent` — themed by the live `getMarkdownTheme()`. zentui
or any other extension that restyles those prototypes restyles the overlay the
same way, and tool results render inline under their call. Components are
created incrementally per message identity, tool results patch their pending
component (real result, or a synthesized error when the run died mid-call), and
the streaming tail re-renders every frame while a dead run's transcript stays
cached. `tests/conversation-viewer.test.ts` pins label-free rendering, consumed
markdown markers, inline tool results, bash blocks, streaming-tail updates,
first-open history hydration and invalidate idempotence;
`tests/side-conversation.test.ts` and `tests/focus-mode.test.ts` initialize the
theme because the transcript components read it.
theme because the transcript components read it. Streaming stays interactive
under pi-tui's ~60 fps paint cadence through three levers: the tail re-renders
at most every 100 ms (TAIL_RENDER_INTERVAL_MS) and reuses its lines between
budget ticks; the tail's markdown theme drops syntax highlighting while it
streams (the settle-time rebuild restores it); and the joined transcript lines
are cached and only rebuilt on session events, budget ticks or width changes.
Component render() of cached messages stays out of the steady-state frame path.
Agent-authored user-role messages are the exception to ordinary user rendering:
`parseAgentMessage` recognizes a complete envelope, and the viewer replaces its
raw XML-like markup with `✉ /sender/path [TYPE]` followed by the multiline body.
Real user messages still use `UserMessageComponent` unchanged.

### Zentui-aligned subagent completion notifications

The fork adds a pure completion-notification formatter that mirrors zentui's
settled tool rows: a status-aware background band, the dim bullet and bold
`Delegation` label, zentui's continuation and four-column result indentation, a
bounded `…/` transcript path, and a markdown-free prose preview instead of the
result's raw first line. One empty band row above and below the content matches
settled tool-cell spacing. Role badges and terminal status glyphs are kept because
they carry information a fixed tool label cannot. Grouped notifications share the
layout, and a theme without `getBgAnsi` degrades to unbanded text, so zentui
never has to be loaded.

### Focused prompt metadata

Focusing an agent publishes the child session's live model, provider and thinking
level on an optional `Symbol.for` slot, which editor chrome reads on every render
and which is cleared on unfocus, session switch and disposal. The prompt's
metadata therefore describes the runtime that will actually answer, and neither
package imports the other: without the publisher the editor renders the main
session unchanged, and without a consumer publishing is inert. Fast-mode status
is not part of the slot; it is owned by a separate root extension keyed to the
main session's model id.

## Upstream delta absorbed: 0.16.1 → 0.17.1

The repository previously ran `npm:@tintinweb/pi-subagents@0.16.1`. Two entries
in that delta change behavior rather than adding surface:

- **`name:` frontmatter is now the agent's `subagent_type`**, with the filename
  as fallback (0.17.0). No agent file under `.pi/agents/` declares `name:`, so
  every role keeps dispatching under its filename. A file whose `name:` differs
  from its filename would change identity; `display_name:` is the label-only
  field.
- **Subagent sessions persist to disk by default** (`rememberAgents`, 0.17.0).
  Transcripts that were in-memory are written to the session directory and
  appear nested under their spawner in `/resume`. Set `"rememberAgents": false`
  in `.pi/subagents.json` to restore the previous behavior, or
  `persist_session:` per agent.

Additive in the same range and relevant to later phases: `@handle` prompt
mentions with the off-screen clone start path (`src/mention.ts`,
`src/mention-clone.ts`, `src/ui/agent-mention.ts`), handle tombstones,
`Agent(name:)`, `@main`, and the `worktreeIsolation` project setting.

## Runtime dependencies

Vendored under `node_modules/`, copied from the pnpm store of the original
`choco-pi` checkout at the exact versions that resolved there. All three are
dependency-free, so the vendored tree is flat and complete:

| Package             | Version | Upstream range |
| ------------------- | ------- | -------------- |
| `@sinclair/typebox` | 0.34.52 | `^0.34.49`     |
| `croner`            | 10.0.1  | `^10.0.1`      |
| `nanoid`            | 5.1.16  | `^5.0.0`       |

`package.json` pins them exactly, so a future `npm install` here cannot drift
away from what is vendored. The `@earendil-works/*` packages stay peers: pi
substitutes its own bundled modules for those imports at extension load time.

## How this copy is used

`.pi/settings.json` must reference it as a local pi package
(`"./packages/choco-pi-subagents"`, resolved against the `.pi` directory),
replacing the `npm:@tintinweb/pi-subagents@0.16.1` entry. That edit is owned by
the integration step, not by this package.

## Updating

Re-run `npm pack @tintinweb/pi-subagents`, diff the new `src/` against this
tree, and re-apply the three mechanical transforms above (identity rename,
`.js` → `.ts` specifiers, parameter-property desugaring) plus whatever choco-pi
features have since been added on top. Record the new base version, shasum and
date here.
