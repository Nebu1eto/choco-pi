import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean {
  return outputTranscriptDefault;
}
export function setOutputTranscriptDefault(b: boolean): void {
  outputTranscriptDefault = b;
}

export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/^-+/, "");
}

function defaultOutputRoot(): string {
  return join(tmpdir(), `choco-pi-subagents-${process.getuid?.() ?? 0}`);
}

const rootReady = new Map<string, Promise<void>>();
const knownRoots = new Set<string>();
const preparedPaths = new Set<string>();
const failingPaths = new Set<string>();
const writeQueues = new Map<string, Promise<void>>();

function ensureRoot(root: string, refresh: boolean): Promise<void> {
  const cached = rootReady.get(root);
  if (cached !== undefined && !refresh) return cached;
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
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

function rootOf(path: string): string | undefined {
  for (const root of [defaultOutputRoot(), ...knownRoots]) {
    if (path.startsWith(root + sep)) return root;
  }
  return undefined;
}

async function prepareDirs(path: string, refreshRoot: boolean): Promise<boolean | undefined> {
  const root = rootOf(path);
  if (root === undefined) return undefined;
  await ensureRoot(root, refreshRoot);
  const created = await mkdir(dirname(path), { recursive: true });
  return created !== undefined;
}

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

function enqueueWrite(path: string, write: QueuedWrite): void {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      let dirsRecreated = false;
      if (!preparedPaths.has(path)) {
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

export function flushOutputFile(path: string): Promise<void> {
  return writeQueues.get(path) ?? Promise.resolve();
}

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

export function ensureOutputFile(path: string): void {
  enqueueWrite(path, { what: "the transcript file", mode: "append", data: "" });
}

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

export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
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
