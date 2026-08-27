# Vendored: choco-pi-goal (fork of pi-codex-goal)

This directory is a **vendored, renamed copy** of the upstream open-source
package **pi-codex-goal**. This is not the original source repository.

- Original source code: https://github.com/fitchmultz/pi-codex-goal
- Package on npm: https://www.npmjs.com/package/pi-codex-goal
- Base version: `pi-codex-goal@0.2.0`
- Tarball shasum: `c37c5d0b9e27a28ad74f1232a04e391e474f782a`
- Tarball integrity: `sha512-NCL7WJ1wLwMyiTlKlc9sTTTZdTQzSS2HJcuth3PYD8YWDjt9eVpNQdAGVW/sz7UjvCCpzlD9dAg7yRIt9H3t7g==`
- Vendored on: 2026-08-20
- License: MIT (see `LICENSE`)
- Runtime dependencies: none. `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `typebox` are optional peers supplied
  by the Pi host.

## Why the fork

choco-pi removes its dependency on externally published `pi-codex-*` packages
and keeps the persistent goal mode under harness control. The fork exists to
own the package identity and the user-facing wording, not to change behavior.

## What was copied

`src/`, `prompts/`, and `LICENSE` from the published tarball; `prompts/` was
later folded into `src/prompts.ts` (change 4 below). Upstream
`README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/`, `scripts/`,
`platform-smoke.config.mjs`, and `.crabboxignore` are not vendored; they cover
the upstream release process, which does not apply to a local harness package.

## Behavior parity

Full parity with `0.2.0` is intended and preserved:

- `/goal` command (show, clear, pause, resume, copy, and completion flows).
- `get_goal`, `create_goal`, `update_goal` tools — **names are unchanged** on
  purpose, because harness documentation and prompts reference them.
- Continuation scheduler, recovery machinery (including provider-limit
  auto-resume and host-overflow recovery), goal accounting, and the
  stale-queued-work guard.

Setting a goal and guarding asynchronous command completion across session
replacement are deliberate divergences; see changes 4 and 5 below.

## choco-pi changes on top of `0.2.0`

1. `package.json`: renamed to `choco-pi-goal`, marked `private`, description
   updated, upstream release scripts and repository metadata dropped. Only the
   `pi.extensions` → `./src/index.ts` entry point is kept; `pi.prompts` is
   dropped with the prompt directory (change 4).
2. `tsconfig.json`: added for package-local `tsc --noEmit`; upstream does not
   ship one in the tarball. Matches the harness root compiler options.
3. `src/commands.ts`: the user-visible `/goal` command description now reads
   "Show or manage the current choco-pi goal; /goal <objective> drafts and
   creates one." (was "Codex-style goal").
4. `prompts/create-goal.md` is removed, and with it the `/create-goal` command.
   Its text lives in `src/prompts.ts` as `goalObjectivePrompt`, which
   `/goal <objective>` now sends: the agent drafts the completion contract and
   calls `create_goal` itself, where upstream stored the typed words verbatim
   after a "Replace goal?" confirmation. A prompt template named `goal` could
   not replace the rename, because Pi dispatches an extension command before it
   expands a template of the same name. The prompt keeps the choco-pi wording
   and the added paragraph requiring the agent to draft the objective and call
   the tool in the same turn without asking for confirmation.
5. `src/commands.ts` owns an activation/session generation for the `/goal`
   command. A clipboard copy that finishes after `session_shutdown` or a newer
   `session_start` returns without reading the obsolete command context; copy
   success and failure notifications are unchanged in the current session.

Deliberately **not** renamed, because they are internal identifiers rather than
user-visible branding, and changing them would break behavior parity:

- `CUSTOM_ENTRY_TYPE = "pi-codex-goal"` (`src/types.ts`) — the session custom
  entry type used to persist goal state. Renaming it would make goals recorded
  by earlier sessions unreadable.
- `OVERFLOW_CHECK_API` / `OVERFLOW_CHECK_PROVIDER` (`src/recovery-adapters.ts`)
  — synthetic identifiers on an internal assistant message used only for
  context-overflow detection.
- Model-facing tool descriptions in `src/tools.ts` still say "Codex-style
  goal". These are part of the prompt the model reads; rewording them is a
  behavior change, not a branding fix.

## Verification of this copy

- `npx tsc --noEmit` in this directory against `@earendil-works/*@0.84.2` — clean.
- Standalone import smoke of `src/index.ts` with a stubbed `ExtensionAPI`:
  registers `get_goal`, `create_goal`, `update_goal`, the `goal` command, and
  14 session event handlers.

## How this copy is used

`.pi/settings.json` references it as a local Pi package
(`./packages/choco-pi-goal`, resolved against this `.pi` directory), replacing
the former `npm:pi-codex-goal@0.2.0` entry.

## Updating

Re-run `npm pack pi-codex-goal@<version>` and diff `src/` against this copy;
upstream `prompts/create-goal.md` diffs against `goalObjectivePrompt` in
`src/prompts.ts`. Re-apply the five changes listed above.
