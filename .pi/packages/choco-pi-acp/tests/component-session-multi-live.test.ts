import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "../src/acp/session.ts";
import type { PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

class DisposableFakePiProcess implements PiRpcProcessLike {
  disposed = false;

  onEvent(): () => void {
    return () => {};
  }

  async prompt(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
  }
}

test("SessionManager retains multiple live sessions and evicts the least recently used", async () => {
  const manager = new SessionManager();
  const conn = asAgentConn(new FakeAgentSideConnection());
  const processes = new Map<string, DisposableFakePiProcess>();

  for (const id of ["first", "second", "third"]) {
    const proc = new DisposableFakePiProcess();
    processes.set(id, proc);
    manager.getOrCreate(id, {
      cwd: "/tmp/project",
      mcpServers: [],
      conn,
      proc,
    });
    assert.deepEqual(manager.retainRecent(id, 3), []);
  }

  assert.deepEqual(
    [...processes].map(([id, proc]) => [id, proc.disposed]),
    [
      ["first", false],
      ["second", false],
      ["third", false],
    ],
  );

  // This mirrors session/load touching an already-live session before applying the cap.
  assert.deepEqual(manager.retainRecent("first", 2), ["second"]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(processes.get("second")?.disposed, true);
  assert.equal(processes.get("first")?.disposed, false);
  assert.equal(processes.get("third")?.disposed, false);
  assert.equal(manager.maybeGet("second"), undefined);
  assert.ok(manager.maybeGet("first"));
  assert.ok(manager.maybeGet("third"));

  manager.disposeAll();
});
