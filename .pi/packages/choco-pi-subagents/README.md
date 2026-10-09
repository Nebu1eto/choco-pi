# choco-pi-subagents

Claude Code-style autonomous sub-agents for pi. This is choco-pi's in-tree fork
of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
`0.17.1`, loaded from TypeScript source as a local pi package.

- Provenance, the full list of what changed and why, and how to re-sync with
  upstream: [`VENDORED.md`](./VENDORED.md).
- Module map and the attachment points for the choco-pi phases built on top of
  this core: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- Upstream's feature manual (agent frontmatter reference, settings, the
  `/agents` menu tour) lives in the upstream repository and describes the
  shared base only. This fork adds and changes behavior (workflows, usage-limit
  handling, run budgets, focus mode, and more); `VENDORED.md` is authoritative
  where they differ.

## What it provides

The `Agent` tool (foreground, `run_in_background`, and `resume`),
`get_subagent_result`, `steer_subagent`, `stop_subagent`, `agent_message`,
`subagent_limits`, `set_subagent_fast_mode`, `set_subagent_daybreak`, the
`workflow_run`, `workflow_update`, `get_workflow_result`, and `workflow_cancel`
workflow tools, `@handle` prompt mentions, the `/agents` command tree, the
unified above-editor fleet panel, the live conversation overlay, fullscreen
subagent focus, `isolation: "worktree"`, cron/interval scheduling, opt-in nested
delegation, and cross-extension RPC.

Run limits: `max_turns` applies to fresh and resumed runs, and a run with a token
budget is steered to conclude before the hard stop. An agent that tries to finish
while agents it owns are still running, queued, or waiting for a usage-limit reset
gets one corrective steer; a second attempt fails with a `pendingDependents`
snapshot. Nested delegations render with the same result cards as root ones.

Durable revival: subagents survive `/reload`, quit and restart, a crash, and a
session switch. Every state change is saved as a hidden `subagent-journal` entry
in the main session file. At shutdown, running, queued and usage-limit-parked
agents are saved as interrupted and stopped. When the session starts again
(startup, `/reload`, or `/resume` back to it) they continue in the background
under the same id from their saved conversation, after a notice that the last
tool call may have partly run; a parked agent's wait is re-armed. After an
unexpected exit (crash, `kill -9`, closed terminal) an agent is revived at most
twice in a row, then saved as an error that must be resumed by hand. Explicitly
stopped agents, workflow steps and `/btw` answers never revive, and a fork or
clone never revives the original session's agents. Agents that have left memory
stay reachable: `Agent` with `resume` (optionally with `model`),
`get_subagent_result`, `stop_subagent` and `@handle` work on them. Print and
JSON modes and unsaved sessions keep the old stop-at-shutdown behavior. Nested
sessions are now saved to disk like top-level ones, so they appear in `/resume`;
an agent with `persist_session: false` cannot be revived.

In the fleet panel, the selection is the focus: ↑/↓ onto a subagent row focuses it in
Pi's main conversation area, and moving back onto `main` restores the
orchestrator conversation and prompt unchanged. The switcher stays visible while
an agent is focused, so `main` and every other agent are always one arrow key
away; Esc only leaves list navigation and never unfocuses. Enter does not open
the modal viewer for an ordinary agent — the row is already focused in the main
area, so it would duplicate what is on screen — and simply ends navigation. A
`/btw` row is the exception: side conversations never take focus, so Enter opens
their dismissible overlay. The main prompt steers whichever agent is focused.
The focused view streams the child's text and tool progress, renders its custom
messages, and has its own thinking toggle, seeded from the host setting each
time focus opens.

## Wiring

`.pi/settings.json`:

```json
{
  "packages": ["./packages/choco-pi-subagents"]
}
```

The path is resolved against the `.pi` directory. This entry replaces
`npm:@tintinweb/pi-subagents@<version>`; running both at once is not supported —
they claim the same manager registry slot and register the same tool names.

Project configuration is unchanged and still lives in `.pi/subagents.json` and
`.pi/agents/*.md`.

## Layout

```
src/                  TypeScript source; src/index.ts is the extension entry
node_modules/         vendored runtime deps (croner, nanoid); typebox is host-provided
tsconfig.json         package-local typecheck config
CHANGELOG.upstream.md upstream history, for provenance only
```

There is no build step and no `dist/`. Pi loads `src/index.ts` through jiti.

## Local checks

```bash
# typecheck against the @earendil-works 1.0.4 types in the repo root
cd .pi/packages/choco-pi-subagents && npx tsc --noEmit

# focused transcript/editor takeover regression
node --experimental-strip-types --test tests/focus-mode.test.ts

# the repository's regression test for the fixed role system
node --test tests/subagent-config.test.ts

# opt-in real Pi 1.0.4 check of durable revival (scripted faux model, no credit spent)
node tests/e2e-revival/run.ts --scenario S1,S2,S3,S4,S5
```

Every source file is erasable-syntax-only and every relative import carries an
explicit `.ts` extension, so `node` can load any module directly without a
loader flag. Keep both properties: they are what the test above depends on.

## License

MIT, inherited from upstream. See [`LICENSE`](./LICENSE).
