/**
 * Server process liveness, connection disposal, process-tree kill, and client shutdown.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { withTimeout } from "../../deadline-utils.ts";
import { removeLspChild } from "../../instance-registry.ts";
import { logLatency } from "../../latency-logger.ts";
import { EXIT_NOTIFY_TIMEOUT_MS, SHUTDOWN_REQUEST_TIMEOUT_MS } from "./constants.ts";
import { extractSpawnMarker } from "./schemas.ts";
import { safeSendNotification, safeSendRequest } from "./transport.ts";
import type { LSPClientState, LSPShutdownOptions } from "./types.ts";

export function isClientAlive(state: LSPClientState): boolean {
  return state.isConnected && !state.isDestroyed && !state.lspProcess.process.killed;
}

export function disposeClientConnection(state: LSPClientState): void {
  if (state.connectionDisposed) return;
  state.connectionDisposed = true;
  try {
    state.connection.dispose();
  } catch {
    // ignore
  }
}

export async function killProcessTree(
  proc: {
    kill(signal?: NodeJS.Signals | number): boolean;
    unref?: () => void;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    once?: (event: "exit", listener: () => void) => void;
    off?: (event: "exit", listener: () => void) => void;
  },
  pid: number,
  options: LSPShutdownOptions = {},
): Promise<void> {
  // If our child has already exited, its PID is dead and the OS may have
  // RECYCLED it. The Windows `taskkill /F /T` below force-kills the PID's whole
  // tree, so on a recycled PID it would kill an unrelated process (in the test
  // suite this occasionally nuked a vitest worker fork → "Worker exited
  // unexpectedly" with no fatal dump). There is nothing left for us to kill, and
  // the handle-based proc.kill() below is moot, so return early.
  if ((proc.exitCode != null || proc.signalCode != null) && !options.processExiting) {
    proc.unref?.();
    return;
  }
  if (process.platform === "win32" && pid > 0) {
    // Host process is exiting (loop already closing): never spawn a child here —
    // the spawn's uv_async_send on the closing loop-wakeup handle hard-aborts
    // (src\win\async.c). Kill the direct child via the handle we already hold
    // (TerminateProcess; synchronous, no async handle).
    //
    // #472 CORRECTION of a prior false claim here ("orphaned grandchildren are
    // reaped by the OS as the host exits"): Windows does NOT kill children when
    // a parent dies. For shell/.cmd-wrapped servers the direct child is
    // cmd.exe, so this path only ever kills the wrapper — the actual server
    // (its grandchild) survives by design whenever it doesn't independently
    // exit. It relies entirely on best-effort backstops instead: (1) the
    // server observing stdin EOF once the wrapper's pipes close, (2) LSP
    // `initialize.processId: process.pid` (some servers self-watchdog on that
    // pid dying — typescript-language-server does, ast-grep's native binary
    // does not, an upstream spec violation), and (3) the #449/#472
    // cross-process instance registry's orphan reaper, which is the only
    // mechanism that works regardless of why a pipe write-end stayed open
    // (e.g. Windows handle-inheritance capture by a long-lived process). This
    // is why registering every LSP child at spawn matters uniformly — do NOT
    // weaken this direct-child-only kill to try to chase grandchildren here;
    // spawning taskkill in this branch is exactly the libuv hazard above.
    if (options.processExiting) {
      try {
        proc.kill();
      } catch {
        // best-effort
      }
      proc.unref?.();
      return;
    }
    try {
      // Absolute path avoids PATH-resolution: SystemRoot is set by Windows itself.
      const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        detached: !!options.fast,
      });
      if (options.fast) {
        killer.unref();
        proc.unref?.();
        return;
      }
      await new Promise<void>((resolve) => {
        killer.once("close", () => resolve());
        killer.once("error", (err) => {
          logLatency({
            type: "phase",
            phase: "lsp_kill_escalation",
            filePath: "",
            durationMs: 0,
            metadata: { pid, platform: "win32", taskkillError: String(err) },
          });
          resolve();
        });
      });
    } catch (err) {
      logLatency({
        type: "phase",
        phase: "lsp_kill_escalation",
        filePath: "",
        durationMs: 0,
        metadata: { pid, platform: "win32", taskkillSpawnError: String(err) },
      });
    }
    return;
  }

  const killPosixProcessGroup = (signal: NodeJS.Signals): boolean => {
    if (pid <= 0) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  const killDirectChild = (signal: NodeJS.Signals): void => {
    try {
      proc.kill(signal);
    } catch {
      // best-effort
    }
  };

  try {
    // #1114: gate the escalation on OBSERVED exit, not `proc.killed`. Node
    // only sets `proc.killed = true` when `proc.kill()` (the ChildProcess
    // method) successfully SENDS a signal — never when the process actually
    // dies, and the primary SIGTERM path above goes through the raw
    // `process.kill(-pid, …)` process-group call, which never touches
    // `proc.killed` at all. Checking `!proc.killed` here was therefore
    // either always-true (unconditional SIGKILL after the window,
    // regardless of whether the group already died — group-kill path) or
    // always-false/dead (direct-child fallback path, same shape as the
    // safe-spawn escalation bug). An `exit` listener set once, up front,
    // gives a real observed-death signal for both. Seeded from the same
    // `exitCode`/`signalCode` pre-check the top-of-function early return
    // uses (:689) — that early return is skipped when
    // `options.processExiting` is set, so a process that was ALREADY dead
    // on entry can still reach here; without seeding, `exited` would stay
    // false (the "exit" event already fired before this listener was
    // attached) and the fast/non-fast branches below would still fire a
    // redundant group SIGKILL at the escalation window.
    let exited = proc.exitCode != null || proc.signalCode != null;
    proc.once?.("exit", () => {
      exited = true;
    });
    if (!killPosixProcessGroup("SIGTERM")) {
      killDirectChild("SIGTERM");
    }
    if (options.fast) {
      const timer = setTimeout(() => {
        if (!exited) {
          logLatency({
            type: "phase",
            phase: "lsp_kill_escalation",
            filePath: "",
            durationMs: 1500,
            metadata: { pid, platform: "posix", method: "SIGKILL", fast: true },
          });
          if (!killPosixProcessGroup("SIGKILL")) {
            killDirectChild("SIGKILL");
          }
        }
      }, 1500);
      timer.unref?.();
      proc.unref?.();
      return;
    }
    // SIGTERM → exit-or-1.5s → SIGKILL escalation. SIGTERM alone can leave
    // zombie processes if the server hangs — but a server that dies promptly
    // must resolve on its exit event, not sleep the full escalation window
    // (that unconditional 1500ms was the whole cost of every graceful LSP
    // teardown, ×N clients per session and per test).
    const exitedInTime = await new Promise<boolean>((resolve) => {
      if (proc.exitCode != null || proc.signalCode != null) {
        resolve(true);
        return;
      }
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        proc.off?.("exit", onExit);
        resolve(false);
      }, 1500);
      proc.once?.("exit", onExit);
    });
    if (!exitedInTime && !exited) {
      logLatency({
        type: "phase",
        phase: "lsp_kill_escalation",
        filePath: "",
        durationMs: 1500,
        metadata: { pid, platform: "posix", method: "SIGKILL", fast: false },
      });
      if (!killPosixProcessGroup("SIGKILL")) {
        killDirectChild("SIGKILL");
      }
    }
  } catch {
    // ignore
  }
}

export async function clientShutdown(
  state: LSPClientState,
  options: LSPShutdownOptions = {},
): Promise<void> {
  const shutdownStart = Date.now();
  state.shutdownRequested = true;
  state.isConnected = false;
  state.isDestroyed = true;
  for (const timer of state.pendingDiagnostics.values()) {
    clearTimeout(timer);
  }
  state.pendingDiagnostics.clear();
  state.pendingOpens.clear();
  state.openDocuments.clear();
  state.openDocumentUris?.clear();
  // #1412 L1: mirror openDocuments' clear — a shut-down/evicted client's
  // probe memo is moot along with everything else document-scoped.
  state.projectIdentityProbedFiles?.clear();
  // #271: drop any pending watched-files batch + its timer (a dying client's
  // queued FS changes are moot, and the timer must not outlive the connection).
  state.watchQueue?.cancel();
  state.diagnosticEmitter.removeAllListeners();
  let shutdownRequestTimedOut = false;
  let exitNotifyTimedOut = false;
  // #1620: the graceful handshake is BEST-EFFORT and the teardown is not. A
  // teardown path must not depend on the health of the thing it is tearing
  // down — the breaker fires exactly when the server is unresponsive. Keep the
  // handshake inside the `try` and every irreversible teardown step in the
  // `finally`, so disposal, the record, the deregistration, and the kill run no
  // matter how the two writes behave, and so a future added await here cannot
  // reintroduce the class.
  try {
    if (!options.fast) {
      try {
        await withTimeout(
          safeSendRequest(state.connection, "shutdown", {}),
          SHUTDOWN_REQUEST_TIMEOUT_MS,
        );
      } catch {
        /* ignore — proceed to exit/kill so shutdown cannot hang the session */
        shutdownRequestTimedOut = true;
      }
      try {
        await withTimeout(
          safeSendNotification(state.connection, "exit", {}),
          EXIT_NOTIFY_TIMEOUT_MS,
        );
      } catch {
        /* ignore — same reason as the request above */
        exitNotifyTimedOut = true;
      }
    }
  } finally {
    disposeClientConnection(state);
    const pid = state.lspProcess.pid;
    logLatency({
      type: "phase",
      phase: "lsp_client_shutdown",
      filePath: state.root,
      durationMs: Date.now() - shutdownStart,
      metadata: {
        serverId: state.serverId,
        pid,
        fast: !!options.fast,
        processExiting: !!options.processExiting,
        shutdownRequestTimedOut,
        // #1620: `shutdownRequestTimedOut` covered only the request half, so
        // a hung exit notify was indistinguishable from a clean exit — and
        // pre-fix no record was emitted at all. Report both halves plus one
        // rolled-up verdict, so a forced teardown is countable from the log.
        exitNotifyTimedOut,
        shutdownOutcome: options.fast
          ? "fast"
          : shutdownRequestTimedOut || exitNotifyTimedOut
            ? "forced"
            : "graceful",
      },
    });
    // #449/#472: deregister this LSP child from the instance registry. Fire-
    // and-forget (async fs, no spawn) — must not add latency/risk to shutdown,
    // including the `processExiting` path where the event loop is closing
    // (#234 forbids spawning here, but a plain fs write/rename is fine; even
    // so, we don't await it to keep this teardown path as fast as before).
    // #1724: pass this spawn's marker so removeLspChild can guard against a
    // pid-recycling window (a NEW child claiming this exact pid before this
    // fire-and-forget write lands) rather than removing whichever child
    // currently sits at this pid.
    void removeLspChild(pid, extractSpawnMarker(state.lspProcess.args)).catch((err) => {
      logLatency({
        type: "phase",
        phase: "lsp_registry_write_failed",
        filePath: "",
        durationMs: 0,
        metadata: { op: "remove", pid, error: String(err) },
      });
    });
    // On Windows, killing the direct child first can orphan grandchildren before
    // taskkill can traverse the tree. Kill the full tree first and wait briefly.
    // Safe and idempotent on an already-exited child: killProcessTree returns
    // early on an observed exit rather than signalling a possibly-recycled pid.
    await killProcessTree(state.lspProcess.process, pid, options);
  }
}
