import assert from "node:assert/strict";
import test from "node:test";

import { runBranchRestoreForGeneration } from "../extensions/agent-browser/lib/runtime-extension.ts";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("stale queued tree restore stops before touching its context", async () => {
  const activeScriptGate = deferred();
  const queueGate = deferred();
  const queued = deferred();
  let generation = 1;
  let staleContext = false;
  let restoreCalls = 0;
  let recoverCalls = 0;
  const ctx = {
    get cwd(): string {
      if (staleContext) throw new Error("stale context accessed");
      return "/current";
    },
  };
  const artifactQueue = {
    async run<T>(work: () => Promise<T>): Promise<T> {
      queued.resolve();
      await queueGate.promise;
      return work();
    },
  };
  const managedSessionQueue = {
    run<T>(work: () => Promise<T>): Promise<T> {
      return work();
    },
  };

  const staleTreeWork = runBranchRestoreForGeneration({
    artifactQueue,
    generation,
    isCurrent: (candidate: number) => candidate === generation,
    managedSessionQueue,
    recover: async () => {
      recoverCalls += 1;
      void ctx.cwd;
    },
    restore: () => {
      restoreCalls += 1;
      return ctx.cwd;
    },
    waitForActiveScripts: async () => {
      await activeScriptGate.promise;
    },
  });

  activeScriptGate.resolve();
  await queued.promise;
  generation += 1;
  staleContext = true;
  queueGate.resolve();
  await staleTreeWork;

  assert.equal(restoreCalls, 0);
  assert.equal(recoverCalls, 0);

  staleContext = false;
  await runBranchRestoreForGeneration({
    artifactQueue: managedSessionQueue,
    generation,
    isCurrent: (candidate: number) => candidate === generation,
    managedSessionQueue,
    recover: async (cwd: string) => {
      recoverCalls += 1;
      assert.equal(cwd, "/current");
    },
    restore: () => {
      restoreCalls += 1;
      return ctx.cwd;
    },
    waitForActiveScripts: async () => undefined,
  });

  assert.equal(restoreCalls, 1);
  assert.equal(recoverCalls, 1);
});
