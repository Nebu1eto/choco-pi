import type { ShellChangeEvent, ShellResult } from "./shell-manager.ts";

export const SHELL_LIFECYCLE_CHANNELS = {
  started: "shells:started",
  exited: "shells:exited",
  stopped: "shells:stopped",
  lost: "shells:lost",
} as const;

export type ShellLifecycleKind = keyof typeof SHELL_LIFECYCLE_CHANNELS;

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
  tailPath: string | null;
}

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
    exitCode: shell.pid === undefined ? null : (shell.exitCode ?? null),
    startedAt: shell.startedAt,
    finishedAt: shell.endedAt ?? null,
    toolCallId,
    tailPath: null,
  };
}
