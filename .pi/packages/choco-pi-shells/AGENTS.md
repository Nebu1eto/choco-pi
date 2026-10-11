# choco-pi-shells — working rules

First-party package. There is no upstream, so there is no `VENDORED.md`.

## Process-singleton ownership

- `globalThis[Symbol.for("choco-pi-shells:manager")]` holds one `ShellManager` per Node
  process. Root sessions, reloaded roots, and child (subagent) sessions all share it.
- Only a root activation tears it down, and only when its own manager still occupies the
  slot. It must do this on a `quit` shutdown, and it must clear the slot synchronously
  before the first `await` of `dispose()`.
- A child activation never disposes the manager and never clears the slot. On shutdown,
  for any reason including `quit`, it calls `cleanupOwner(childSessionId)` only. Subagents
  sends child sessions a synthetic `quit` `session_shutdown`, so the shutdown reason
  alone never identifies the root.
- Child identity is a one-way latch with two sources. One is the async child-context
  marker at load. The other is the `pi-subagents:manager` registry `isChildSessionId`
  probe, run on every session id the activation observes (`session_start`, tool and
  command calls, shutdown). Subagents unregisters the child id before emitting the
  child's shutdown, so the latch must already be set by `session_start`. Do not rely on
  the load-time marker alone; it can miss children whose extensions load outside that
  async context.
- Reload or session replacement must keep the manager running so the next root
  activation can adopt it. Do not add a "created the manager" flag that blocks an
  adopting root from disposing on quit.
- Snapshot session identity before any `await` in lifecycle handlers, and invalidate
  activation state synchronously.

## Lifecycle events

`README.md` documents the `shells:*` `pi.events` channels and the frozen flat payload.
Keep both field names and channel names stable; the host bridge matches them literally.

## Verification

```bash
cd .pi/packages/choco-pi-shells && npx tsc -p tsconfig.json
cd <repo-root> && node --test .pi/packages/choco-pi-shells/tests/*.test.ts
```

Tests that start long-running shells must dispose the manager in `finally` so no
process outlives the run.
