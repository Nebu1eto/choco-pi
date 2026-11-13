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
 * silently, but only once per path until a write to it succeeds again.
 *
 * The root lives under `os.tmpdir()`, which the OS may clear (macOS clears
 * `/var/folders/.../T` on reboot) while a resumed session still holds the old
 * path. A path under a known root therefore gets its directories recreated
 * before its first write in this process and again when a write fails with
 * ENOENT; that write is then retried once. Directories are never created for a
 * path outside a known root.
 */

import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
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

function defaultOutputRoot(): string {
  return join(tmpdir(), `choco-pi-subagents-${process.getuid?.() ?? 0}`);
}

/** Root setup promise per root path; a failed setup is forgotten so the next file retries. */
const rootReady = new Map<string, Promise<void>>();
/** Roots handed to {@link createOutputFilePath} in this process; the default root is always known. */
const knownRoots = new Set<string>();
/** Paths whose directories were ensured by an earlier write in this process. */
const preparedPaths = new Set<string>();
/** Paths whose last write failed and was already reported; cleared by a successful write. */
const failingPaths = new Set<string>();
/** Tail of each file's write queue; removed once the queue drains. */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Create the private root with mode 0o700. `refresh` repeats the setup even if
 * it already succeeded, for a root that may have been deleted since.
 */
function ensureRoot(root: string, refresh: boolean): Promise<void> {
  const cached = rootReady.get(root);
  if (cached !== undefined && !refresh) return cached;
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

/** The known root containing `path`, or undefined when no known root does. */
function rootOf(path: string): string | undefined {
  for (const root of [defaultOutputRoot(), ...knownRoots]) {
    if (path.startsWith(root + sep)) return root;
  }
  return undefined;
}

/**
 * Create `path`'s root and directories as {@link createOutputFilePath}'s first
 * write does. Returns undefined for a path outside every known root (nothing is
 * created), else whether any directory had to be created.
 */
async function prepareDirs(path: string, refreshRoot: boolean): Promise<boolean | undefined> {
  const root = rootOf(path);
  if (root === undefined) return undefined;
  await ensureRoot(root, refreshRoot);
  const created = await mkdir(dirname(path), { recursive: true });
  return created !== undefined;
}

/**
 * First line of a transcript whose directory had to be recreated under an
 * append: whatever the file held before is gone, and the file says so instead
 * of silently starting mid-conversation.
 */
function lostHistoryHeader(): string {
  const entry = {
    isSidechain: true,
    type: "system",
    subtype: "transcript_reset",
    content:
      "The transcript directory was missing (the temp directory may have been cleared, for example by a reboot); earlier messages in this transcript were lost.",
    timestamp: new Date().toISOString(),
  };
  return `${JSON.stringify(entry)}\n`;
}

/** `append` adds to the file; `replace` truncates it first (a fresh transcript). */
interface QueuedWrite {
  what: string;
  mode: "append" | "replace";
  data: string;
}

function performWrite(path: string, write: QueuedWrite, dirsRecreated: boolean): Promise<void> {
  if (write.mode === "replace") return writeFile(path, write.data, "utf-8");
  const data = dirsRecreated ? lostHistoryHeader() + write.data : write.data;
  return appendFile(path, data, "utf-8");
}

/**
 * Append one write to `path`'s write queue. Writes run strictly in enqueue
 * order; the first one in this process also creates the file's directories,
 * and an ENOENT failure recreates them and retries that write once. A failure
 * is reported once per path until a write succeeds again, and does not stop
 * later writes.
 */
function enqueueWrite(path: string, write: QueuedWrite): void {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      let dirsRecreated = false;
      if (!preparedPaths.has(path)) {
        // Refresh the root even if this process set it up before: it may have been
        // deleted since, and a recursive mkdir below would recreate it without 0o700.
        dirsRecreated = (await prepareDirs(path, true)) === true;
        preparedPaths.add(path);
      }
      try {
        await performWrite(path, write, dirsRecreated);
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!missing) throw error;
        const recreated = await prepareDirs(path, true);
        if (recreated === undefined) throw error;
        await performWrite(path, write, recreated);
      }
      failingPaths.delete(path);
    } catch (error) {
      if (failingPaths.has(path)) return;
      failingPaths.add(path);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[choco-pi-subagents] Could not write ${write.what} to transcript ${path}: ${reason}` +
          " (further failures for this transcript are not reported until a write succeeds)",
      );
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
 *  Mirrors Claude Code's layout: /tmp/{prefix}-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output
 *  `root` replaces that private root (tests); it becomes a known root for recovery. */
export function createOutputFilePath(
  cwd: string,
  agentId: string,
  sessionId: string,
  root: string = defaultOutputRoot(),
): string {
  const encoded = encodeCwd(cwd);
  knownRoots.add(root);
  const dir = join(root, encoded, sessionId, "tasks");
  return join(dir, `${agentId}.output`);
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
  enqueueWrite(path, { what: "the transcript file", mode: "append", data: "" });
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
  enqueueWrite(path, { what: "the initial prompt entry", mode: "replace", data: line });
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
      enqueueWrite(path, { what: `message ${writtenCount}`, mode: "append", data: line });
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
