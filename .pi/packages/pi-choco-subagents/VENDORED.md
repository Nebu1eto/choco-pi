# Vendored: pi-choco-subagents

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

| Removed | Why |
| --- | --- |
| `dist/**` | The package is loaded from `src/`; a second copy of every module would drift silently. |
| `vitest.config.ts` | Upstream's `test/` directory is not part of the npm tarball, so the config points at nothing here. |
| `CONTRIBUTING.md`, `SECURITY.md` | Upstream project process; routes reports to the upstream repository. |
| Upstream `README.md` | Replaced by this fork's `README.md`, which documents the fork's name, wiring and load mechanism. Upstream's full feature manual stays available in its repository. |
| `package.json`: `repository`, `homepage`, `bugs`, `author`, `publishConfig`, `pi.video`, `pi.image` | Point at the upstream project; this fork is `private` and not published. |
| `package.json`: `devDependencies`, `scripts.build`/`test`/`test:watch`/`test:e2e`/`test:coverage`/`lint`/`lint:fix`/`prepublishOnly` | The fork has no build step, no vendored test suite and no Biome config. `scripts.typecheck` is kept. |

## What was changed

### Identity

- `package.json` `name`: `@tintinweb/pi-subagents` → `pi-choco-subagents`;
  `version` → `0.17.1-choco.0`; added `"private": true` and `"type": "module"`.
- Console warning prefix `[pi-subagents]` → `[pi-choco-subagents]` (7 sites).
- Transcript temp root `<tmpdir>/pi-subagents-<uid>/` →
  `<tmpdir>/pi-choco-subagents-<uid>/` in `src/output-file.ts`, so this fork's
  `.output` transcripts cannot collide with a concurrently installed upstream
  copy. Owner-only `0700` and the per-agent layout below it are unchanged.

**Deliberately NOT renamed** — these are a cross-extension interface other
packages resolve by literal string, so renaming them would disconnect consumers
without producing a compile error:

- `Symbol.for("pi-subagents:manager")`, the global manager registry slot
- every `subagents:*` event name (`subagents:ready`, `subagents:started`,
  `subagents:completed`, `subagents:failed`, `subagents:steered`,
  `subagents:settings_loaded`, `subagents:record`, the `subagents:rpc:*`
  channels)
- the `subagents` status-bar key and `.pi/subagents.json` settings filename

One consequence of the package rename **is** user-visible: an extension answers
to its package's unscoped short name (upstream #143), which is derived at
runtime from the owning `package.json`. Agent frontmatter that allowlisted
`extensions: [pi-subagents]` must now say `pi-choco-subagents`. No agent file in
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
extends FleetView and `ConversationViewer` with fullscreen focus. `f` on a
selected FleetView row (or in its modal viewer) replaces Pi's main transcript
rendering with that agent's live conversation and binds the existing main editor
to `AgentManager.steer`; Esc restores the exact orchestrator renderer and editor
input predecessor. The method registry uses an additive, instance-scoped wrapper
so pi-zentui and prompt-editor adapters remain composed. `tests/focus-mode.test.ts`
pins transcript swapping, streaming refresh, steering ownership and restoration.

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

| Package | Version | Upstream range |
| --- | --- | --- |
| `@sinclair/typebox` | 0.34.52 | `^0.34.49` |
| `croner` | 10.0.1 | `^10.0.1` |
| `nanoid` | 5.1.16 | `^5.0.0` |

`package.json` pins them exactly, so a future `npm install` here cannot drift
away from what is vendored. The `@earendil-works/*` packages stay peers: pi
substitutes its own bundled modules for those imports at extension load time.

## How this copy is used

`.pi/settings.json` must reference it as a local pi package
(`"./packages/pi-choco-subagents"`, resolved against the `.pi` directory),
replacing the `npm:@tintinweb/pi-subagents@0.16.1` entry. That edit is owned by
the integration step, not by this package.

## Updating

Re-run `npm pack @tintinweb/pi-subagents`, diff the new `src/` against this
tree, and re-apply the three mechanical transforms above (identity rename,
`.js` → `.ts` specifiers, parameter-property desugaring) plus whatever choco-pi
features have since been added on top. Record the new base version, shasum and
date here.
