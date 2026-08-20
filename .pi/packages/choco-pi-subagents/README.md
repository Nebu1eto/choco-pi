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
  `pi-subagents` wherever an extension *name* is written.

## What it provides

The `Agent` tool (foreground and `run_in_background`), `get_subagent_result`,
`steer_subagent`, `resume`, `@handle` prompt mentions, the `/agents` command
tree, the above-editor widget, FleetView, the live conversation overlay,
fullscreen subagent focus, `isolation: "worktree"`, cron/interval scheduling,
opt-in nested delegation, and cross-extension RPC.

In FleetView, Enter keeps the modal conversation viewer and `f` focuses the
selected subagent in Pi's main conversation area. The main prompt then steers
that agent; Esc restores the orchestrator conversation and prompt unchanged.
The modal also offers `f focus`.

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
