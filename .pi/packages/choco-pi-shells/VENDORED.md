# Divergences

## 2026-07 — TypeBox to pi-schema migration (unit C11)

First-party package; this file records only the migration.

- Tool parameter schemas (`src/index.ts`) use `@earendil-works/pi-schema` builders (closed objects, same names, descriptions, min/max) wrapped by `hostParams` in `src/schema-bridge.ts`, the only file importing `typebox` (`Type.Unsafe`), because `registerTool` still requires a TypeBox schema.
- `src/notification-gate.ts`: persisted pending-entry validation uses a compiled pi-schema validator. Numbers keep finite bounds (TypeBox rejected NaN/Infinity); the entry stays open at the top level and closed for `data` and shells, as before.
- `src/child-session.ts`: the registry check is a plain predicate (object, not array/function, with a callable `isChildSessionId`).

## 2026-11-03 — scratch-path ownership, warn mode (P15)

`shell_start` starts the process with `PI_ROOT_SESSION_ID` and `PI_SCRATCH_DIR` (`PI_PREVIOUS_SCRATCH_DIR` after a fork or resume), layered over `process.env` through the new optional `StartShellInput.env`; inherited values win. It does not set `PI_SESSION_ID`. A resolved cwd under `/tmp` outside the session's scratch directory still starts the shell and adds `warnings: string[]` to the tool result (once per directory per session; absent otherwise). Limits (warn mode): only the host `write`, `edit`, `apply_patch` and `ast_grep_replace` destinations and the `shell_start` cwd are inspected. Command contents of `bash`/`exec_command`/`write_stdin`, browser outputs, imagegen, MCP tools and notebook filesystem operations are not; the warning is advisory and never blocks. Only paths under `/tmp` (or macOS `/private/tmp`) are judged; `os.tmpdir()` locations such as `/var/folders` are not. The one shared implementation is `.pi/extensions/lib/scratch-path.ts`, imported by relative path. Tests: `tests/index.test.ts` (last test).

## 2026-11-03 choco-pi patch: stop-control participant (P4b-3)

Root activations join the choco-pi stop-control v1 protocol through the package-local contract copy `src/stop-control.ts` (literal channel/registry strings, closed pi-schema validators, `readStopState`; absent or malformed registry reads as open epoch 0). `src/index.ts`: on `choco-pi:stop-control/v1/stop-shells` (matching root session id only) every running shell owned by each listed owner session is stopped with `manager.stop({ requesterId: <root>, isAdmin: true, shellId })` (root-owned shells included; no `cleanupOwner`/`dispose`, so output stays readable). The `acknowledged` report (`counts.shells`) is emitted synchronously; `settled` follows once every stop resolves, `failed` (with `detail`) on a rejection or a stop result carrying `error`. `shell_start` in a root activation returns `{ error: "shell_start refused: the user stopped this session's work (/stop). Ask the user to run /resume-work." }` while the epoch is closed. The stop epoch is recorded per started shell; a completion notification still steers but sets `triggerTurn` only when every completed shell's start epoch is still the open current epoch (shells started before this activation have no recorded epoch and fall back to "not closed"). Child activations are unchanged. Tests: `tests/stop-control.test.ts`.

## 2026-11-10 choco-pi patch: Pi SDK target 1.5.1

Pi SDK pins move from `1.5.0` to exactly `1.5.1`; version references in comments, tests, and docs follow.

## 2026-11-10 print-mode settle waits for background shells

Print and JSON mode exited before a background shell's completion
notification could continue the run (prefix-eval `background-shell`). The
root activation now handles `agent_before_settle` in those modes only and
waits while `ShellManager.hasRunning(ownerId)` or
`ShellNotificationGate.hasPending()` holds, returning once a completion is
sent, after two idle checks, on shutdown, session replacement, or a closed
stop latch, or after `CHOCO_PI_PRINT_BACKGROUND_WAIT_MS` (default 600000; 0
disables). `src/print-settle-wait.ts` is an identical copy of the
choco-pi-subagents helper. Tests: `tests/print-settle-wait.test.ts`, and the
print-mode case in `tests/index.test.ts`.

## 2026-11-11 choco-pi patch: Pi SDK range ~1.5.2

Pi SDK dependencies move from exactly `1.5.1` to the range `~1.5.2` (`>=1.5.2 <1.6.0`), so later 1.5 patch releases need no pin change while a new minor release still needs review; version references in comments, tests, and docs follow.

## 2026-11-12 choco-pi patch: snake_case tool I/O

Tool outputs are model-visible, so they now use snake_case. `shell_start`/`shell_read`/`shell_stop`/`shell_list` result text, the `<shell-completion>` notification JSON and the `/shells` command JSON map: `shellId`→`shell_id`, `ownerId`→`owner_id`, `startedAt`→`started_at`, `endedAt`→`ended_at`, `exitCode`→`exit_code`, stream `startOffset`/`nextOffset`/`endOffset`→`start_offset`/`next_offset`/`end_offset`. Inputs were already snake_case (`shell_id`, `stdout_offset`, `stderr_offset`, `max_bytes`); schemas stay closed, so camelCase inputs are rejected. The mapping lives in `src/tool-view.ts` and is applied only where tool content or notification text is built; `ShellManager` objects, `result.details`, and the frozen `shells:*` `pi.events` payloads keep camelCase. The notification hint now reads "pass stdout.next_offset as stdout_offset and stderr.next_offset as stderr_offset", the `stdout_offset`/`stderr_offset` descriptions name `next_offset`, and manager validation messages name `shell_id`, `stdout_offset`, `stderr_offset`, `max_bytes`. Tests: `tests/index.test.ts`, `tests/stop-control.test.ts`.
