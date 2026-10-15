import type { ExecSessionSnapshot, UnifiedExecResult } from "./session-manager.ts";
import {
  consumeOutput,
  formatDroppedOutputNotice,
  generateChunkId,
  peekOutputSince,
  peekUnconsumedOutput,
  truncateOutput,
  type ExecOutputSessionState,
} from "./output.ts";

export interface ExecResultSessionState extends ExecOutputSessionState {
  id: number;
  command: string;
  exitCode: number | null | undefined;
  startedAt: number;
  updatedAt: number;
  terminating: boolean;
  /** Output chunks the bridge discarded unread; undefined for sessions that cannot know. */
  droppedChunks?: number | undefined;
  /** `droppedChunks` already reported in a result; the rest is reported once more. */
  droppedChunksReported?: number | undefined;
}

function fromSnapshot(
  session: ExecResultSessionState,
  waitMs: number,
  snapshot: { output: string; original_token_count?: number | undefined },
  consume = false,
): UnifiedExecResult {
  let output = snapshot.output;
  // The in-stream notice can fall outside the returned tail, so repeat the
  // not-yet-reported drops at the head of this result. Only a consuming
  // result marks them reported; peeks and progress snapshots repeat them.
  const dropped = session.droppedChunks ?? 0;
  const reported = session.droppedChunksReported ?? 0;
  if (dropped > reported) {
    output = formatDroppedOutputNotice(dropped - reported).trimStart() + output;
    if (consume) session.droppedChunksReported = dropped;
  }
  const result: UnifiedExecResult = {
    chunk_id: generateChunkId(),
    wall_time_seconds: waitMs / 1000,
    output,
  };
  if (snapshot.original_token_count !== undefined)
    result.original_token_count = snapshot.original_token_count;
  if (session.exitCode === undefined || session.exitCode === null) result.session_id = session.id;
  else result.exit_code = session.exitCode;
  return result;
}

export function makeExecResult<TSession extends ExecResultSessionState>(
  session: TSession,
  waitMs: number,
  maxOutputTokens: number | undefined,
  exposeSession: (session: TSession) => void,
  deleteSessionIfDrained: (sessionId: number) => void,
): UnifiedExecResult {
  const consumed = consumeOutput(session, maxOutputTokens);
  const result = fromSnapshot(session, waitMs, consumed, true);
  if (session.exitCode === undefined || session.exitCode === null) {
    exposeSession(session);
  } else if (session.emittedOffset === session.bufferStartOffset + session.buffer.length) {
    deleteSessionIfDrained(session.id);
  }
  return result;
}

export function snapshotSession(
  session: ExecResultSessionState,
  maxOutputChars = 8_000,
): ExecSessionSnapshot {
  return {
    id: session.id,
    command: session.command,
    running: session.exitCode === undefined || session.exitCode === null,
    exitCode: session.exitCode ?? undefined,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    outputTail: session.buffer.slice(-maxOutputChars),
    terminating: session.terminating,
  };
}

export function makeSnapshotResult(
  session: ExecResultSessionState,
  waitMs: number,
  maxOutputTokens?: number,
  unconsumedOnly = false,
): UnifiedExecResult {
  const snapshot = unconsumedOnly
    ? peekUnconsumedOutput(session, maxOutputTokens)
    : truncateOutput(session.buffer, maxOutputTokens);
  return fromSnapshot(session, waitMs, snapshot);
}

export function makeSnapshotSince(
  session: ExecResultSessionState,
  waitMs: number,
  baselineOffset: number,
  maxOutputTokens?: number,
): UnifiedExecResult {
  return fromSnapshot(session, waitMs, peekOutputSince(session, baselineOffset, maxOutputTokens));
}
