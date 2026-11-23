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
  } catch {}
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
  if ((proc.exitCode != null || proc.signalCode != null) && !options.processExiting) {
    proc.unref?.();
    return;
  }
  if (process.platform === "win32" && pid > 0) {
    if (options.processExiting) {
      try {
        proc.kill();
      } catch {}
      proc.unref?.();
      return;
    }
    try {
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
    } catch {}
  };

  try {
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
  } catch {}
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
  state.projectIdentityProbedFiles?.clear();
  state.watchQueue?.cancel();
  state.diagnosticEmitter.removeAllListeners();
  let shutdownRequestTimedOut = false;
  let exitNotifyTimedOut = false;
  try {
    if (!options.fast) {
      try {
        await withTimeout(
          safeSendRequest(state.connection, "shutdown", {}),
          SHUTDOWN_REQUEST_TIMEOUT_MS,
        );
      } catch {
        shutdownRequestTimedOut = true;
      }
      try {
        await withTimeout(
          safeSendNotification(state.connection, "exit", {}),
          EXIT_NOTIFY_TIMEOUT_MS,
        );
      } catch {
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
        exitNotifyTimedOut,
        shutdownOutcome: options.fast
          ? "fast"
          : shutdownRequestTimedOut || exitNotifyTimedOut
            ? "forced"
            : "graceful",
      },
    });
    void removeLspChild(pid, extractSpawnMarker(state.lspProcess.args)).catch((err) => {
      logLatency({
        type: "phase",
        phase: "lsp_registry_write_failed",
        filePath: "",
        durationMs: 0,
        metadata: { op: "remove", pid, error: String(err) },
      });
    });
    await killProcessTree(state.lspProcess.process, pid, options);
  }
}
