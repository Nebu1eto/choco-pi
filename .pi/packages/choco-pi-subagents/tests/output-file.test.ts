import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function transcriptPath(t: TestContext, cwd: string): string {
  const path = createOutputFilePath(cwd, `agent-${randomUUID()}`, `session-${randomUUID()}`);
  t.after(() => rm(dirname(dirname(path)), { recursive: true, force: true }));
  return path;
}

async function lines(path: string): Promise<{ content: string }[]> {
  const text = await readFile(path, "utf-8");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).message);
}

test("concurrent streams keep each transcript's entries in production order", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "output-file-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const sessions = [fakeSession(), fakeSession(), fakeSession()];
  const paths = sessions.map(() => transcriptPath(t, cwd));
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
  const cwd = await mkdtemp(join(tmpdir(), "output-file-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = transcriptPath(t, cwd);
  writeInitialEntry(path, "agent", "first", cwd);
  ensureOutputFile(path);
  await flushOutputFile(path);
  assert.deepEqual(
    (await lines(path)).map((message) => message.content),
    ["first"],
  );
});

test("a failed transcript write is reported, not dropped silently", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const missing = join(tmpdir(), `output-file-missing-${randomUUID()}`, "nested", "agent.output");
  // Not created through createOutputFilePath, so nothing creates its directory.
  ensureOutputFile(missing);
  await flushOutputFile(missing);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /Could not write the transcript file/);
});
