# Divergences

## 2026-07 — TypeBox to pi-schema migration (unit C11)

First-party package; this file records only the migration.

- Tool parameter schemas (`src/index.ts`) use `@earendil-works/pi-schema` builders (closed objects, same names, descriptions, min/max) wrapped by `hostParams` in `src/schema-bridge.ts`, the only file importing `typebox` (`Type.Unsafe`), because `registerTool` still requires a TypeBox schema.
- `src/notification-gate.ts`: persisted pending-entry validation uses a compiled pi-schema validator. Numbers keep finite bounds (TypeBox rejected NaN/Infinity); the entry stays open at the top level and closed for `data` and shells, as before.
- `src/child-session.ts`: the registry check is a plain predicate (object, not array/function, with a callable `isChildSessionId`).

## 2026-11-03 — scratch-path ownership, warn mode (P15)

`shell_start` starts the process with `PI_ROOT_SESSION_ID` and `PI_SCRATCH_DIR` (`PI_PREVIOUS_SCRATCH_DIR` after a fork or resume), layered over `process.env` through the new optional `StartShellInput.env`; inherited values win. It does not set `PI_SESSION_ID`. A resolved cwd under `/tmp` outside the session's scratch directory still starts the shell and adds `warnings: string[]` to the tool result (once per directory per session; absent otherwise). Limits (warn mode): only the host `write`, `edit`, `apply_patch` and `ast_grep_replace` destinations and the `shell_start` cwd are inspected. Command contents of `bash`/`exec_command`/`write_stdin`, browser outputs, imagegen, MCP tools and notebook filesystem operations are not; the warning is advisory and never blocks. Only paths under `/tmp` (or macOS `/private/tmp`) are judged; `os.tmpdir()` locations such as `/var/folders` are not. The one shared implementation is `.pi/extensions/lib/scratch-path.ts`, imported by relative path. Tests: `tests/index.test.ts` (last test).
