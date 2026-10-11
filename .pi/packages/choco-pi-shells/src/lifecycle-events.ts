import type { ShellChangeEvent, ShellResult } from "./shell-manager.ts";

/** Cross-extension channel names; matched by literal string, so never rename them. */
export const SHELL_LIFECYCLE_CHANNELS = {
  started: "shells:started",
  exited: "shells:exited",
  stopped: "shells:stopped",
  lost: "shells:lost",
} as const;

export type ShellLifecycleKind = keyof typeof SHELL_LIFECYCLE_CHANNELS;

/** Flat payload frozen by the host-bridge schema (docs/waku-integration.md §6.4 shell fields). */
export interface ShellLifecyclePayload {
  id: string;
  name: string | null;
  command: string;
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  toolCallId: string | null;
  /** Always null: shell output lives in an in-memory ring buffer, not a file. */
  tailPath: string | null;
}

/**
 * Map a manager change to a lifecycle event. A manager `failed` state (spawn or
 * signalling error) is reported as `exited` with whatever exit code exists; a
 * null or non-zero exit code means failure.
 */
export function lifecycleKindForChange(event: ShellChangeEvent): ShellLifecycleKind | undefined {
  if (event.type === "start") return "started";
  if (event.type !== "end") return undefined;
  if (event.shell.state === "stopped") return "stopped";
  if (event.shell.state === "exited" || event.shell.state === "failed") return "exited";
  return undefined;
}

export function shellLifecyclePayload(
  shell: ShellResult,
  toolCallId: string | null,
): ShellLifecyclePayload {
  return {
    id: shell.shellId,
    name: shell.name ?? null,
    command: shell.command,
    cwd: shell.cwd,
    pid: shell.pid ?? null,
    // A shell that never spawned has no process exit code; Node reports a negative errno.
    exitCode: shell.pid === undefined ? null : (shell.exitCode ?? null),
    startedAt: shell.startedAt,
    finishedAt: shell.endedAt ?? null,
    toolCallId,
    tailPath: null,
  };
}
