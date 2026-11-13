import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiAcpSession, type StopReason } from "../src/acp/session.ts";
import { PiRpcProcess, type PiPromptDisposition } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

// Pi's `agent_settled` carries no run identity (`{ type, aborted }` only), and a run that an
// extension starts with `sendCustomMessage(..., { triggerTurn: true })` emits one too. Pi
// answers a `started` prompt only after that prompt's run is active, and defers a prompt
// that arrives while an earlier run's `agent_settled` is being emitted. So on Pi's stdout an
// `agent_settled` that precedes a prompt's response frame belongs to an earlier run.

function bounded<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type TrackedTurn = {
  settlements: StopReason[];
  done: Promise<void>;
};

function track(promise: Promise<StopReason>): TrackedTurn {
  const settlements: StopReason[] = [];
  const done = promise.then((reason) => {
    settlements.push(reason);
  });
  return { settlements, done };
}

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function newSession(proc: FakePiRpcProcess, conn = new FakeAgentSideConnection()): PiAcpSession {
  return new PiAcpSession({
    sessionId: `turn-ownership-${randomUUID()}`,
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
  });
}

test("an earlier run's agent_settled before the prompt is acknowledged does not end the turn", async () => {
  const proc = new FakePiRpcProcess();
  proc.acknowledgeImmediately = false;
  const ack = deferred<PiPromptDisposition>();
  proc.promptResponder = () => ack.promise;
  const session = newSession(proc);

  const turn = track(session.prompt("user prompt"));
  assert.equal(proc.prompts.length, 1);

  // An autonomous run (subagent notification, goal continuation) settles before Pi answers.
  proc.emit({ type: "agent_settled" });
  await drain();
  assert.deepEqual(turn.settlements, [], "a settle from another run must not end this turn");

  ack.resolve("started");
  await drain();
  assert.deepEqual(turn.settlements, [], "the acknowledgement alone does not end a started turn");

  proc.emit({ type: "agent_settled" });
  await bounded(turn.done, "turn settles from its own run");
  assert.deepEqual(turn.settlements, ["end_turn"]);
});

test("after a handled command, a queued turn ignores the command's autonomous run settle", async () => {
  const proc = new FakePiRpcProcess();
  proc.acknowledgeImmediately = false;
  const secondAck = deferred<PiPromptDisposition>();
  proc.promptResponder = (message) =>
    message === "/command" ? Promise.resolve("handled") : secondAck.promise;
  const session = newSession(proc);

  const first = track(session.prompt("/command"));
  const second = track(session.prompt("next"));
  await bounded(first.done, "handled command settles");
  await drain();
  assert.deepEqual(
    proc.prompts.map((prompt) => prompt.message),
    ["/command", "next"],
  );

  // The command fired a triggerTurn message; that run settles before Pi answers "next".
  proc.emit({ type: "agent_settled" });
  await drain();
  assert.deepEqual(second.settlements, [], "the command's run must not end the queued turn");

  secondAck.resolve("started");
  await drain();
  proc.emit({ type: "agent_settled" });
  await bounded(second.done, "queued turn settles from its own run");
  assert.deepEqual(second.settlements, ["end_turn"]);
});

// The stub writes frames in the order Pi's stdout would carry them. For "interleaved" it
// writes an earlier run's `agent_settled` and the prompt response in one write, then the
// prompt's own run 150 ms later. For "same-chunk" it writes the response and the prompt's
// own settle in one write, which must still settle the turn.
const STUB_PI = `#!/usr/bin/env node
const readline = require("node:readline");
const line = (value) => JSON.stringify(value) + "\\n";
readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const request = JSON.parse(raw);
  const response = line({ type: "response", id: request.id, command: request.type, success: true, data: { disposition: "started" } });
  if (request.type !== "prompt") {
    process.stdout.write(line({ type: "response", id: request.id, command: request.type, success: true, data: {} }));
    return;
  }
  const own = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "own-run:" + request.message } }) + line({ type: "agent_end" }) + line({ type: "agent_settled" });
  if (request.message === "interleaved") {
    process.stdout.write(line({ type: "agent_end" }) + line({ type: "agent_settled" }) + response);
    setTimeout(() => process.stdout.write(own), 150);
  } else {
    process.stdout.write(response + own);
  }
});
`;

test("real Pi RPC frames: a turn settles only from the agent_settled after its response", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-acp-turn-ownership-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let proc: PiRpcProcess | undefined;

  try {
    const piCommand = join(root, "fake-pi");
    await writeFile(piCommand, STUB_PI, { mode: 0o755 });
    await chmod(piCommand, 0o755);
    proc = await bounded(PiRpcProcess.spawn({ cwd: root, piCommand }), "spawn stub Pi");
    const conn = new FakeAgentSideConnection();
    const session = new PiAcpSession({
      sessionId: `turn-ownership-real-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc,
      conn: asAgentConn(conn),
    });
    const ownText = (message: string): boolean =>
      conn.updates.some(
        (n) =>
          n.update.sessionUpdate === "agent_message_chunk" &&
          n.update.content.type === "text" &&
          n.update.content.text === `own-run:${message}`,
      );

    for (const message of ["interleaved", "same-chunk"]) {
      const reason = await bounded(session.prompt(message), `${message} turn settles`);
      assert.equal(reason, "end_turn");
      assert.ok(
        ownText(message),
        `${message}: the turn must not settle before its own run's events arrive`,
      );
    }
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
