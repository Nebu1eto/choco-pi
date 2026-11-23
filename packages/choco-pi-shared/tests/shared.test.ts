import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import {
  createLifecycleOwner,
  isStaleContextError,
  rethrowUnlessStaleContext,
  STALE_CONTEXT_ERROR_PREFIX,
} from "../src/lifecycle.ts";
import { isBunRuntime, nodeBinDirectory, nodeExecutable } from "../src/node-runtime.ts";
import { legacyPiFallbacks, piAgentDir, piStateRoot, standaloneHome } from "../src/pi-paths.ts";
import {
  DEFAULT_PRINT_WAIT_MS,
  printWaitLimitMs,
  waitForBackgroundSettle,
} from "../src/print-settle-wait.ts";
import {
  isBoolean,
  isJsonRecord,
  isNumber,
  isString,
  runtimeTypeOf,
} from "../src/runtime-values.ts";
import {
  isAdmissionOpen,
  mayTriggerTurn,
  readStopState,
  STOP_CONTROL_PROTOCOL,
  STOP_CONTROL_REGISTRY_KEY,
} from "../src/stop-control.ts";
import { deleteGlobalSlot, readGlobalSlot, writeGlobalSlot } from "../src/symbols.ts";
import {
  errorCode,
  errorMessage,
  finiteNum,
  isFiniteNumber,
  isRecord,
  isStringArray,
  stringValue,
} from "../src/value-guards.ts";

test("lifecycle owner invalidates leases synchronously and matches stale-context prefix", () => {
  const owner = createLifecycleOwner<{ id: number }>();
  const lease1 = owner.replace({ id: 1 });
  assert.equal(owner.isCurrent(lease1), true);
  const lease2 = owner.replace({ id: 2 });
  assert.equal(owner.isCurrent(lease1), false);
  assert.equal(owner.isCurrent(lease2), true);
  owner.invalidate();
  assert.equal(owner.current(), undefined);
  assert.equal(isStaleContextError(new Error(STALE_CONTEXT_ERROR_PREFIX)), true);
  assert.equal(isStaleContextError(new Error(`${STALE_CONTEXT_ERROR_PREFIX} Details.`)), true);
  assert.equal(isStaleContextError(new Error("Other error")), false);
  assert.doesNotThrow(() => rethrowUnlessStaleContext(new Error(STALE_CONTEXT_ERROR_PREFIX)));
  assert.throws(() => rethrowUnlessStaleContext(new Error("boom")), /boom/);
});

test("stop-control reads globalThis registry statelessly and falls back to open epoch 0", () => {
  const previous = readGlobalSlot(STOP_CONTROL_REGISTRY_KEY);
  try {
    deleteGlobalSlot(STOP_CONTROL_REGISTRY_KEY);
    assert.deepEqual(readStopState("root-1"), { epoch: 0, closed: false });
    assert.equal(isAdmissionOpen("root-1"), true);
    writeGlobalSlot(STOP_CONTROL_REGISTRY_KEY, {
      protocol: STOP_CONTROL_PROTOCOL,
      state: (id: string) =>
        id === "root-1" ? { epoch: 3, closed: true } : { epoch: 2, closed: false },
    });
    assert.deepEqual(readStopState("root-1"), { epoch: 3, closed: true });
    assert.equal(isAdmissionOpen("root-1"), false);
    assert.equal(mayTriggerTurn("root-1", 3), false);
    assert.equal(mayTriggerTurn("root-2", 2), true);
    assert.equal(mayTriggerTurn("root-2", 1), false);
  } finally {
    if (previous === undefined) deleteGlobalSlot(STOP_CONTROL_REGISTRY_KEY);
    else writeGlobalSlot(STOP_CONTROL_REGISTRY_KEY, previous);
  }
});

test("value guards and runtime-values reject NaN/Infinity in finiteNum and classify primitives", () => {
  const checkFinite = compile(finiteNum()).check;
  assert.equal(checkFinite(42), true);
  assert.equal(checkFinite(Number.NaN), false);
  assert.equal(checkFinite(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteNumber(1.5), true);
  assert.equal(isFiniteNumber(Number.NaN), false);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isStringArray(["a", "b"]), true);
  assert.equal(isStringArray(["a", 1]), false);
  assert.equal(stringValue("hi"), "hi");
  assert.equal(stringValue(1), undefined);
  assert.equal(errorMessage(new Error("bad")), "bad");
  assert.equal(errorCode({ code: "ENOENT" }), "ENOENT");
  assert.equal(isBoolean(false), true);
  assert.equal(isNumber(Number.NaN), true);
  assert.equal(isString("x"), true);
  assert.equal(isJsonRecord({}), true);
  assert.equal(runtimeTypeOf(undefined), "undefined");
});

test("pi-paths, node-runtime, and print-settle-wait behave purely", async () => {
  assert.equal(
    standaloneHome({ CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "/opt/choco" }),
    "/opt/choco",
  );
  assert.equal(
    piAgentDir({ CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "/opt/choco" }, "/home/u"),
    "/opt/choco/agent",
  );
  assert.equal(piStateRoot({}, "/home/u"), "/home/u/.pi");
  assert.deepEqual(
    legacyPiFallbacks({ CHOCO_PI_STANDALONE: "1", CHOCO_PI_HOME: "/opt/choco" }, "/home/u"),
    [],
  );
  assert.equal(isBunRuntime({ bun: "1.2" }), true);
  assert.equal(
    nodeExecutable({ versions: { bun: "1.2" }, env: { CHOCO_PI_NODE: "/usr/bin/node" } }),
    "/usr/bin/node",
  );
  assert.equal(
    nodeBinDirectory({ versions: { bun: "1.2" }, env: { CHOCO_PI_NODE: "/usr/bin/node" } }),
    "/usr/bin",
  );
  assert.equal(printWaitLimitMs(undefined), DEFAULT_PRINT_WAIT_MS);
  assert.equal(printWaitLimitMs("0"), 0);
  const outcome = await waitForBackgroundSettle({
    isBusy: () => false,
    deliveries: () => 0,
    isCancelled: () => false,
    maxWaitMs: 100,
  });
  assert.equal(outcome, "idle");
});
