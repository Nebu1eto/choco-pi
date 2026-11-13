import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  createOutputFilePath,
  ensureOutputFile,
  flushOutputFile,
  streamToOutputFile,
  writeInitialEntry,
} from "../src/output-file.ts";

interface FakeMessage {
  role: "user" | "assistant";
  content: string;
}

/** The two members streamToOutputFile reads: `messages` and `subscribe`. */
interface FakeSession {
  messages: FakeMessage[];
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  emitTurnEnd(): void;
}

function fakeSession(): FakeSession {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const turnEnd: AgentSessionEvent = {
    type: "turn_end",
    message: { role: "user", content: "", timestamp: 0 },
    toolResults: [],
  };
  return {
    messages: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitTurnEnd() {
      for (const listener of listeners) listener(turnEnd);
    },
  };
}

type RuntimeValue = {} | null | undefined;

function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: streamToOutputFile reads only `messages` and `subscribe`, which FakeSession implements.
  return value as Target;
}

function asAgentSession(session: FakeSession): AgentSession {
  return reinterpretHostValue<AgentSession>(session);
}

/**
 * A scratch directory owned by the test, created next to this file instead of
 * under os.tmpdir(), and removed afterwards. Transcripts use `<base>/root` as
 * their private root; `<base>/cwd` stands in for the project directory.
 */
async function testBase(t: TestContext): Promise<{ base: string; root: string; cwd: string }> {
  const base = await mkdtemp(join(import.meta.dirname, ".output-file-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root: join(base, "root"), cwd: join(base, "cwd") };
}

function transcriptPath(root: string, cwd: string): string {
  return createOutputFilePath(cwd, `agent-${randomUUID()}`, `session-${randomUUID()}`, root);
}

async function rawLines(path: string): Promise<{ subtype?: string }[]> {
  const text = await readFile(path, "utf-8");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function lines(path: string): Promise<{ content: string }[]> {
  const text = await readFile(path, "utf-8");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).message);
}

test("concurrent streams keep each transcript's entries in production order", async (t) => {
  const { root, cwd } = await testBase(t);
  const sessions = [fakeSession(), fakeSession(), fakeSession()];
  const paths = sessions.map(() => transcriptPath(root, cwd));
  const cleanups = sessions.map((session, index) => {
    writeInitialEntry(paths[index], `agent-${index}`, `prompt ${index}`, cwd);
    session.messages.push({ role: "user", content: `prompt ${index}` });
    return streamToOutputFile(asAgentSession(session), paths[index], `agent-${index}`, cwd);
  });

  // Interleave many turns across the three files without awaiting any write.
  for (let turn = 0; turn < 50; turn++) {
    sessions.forEach((session, index) => {
      session.messages.push({ role: "assistant", content: `${index}:${turn}` });
      session.emitTurnEnd();
    });
  }
  for (const cleanup of cleanups) cleanup();
  await Promise.all(paths.map((path) => flushOutputFile(path)));

  for (const [index, path] of paths.entries()) {
    const written = await lines(path);
    assert.deepEqual(
      written.map((message) => message.content),
      [`prompt ${index}`, ...Array.from({ length: 50 }, (_, turn) => `${index}:${turn}`)],
      `transcript ${index} keeps order and drops nothing`,
    );
  }
});

test("ensureOutputFile never truncates a transcript that already has entries", async (t) => {
  const { root, cwd } = await testBase(t);
  const path = transcriptPath(root, cwd);
  writeInitialEntry(path, "agent", "first", cwd);
  ensureOutputFile(path);
  await flushOutputFile(path);
  assert.deepEqual(
    (await lines(path)).map((message) => message.content),
    ["first"],
  );
});

test("a failed transcript write is reported, not dropped silently", async (t) => {
  const { base } = await testBase(t);
  const warn = t.mock.method(console, "warn", () => undefined);
  const missing = join(base, "outside-any-root", "nested", "agent.output");
  // Outside every transcript root, so nothing creates its directory.
  ensureOutputFile(missing);
  await flushOutputFile(missing);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /Could not write the transcript file/);
});

test("a deleted transcript directory is recreated and the write succeeds", async (t) => {
  const { root, cwd } = await testBase(t);
  const warn = t.mock.method(console, "warn", () => undefined);
  const session = fakeSession();
  const path = transcriptPath(root, cwd);
  writeInitialEntry(path, "agent", "first", cwd);
  session.messages.push({ role: "user", content: "first" });
  const cleanup = streamToOutputFile(asAgentSession(session), path, "agent", cwd);
  session.messages.push({ role: "assistant", content: "before" });
  session.emitTurnEnd();
  await flushOutputFile(path);

  // What a reboot does to os.tmpdir(): the whole private root disappears.
  await rm(root, { recursive: true, force: true });
  session.messages.push({ role: "assistant", content: "after" });
  session.emitTurnEnd();
  session.messages.push({ role: "assistant", content: "later" });
  session.emitTurnEnd();
  cleanup();
  await flushOutputFile(path);

  assert.equal(warn.mock.callCount(), 0);
  const written = await rawLines(path);
  assert.equal(written[0]?.subtype, "transcript_reset", "the file says earlier messages were lost");
  assert.deepEqual(
    (await lines(path)).slice(1).map((message) => message.content),
    ["after", "later"],
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700, "the root keeps its private mode");
  }
});

test("a transcript path restored from an earlier process gets its directory back", async (t) => {
  const { root, cwd } = await testBase(t);
  const warn = t.mock.method(console, "warn", () => undefined);
  // Registers `root` and sets it up once in this process; then the root disappears.
  // The path below was never built or written in this process, like a resumed
  // session's stored outputFile whose directory a reboot removed.
  const earlier = transcriptPath(root, cwd);
  ensureOutputFile(earlier);
  await flushOutputFile(earlier);
  await rm(root, { recursive: true, force: true });
  const restored = join(root, "project", "session-old", "tasks", "agent.output");
  ensureOutputFile(restored);
  await flushOutputFile(restored);

  assert.equal(warn.mock.callCount(), 0);
  const written = await rawLines(restored);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.subtype, "transcript_reset");
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700, "the recreated root stays private");
  }
});

test("a persistent write failure warns once per transcript until a write succeeds", async (t) => {
  const { root, cwd } = await testBase(t);
  const warn = t.mock.method(console, "warn", () => undefined);
  const path = transcriptPath(root, cwd);
  const other = transcriptPath(root, cwd);
  writeInitialEntry(path, "agent", "first", cwd);
  writeInitialEntry(other, "other", "first", cwd);
  await Promise.all([flushOutputFile(path), flushOutputFile(other)]);

  // A regular file where the root directory belongs: nothing can be recreated.
  await rm(root, { recursive: true, force: true });
  await writeFile(root, "not a directory", "utf-8");
  for (let index = 0; index < 3; index++) {
    ensureOutputFile(path);
    ensureOutputFile(other);
  }
  await Promise.all([flushOutputFile(path), flushOutputFile(other)]);
  assert.equal(warn.mock.callCount(), 2, "one warning per transcript path, not per write");
  const warned = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(warned.some((message) => message.includes(path)));
  assert.ok(warned.some((message) => message.includes(other)));

  // Once the blocker is gone the next write recovers; a new failure warns again.
  await rm(root, { force: true });
  ensureOutputFile(path);
  await flushOutputFile(path);
  assert.equal(warn.mock.callCount(), 2);
  await rm(root, { recursive: true, force: true });
  await writeFile(root, "not a directory", "utf-8");
  ensureOutputFile(path);
  ensureOutputFile(path);
  await flushOutputFile(path);
  assert.equal(warn.mock.callCount(), 3);
});
