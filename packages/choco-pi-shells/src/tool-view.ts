/**
 * Model-visible snake_case views of shell manager objects. The manager objects and the
 * frozen `shells:*` event payloads keep their camelCase names; only tool content and
 * notification text are built from these views.
 */
import type { ShellCompletionDetails } from "./index.ts";
import type {
  ListShellResult,
  ReadShellResult,
  ShellResult,
  ShellStreamReadResult,
} from "./shell-manager.ts";

export function viewShell(shell: ShellResult) {
  return {
    shell_id: shell.shellId,
    owner_id: shell.ownerId,
    ...(shell.name !== undefined && { name: shell.name }),
    command: shell.command,
    cwd: shell.cwd,
    state: shell.state,
    ...(shell.pid !== undefined && { pid: shell.pid }),
    ...(shell.exitCode !== undefined && { exit_code: shell.exitCode }),
    ...(shell.signal !== undefined && { signal: shell.signal }),
    ...(shell.error !== undefined && { error: shell.error }),
    started_at: shell.startedAt,
    ...(shell.endedAt !== undefined && { ended_at: shell.endedAt }),
  };
}

interface StreamView {
  start_offset: number;
  next_offset: number;
  end_offset: number;
  dropped: boolean;
}

function viewStreamOffsets(
  stream: ShellStreamReadResult | ShellCompletionDetails["shells"][number]["stdout"],
): StreamView {
  return {
    start_offset: stream.startOffset,
    next_offset: stream.nextOffset,
    end_offset: stream.endOffset,
    dropped: stream.dropped,
  };
}

export function viewRead(read: ReadShellResult) {
  return {
    shell: viewShell(read.shell),
    stdout: { data: read.stdout.data, ...viewStreamOffsets(read.stdout) },
    stderr: { data: read.stderr.data, ...viewStreamOffsets(read.stderr) },
  };
}

export function viewList(list: ListShellResult) {
  return { shells: list.shells.map((shell) => viewShell(shell)) };
}

export function viewCompletion(details: ShellCompletionDetails) {
  return {
    shells: details.shells.map((shell) => ({
      shell_id: shell.shellId,
      ...(shell.name !== undefined && { name: shell.name }),
      state: shell.state,
      ...(shell.exitCode !== undefined && { exit_code: shell.exitCode }),
      ...(shell.signal !== undefined && { signal: shell.signal }),
      ...(shell.error !== undefined && { error: shell.error }),
      stdout: { tail: shell.stdout.tail, ...viewStreamOffsets(shell.stdout) },
      stderr: { tail: shell.stderr.tail, ...viewStreamOffsets(shell.stderr) },
    })),
  };
}
