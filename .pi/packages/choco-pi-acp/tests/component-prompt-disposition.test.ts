import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiAcpSession, type StopReason } from "../src/acp/session.ts";
import { PiRpcProcess, type PiPromptDisposition } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

// Each prompt message selects the exact `data` payload the stub returns, so the real
// `PiRpcProcess` decodes genuine Pi RPC response frames.
const STUB_PI = `#!/usr/bin/env node
const readline = require("node:readline");
const payloads = {
  started: { disposition: "started" },
  queued: { disposition: "queued" },
  handled: { disposition: "handled" },
  missing: {},
  unknown: { disposition: "accepted" },
  nonString: { disposition: 1 },
  nullData: null,
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const response = { type: "response", id: request.id, command: request.type, success: true };
  if (request.type === "prompt" && request.message !== "absent") response.data = payloads[request.message];
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`;

function bounded<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A turn observed without awaiting it, so tests can assert it is still pending. */
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

/** Let acknowledgement callbacks, emit flushes, and settlement microtasks drain. */
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

function newSession(proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: `disposition-${randomUUID()}`,
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(new FakeAgentSideConnection()),
  });
}

test("PiRpcProcess.prompt decodes each Pi 1.0.4 disposition and rejects malformed payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-acp-disposition-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let proc: PiRpcProcess | undefined;

  try {
    const piCommand = join(root, "fake-pi");
    await writeFile(piCommand, STUB_PI, { mode: 0o755 });
    await chmod(piCommand, 0o755);
    proc = await bounded(PiRpcProcess.spawn({ cwd: root, piCommand }), "spawn stub Pi");

    const expected: PiPromptDisposition[] = ["started", "queued", "handled"];
    for (const disposition of expected) {
      assert.equal(await bounded(proc.prompt(disposition), disposition), disposition);
    }

    for (const malformed of ["missing", "unknown", "nonString", "nullData", "absent"]) {
      await assert.rejects(
        bounded(proc.prompt(malformed), malformed),
        /missing a valid data\.disposition/,
        `${malformed} must be a protocol error, not a defaulted disposition`,
      );
    }

    // A rejected acknowledgement leaves the transport usable for later commands.
    assert.equal(await bounded(proc.prompt("started"), "after malformed"), "started");
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("a handled prompt ends the ACP turn without events and starts the next queued turn", async () => {
  const proc = new FakePiRpcProcess();
  proc.promptResponder = async (message) => (message === "consumed" ? "handled" : "started");
  const session = newSession(proc);

  const first = track(session.prompt("consumed"));
  const second = track(session.prompt("normal"));
  await bounded(first.done, "handled turn settles");
  assert.deepEqual(first.settlements, ["end_turn"]);

  await drain();
  assert.deepEqual(
    proc.prompts.map((prompt) => prompt.message),
    ["consumed", "normal"],
  );
  assert.deepEqual(second.settlements, [], "a started turn waits for agent_settled");

  proc.emit({ type: "agent_settled" });
  await bounded(second.done, "started turn settles from events");
  assert.deepEqual(second.settlements, ["end_turn"]);
});

test("started and queued acknowledgements keep the ACP turn open until agent_settled", async () => {
  for (const disposition of ["started", "queued"] as const) {
    const proc = new FakePiRpcProcess();
    proc.promptResponder = async () => disposition;
    const session = newSession(proc);

    const turn = track(session.prompt(disposition));
    await drain();
    assert.deepEqual(turn.settlements, [], `${disposition} must not settle on acknowledgement`);

    proc.emit({ type: "agent_end" });
    await drain();
    assert.deepEqual(turn.settlements, [], `${disposition} waits past agent_end`);

    proc.emit({ type: "agent_settled" });
    await bounded(turn.done, `${disposition} settles`);
    assert.deepEqual(turn.settlements, ["end_turn"]);
  }
});

test("a late handled acknowledgement cannot settle the turn that events already advanced to", async () => {
  const proc = new FakePiRpcProcess();
  const firstAck = deferred<PiPromptDisposition>();
  const secondAck = deferred<PiPromptDisposition>();
  const acks = [firstAck.promise, secondAck.promise];
  proc.promptResponder = () => acks.shift() ?? Promise.resolve("started");
  const session = newSession(proc);

  const first = track(session.prompt("first"));
  const second = track(session.prompt("second"));

  // Events settle the first turn before its acknowledgement arrives, which starts the second.
  proc.emit({ type: "agent_settled" });
  await bounded(first.done, "first turn settles from events");
  await drain();
  assert.equal(proc.prompts.length, 2);

  firstAck.resolve("handled");
  await drain();
  assert.deepEqual(first.settlements, ["end_turn"], "first turn settles exactly once");
  assert.deepEqual(second.settlements, [], "stale acknowledgement must not settle the next turn");

  secondAck.resolve("started");
  await drain();
  assert.deepEqual(second.settlements, []);

  proc.emit({ type: "agent_settled" });
  await bounded(second.done, "second turn settles from its own events");
  assert.deepEqual(second.settlements, ["end_turn"]);
});

test("a late handled acknowledgement while the turn is already settling does not double-settle", async () => {
  const proc = new FakePiRpcProcess();
  const ack = deferred<PiPromptDisposition>();
  proc.promptResponder = () => ack.promise;
  const session = newSession(proc);

  const turn = track(session.prompt("only"));
  proc.emit({ type: "agent_settled" });
  ack.resolve("handled");
  await bounded(turn.done, "turn settles");
  await drain();
  assert.deepEqual(turn.settlements, ["end_turn"]);
});

test("a late acknowledgement failure cannot error the turn that events already advanced to", async () => {
  const proc = new FakePiRpcProcess();
  let rejectFirst!: (error: Error) => void;
  const firstAck = new Promise<PiPromptDisposition>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const acks = [firstAck];
  proc.promptResponder = () => acks.shift() ?? Promise.resolve("started");
  const session = newSession(proc);

  const first = track(session.prompt("first"));
  const second = track(session.prompt("second"));
  const third = track(session.prompt("third"));
  proc.emit({ type: "agent_settled" });
  await bounded(first.done, "first turn settles");
  await drain();

  rejectFirst(new Error("pi prompt failed: response is missing a valid data.disposition"));
  await drain();
  assert.deepEqual(second.settlements, [], "stale failure must not settle the running turn");
  assert.deepEqual(third.settlements, [], "stale failure must not settle queued turns");

  proc.emit({ type: "agent_settled" });
  await bounded(second.done, "second turn settles");
  proc.emit({ type: "agent_settled" });
  await bounded(third.done, "third turn settles");
  assert.deepEqual([second.settlements, third.settlements], [["end_turn"], ["end_turn"]]);
});
