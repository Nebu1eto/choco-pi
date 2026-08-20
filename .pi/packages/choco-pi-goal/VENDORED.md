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

`src/`, `prompts/`, and `LICENSE` from the published tarball. Upstream
`README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/`, `scripts/`,
`platform-smoke.config.mjs`, and `.crabboxignore` are not vendored; they cover
the upstream release process, which does not apply to a local harness package.

## Behavior parity

Full parity with `0.2.0` is intended and preserved:

- `/goal` command (show, set, clear, resume, and completion flows).
- `get_goal`, `create_goal`, `update_goal` tools — **names are unchanged** on
  purpose, because harness documentation and prompts reference them.
- Continuation scheduler, recovery machinery (including provider-limit
  auto-resume and host-overflow recovery), goal accounting, and the
  stale-queued-work guard.

## choco-pi changes on top of `0.2.0`

1. `package.json`: renamed to `choco-pi-goal`, marked `private`, description
   updated, upstream release scripts and repository metadata dropped. Both Pi
   entry points are kept: `pi.extensions` → `./src/index.ts`,
   `pi.prompts` → `./prompts`.
2. `tsconfig.json`: added for package-local `tsc --noEmit`; upstream does not
   ship one in the tarball. Matches the harness root compiler options.
3. `src/commands.ts`: the user-visible `/goal` command description now reads
   "Show or manage the current choco-pi goal." (was "Codex-style goal").
4. `prompts/create-goal.md`: upstream `pi-codex`/`pi-codex-goal` wording
   renamed to "choco-pi goal", plus one added paragraph requiring the agent to
   draft the objective itself and call the goal creation tool in the same turn
   without asking for confirmation.

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

Re-run `npm pack pi-codex-goal@<version>`, diff `src/` and `prompts/` against
this copy, and re-apply the four changes listed above.
