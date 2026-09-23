import assert from "node:assert/strict";
import test from "node:test";

import {
  default as harnessCheckExtension,
  executeHarnessCheck,
  type HarnessCheckRegistration,
  type HarnessCheckExecutionDependencies,
} from "../.pi/extensions/harness-check.ts";
import type { HarnessReport } from "../.pi/skills/check/scripts/check-harness.ts";

const report: HarnessReport = {
  status: "pass",
  configRoot: "/fixture/.pi",
  mode: "automatic",
  requiredCapabilities: [],
  checks: [],
};

function dependencies(): HarnessCheckExecutionDependencies {
  const owner = { sessionId: "session-a", generation: 4 };
  return {
    capture: () => ({
      runtime: {
        source: "active-host",
        version: "0.86.1",
        path: "/active/sdk",
        authoritative: true,
      },
      nodeVersion: "v24.0.0",
      owner,
    }),
    currentOwner: () => owner,
    check: async (options) => {
      assert.equal(options.runtimeIdentity?.source, "active-host");
      assert.equal(options.runtimeIdentity?.version, "0.86.1");
      return report;
    },
  };
}

test("tool boundary supplies captured active-host identity without caller version input", async () => {
  const result = await executeHarnessCheck(
    { mode: "automatic", required_capabilities: ["resources"] },
    undefined,
    dependencies(),
  );
  assert.equal(result, report);
});

test("tool boundary rejects cancellation before work", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeHarnessCheck({ mode: "automatic" }, controller.signal, dependencies()),
    /cancelled/,
  );
});

test("tool boundary rejects cancellation after asynchronous work", async () => {
  const controller = new AbortController();
  const deps = dependencies();
  deps.check = async () => {
    controller.abort();
    return report;
  };
  await assert.rejects(
    executeHarnessCheck({ mode: "automatic" }, controller.signal, deps),
    /cancelled/,
  );
});

test("tool boundary rejects stale session results", async () => {
  const deps = dependencies();
  deps.currentOwner = () => ({ sessionId: "session-b", generation: 5 });
  await assert.rejects(executeHarnessCheck({ mode: "automatic" }, undefined, deps), /stale/);
});

type CapturedRegistration = {
  tool?: Parameters<HarnessCheckRegistration["registerHarnessCheckTool"]>[0];
  start?: Parameters<HarnessCheckRegistration["onSessionStart"]>[0];
  shutdown?: Parameters<HarnessCheckRegistration["onSessionShutdown"]>[0];
  tree?: Parameters<HarnessCheckRegistration["onSessionTree"]>[0];
};

type RegistrationFixture = {
  registration: HarnessCheckRegistration;
  captured: CapturedRegistration;
};

function createRegistration(check: HarnessCheckRegistration["checkHarness"]): RegistrationFixture {
  const captured: CapturedRegistration = {};
  return {
    captured,
    registration: {
      registerHarnessCheckTool: (tool) => {
        captured.tool = tool;
      },
      onSessionStart: (handler) => {
        captured.start = handler;
      },
      onSessionShutdown: (handler) => {
        captured.shutdown = handler;
      },
      onSessionTree: (handler) => {
        captured.tree = handler;
      },
      checkHarness: check,
    },
  };
}

const context = (sessionId: string) => ({
  sessionManager: { getSessionId: () => sessionId },
});

test("default extension registers a host-authenticated schema and reports failures as tool errors", async () => {
  let observedVersion: string | undefined;
  let observedSource: string | undefined;
  const { registration, captured } = createRegistration(async (options) => {
    observedVersion = options.runtimeIdentity?.version;
    observedSource = options.runtimeIdentity?.source;
    return { ...report, status: "fail" };
  });
  harnessCheckExtension(registration);
  assert.ok(captured.tool);
  assert.deepEqual(Object.keys(captured.tool.parameters.properties).sort(), [
    "mode",
    "required_capabilities",
  ]);
  await captured.start?.({ type: "session_start", reason: "startup" }, context("session-a"));
  const result = await captured.tool.execute(
    "call-1",
    { mode: "automatic" },
    undefined,
    undefined,
    context("session-a"),
  );
  assert.equal(observedSource, "active-host");
  assert.equal(observedVersion, "0.86.1");
  assert.equal(result.isError, true);
});

for (const lifecycle of ["start", "shutdown", "tree"] as const) {
  test(`default extension rejects an in-flight result invalidated by session ${lifecycle}`, async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registration, captured } = createRegistration(async () => {
      await pending;
      return report;
    });
    harnessCheckExtension(registration);
    assert.ok(captured.tool);
    await captured.start?.({ type: "session_start", reason: "startup" }, context("session-a"));
    const execution = captured.tool.execute(
      "call-1",
      { mode: "automatic" },
      undefined,
      undefined,
      context("session-a"),
    );
    if (lifecycle === "start") {
      await captured.start?.({ type: "session_start", reason: "reload" }, context("session-b"));
    } else if (lifecycle === "shutdown") {
      await captured.shutdown?.(
        { type: "session_shutdown", reason: "reload" },
        context("session-a"),
      );
    } else {
      await captured.tree?.(
        { type: "session_tree", newLeafId: "branch-b", oldLeafId: "branch-a" },
        context("session-a"),
      );
    }
    release?.();
    await assert.rejects(execution, /stale/);
  });
}
