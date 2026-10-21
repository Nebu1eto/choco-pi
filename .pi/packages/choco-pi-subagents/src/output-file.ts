/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 *
 * All I/O is asynchronous. Each file has one write queue: an entry's JSON is
 * captured synchronously when it is produced (so event hooks never wait), and
 * the queue writes entries in production order. Directory setup is the first
 * step of a file's queue; the private root is created and chmod-ed once per
 * process. A failed write is reported through `console.warn`, never dropped
 * silently.
 */

import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Project/global default for writing a subagent's `.output` transcript; a custom
 * agent's `output_transcript` overrides it per agent.
 *
 * State lives here rather than in an index.ts closure because both spawn paths
 * need it — the top-level Agent tool and the nested delegation tools. Same
 * reason `scopeModels` lives in model-scope.ts: a setting only one path can read
 * is a setting the other path silently ignores.
 */
let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean {
  return outputTranscriptDefault;
}
export function setOutputTranscriptDefault(b: boolean): void {
  outputTranscriptDefault = b;
}

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-") // both separators → dash
    .replace(/^[A-Za-z]:-/, "") // strip Windows drive prefix ("C:-")
    .replace(/^-+/, ""); // strip leading dashes (POSIX root, UNC)
}

function outputRoot(): string {
  return join(tmpdir(), `choco-pi-subagents-${process.getuid?.() ?? 0}`);
}

/** Root setup promise per root path; a failed setup is forgotten so the next file retries. */
const rootReady = new Map<string, Promise<void>>();
/** Directory of each output file whose directories must exist before its first write. */
const pendingDirs = new Map<string, { root: string; dir: string }>();
/** Tail of each file's write queue; removed once the queue drains. */
const writeQueues = new Map<string, Promise<void>>();

function ensureRoot(root: string): Promise<void> {
  const cached = rootReady.get(root);
  if (cached !== undefined) return cached;
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // chmod is a no-op on Windows and throws on some Windows filesystems.
    // On Unix we still want to enforce 0o700 past umask, so only swallow on Windows.
    try {
      await chmod(root, 0o700);
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  })();
  rootReady.set(root, ready);
  ready.catch(() => {
    if (rootReady.get(root) === ready) rootReady.delete(root);
  });
  return ready;
}

/**
 * Append one operation to `path`'s write queue. Operations run strictly in
 * enqueue order; the first one also creates the file's directories. A failure
 * is reported and does not stop later operations.
 */
function enqueueWrite(path: string, what: string, op: () => Promise<void>): void {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const pending = pendingDirs.get(path);
      if (pending !== undefined) {
        await ensureRoot(pending.root);
        await mkdir(pending.dir, { recursive: true });
        pendingDirs.delete(path);
      }
      await op();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[choco-pi-subagents] Could not write ${what} to transcript ${path}: ${reason}`);
    }
  });
  writeQueues.set(path, next);
  void next.then(() => {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  });
}

/** Resolves once every write queued so far for `path` has settled. */
export function flushOutputFile(path: string): Promise<void> {
  return writeQueues.get(path) ?? Promise.resolve();
}

/** Build the output file path; its directories are created by the file's first queued write.
 *  Mirrors Claude Code's layout: /tmp/{prefix}-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  const root = outputRoot();
  const dir = join(root, encoded, sessionId, "tasks");
  const path = join(dir, `${agentId}.output`);
  pendingDirs.set(path, { root, dir: dirname(path) });
  return path;
}

/**
 * Ensure a transcript file exists without disturbing what is already in it.
 *
 * A resume reuses the agent's existing transcript (same deterministic path), so
 * it must never call `writeInitialEntry` — that truncates, discarding turns the
 * completion notification still points the user at, and any history the session
 * has since compacted away is gone for good. Appending nothing creates the file
 * when this is the agent's first transcript and is a no-op when it is not.
 */
export function ensureOutputFile(path: string): void {
  enqueueWrite(path, "the transcript file", () => appendFile(path, "", "utf-8"));
}

/** Write the initial user prompt entry (queued; truncates the file when it runs). */
export function writeInitialEntry(
  path: string,
  agentId: string,
  prompt: string,
  cwd: string,
): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  const line = `${JSON.stringify(entry)}\n`;
  enqueueWrite(path, "the initial prompt entry", () => writeFile(path, line, "utf-8"));
}

function entryType(role: string): "assistant" | "user" | "toolResult" {
  if (role === "assistant") return "assistant";
  return role === "user" ? "user" : "toolResult";
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes. Flushing
 * serializes entries synchronously and queues their writes; await
 * {@link flushOutputFile} to observe them on disk.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
  // Index of the first message this stream is responsible for. A spawn writes
  // messages[0] as the initial prompt entry, so it starts at 1. A resume hands
  // in the session's length as of just before the run: the session already
  // holds every prior turn, and re-emitting those would duplicate history that
  // is already in the file.
  let writtenCount = startIndex ?? 1;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: entryType(msg.role),
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      const line = `${JSON.stringify(entry)}\n`;
      enqueueWrite(path, `message ${writtenCount}`, () => appendFile(path, line, "utf-8"));
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    // Compaction replaces session.messages with a shorter, summarized array,
    // leaving writtenCount past the new end — without re-anchoring, the flush
    // loop would never match again and streaming would halt for good (#145).
    // Flush before it runs so any not-yet-flushed tail still reaches the file,
    // then re-anchor to the rebuilt array once it lands. The re-anchor is
    // deferred a microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end —
    // anchoring synchronously would sit one past the trimmed array and skip
    // the first post-compaction message. Aborted/failed compactions leave
    // session.messages untouched, so only successful ones re-anchor.
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => {
        writtenCount = session.messages.length;
      });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}
