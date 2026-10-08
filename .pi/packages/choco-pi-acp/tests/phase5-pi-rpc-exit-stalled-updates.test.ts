import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { PiAcpSession } from "../src/acp/session.ts";
import type { PiRpcExit } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, FakePiRpcProcess } from "./helpers-fakes.ts";

class ExitingPiProcess extends FakePiRpcProcess {
  private exitHandler: ((exit: PiRpcExit) => void) | undefined;

  onExit(handler: (exit: PiRpcExit) => void): () => void {
    this.exitHandler = handler;
    return () => {
      this.exitHandler = undefined;
    };
  }

  exit(): void {
    this.exitHandler?.({ code: 47, signal: null });
  }
}

class GatedConnection extends FakeAgentSideConnection {
  readonly delivery = Promise.withResolvers<void>();
  readonly entered = Promise.withResolvers<void>();
  completed = 0;

  override async sessionUpdate(msg: SessionNotification): Promise<void> {
    const delivery = this.delivery.promise;
    this.updates.push(msg);
    this.entered.resolve();
    await delivery;
    this.completed += 1;
  }
}

function createSession(proc: ExitingPiProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: "exit-stalled-updates",
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn,
  });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("prompt did not settle after child exit")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const cancelled of [false, true]) {
  test(`child exit settles active and queued prompts with stalled updates (cancelled=${cancelled})`, async () => {
    const proc = new ExitingPiProcess();
    const conn = new GatedConnection();
    const session = createSession(proc, conn);
    let activeSettlements = 0;
    let queuedSettlements = 0;
    const active = session.prompt("active").finally(() => {
      activeSettlements += 1;
    });
    const queued = session.prompt("queued").finally(() => {
      queuedSettlements += 1;
    });
    await bounded(conn.entered.promise);
    if (cancelled) await session.cancel();
    proc.exit();
    const reason = cancelled ? "cancelled" : "error";
    assert.deepEqual(await bounded(Promise.all([active, queued])), [reason, reason]);
    assert.equal(activeSettlements, 1);
    assert.equal(queuedSettlements, 1);
    assert.equal(conn.completed, 0, "settlement must not require client delivery");
    assert.equal(proc.prompts.length, 1, "the queued prompt must not start on the dead child");
    await assert.rejects(session.prompt("after exit"), /pi process exited/);

    proc.exit();
    proc.emit({ type: "agent_settled" });
    conn.delivery.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(activeSettlements, 1);
    assert.equal(queuedSettlements, 1);
    assert.equal(conn.updates.length, 1, "abandoned notifications must not resume delivery");
  });
}

test("child exit releases a turn already waiting for notification draining", async () => {
  const proc = new ExitingPiProcess();
  const conn = new GatedConnection();
  const session = createSession(proc, conn);
  const active = session.prompt("active");
  const queued = session.prompt("queued");
  await bounded(conn.entered.promise);
  proc.emit({ type: "agent_settled" });
  proc.exit();
  assert.deepEqual(await bounded(Promise.all([active, queued])), ["end_turn", "error"]);
  assert.equal(proc.prompts.length, 1);
});

test("responsive client drains queued notifications before active prompt settlement on child exit", async () => {
  const proc = new ExitingPiProcess();
  const conn = new GatedConnection();
  const session = createSession(proc, conn);
  let activeSettled = false;
  const active = session.prompt("active").then((reason) => {
    activeSettled = true;
    assert.equal(conn.completed, 3, "all pre-exit updates must complete first");
    return reason;
  });
  const queued = session.prompt("queued");
  await bounded(conn.entered.promise);
  proc.exit();
  await Promise.resolve();
  assert.equal(activeSettled, false, "exit must retain best-effort draining");
  conn.delivery.resolve();
  assert.deepEqual(await bounded(Promise.all([active, queued])), ["error", "error"]);
});
