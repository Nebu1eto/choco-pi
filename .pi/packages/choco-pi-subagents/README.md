# choco-pi-subagents

Claude Code-style autonomous sub-agents for pi. This is choco-pi's in-tree fork
of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
`0.17.1`, loaded from TypeScript source as a local pi package.

- Provenance, the full list of what changed and why, and how to re-sync with
  upstream: [`VENDORED.md`](./VENDORED.md).
- Module map and the attachment points for the choco-pi phases built on top of
  this core: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- Upstream's feature manual (agent frontmatter reference, every setting, the
  `/agents` menu tour) lives in the upstream repository. This fork changes no
  feature behavior, so it still applies — substitute `choco-pi-subagents` for
  `pi-subagents` wherever an extension _name_ is written.

## What it provides

The `Agent` tool (foreground and `run_in_background`), `get_subagent_result`,
`steer_subagent`, `stop_subagent`, `resume`, `@handle` prompt mentions, the
`/agents` command tree, the above-editor widget, FleetView, the live conversation overlay,
fullscreen subagent focus, `isolation: "worktree"`, cron/interval scheduling,
opt-in nested delegation, and cross-extension RPC.

In FleetView, the selection is the focus: ↑/↓ onto a subagent row focuses it in
Pi's main conversation area, and moving back onto `main` restores the
orchestrator conversation and prompt unchanged. The switcher stays visible while
an agent is focused, so `main` and every other agent are always one arrow key
away; Esc only leaves list navigation and never unfocuses. Enter no longer opens
the modal viewer for an ordinary agent — the row is already focused in the main
area, so it would duplicate what is on screen — and simply ends navigation. A
`/btw` row is the exception: side conversations never take focus, so Enter opens
their dismissible overlay. The main prompt steers whichever agent is focused.

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
node_modules/         vendored runtime deps (@sinclair/typebox, croner, nanoid)
examples/             starting point for toolDescriptionMode: "custom"
tsconfig.json         package-local typecheck config
CHANGELOG.upstream.md upstream history, for provenance only
```

There is no build step and no `dist/`. Pi loads `src/index.ts` through jiti.

## Local checks

```bash
# typecheck against the @earendil-works 0.84.2 types in the repo root
cd .pi/packages/choco-pi-subagents && npx tsc --noEmit

# focused transcript/editor takeover regression
node --experimental-strip-types --test tests/focus-mode.test.ts

# the repository's regression test for the fixed role system
node --test tests/subagent-config.test.ts
```

Every source file is erasable-syntax-only and every relative import carries an
explicit `.ts` extension, so `node` can load any module directly without a
loader flag. Keep both properties: they are what the test above depends on.

## License

MIT, inherited from upstream. See [`LICENSE`](./LICENSE).
