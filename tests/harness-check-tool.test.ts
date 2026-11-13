import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";

import {
  default as harnessCheckExtension,
  executeHarnessCheck,
  loadedBuiltinExtensions,
  activeHostTools,
  type HarnessCheckRegistration,
  type HarnessCheckExecutionDependencies,
} from "../.pi/extensions/harness-check.ts";
import type { HarnessReport } from "../.pi/skills/check/scripts/check-harness.ts";
import { isJsonRecord } from "../.pi/extensions/lib/runtime-values.ts";

const report: HarnessReport = {
  status: "pass",
  configRoot: "/fixture/.pi",
  mode: "automatic",
  requiredCapabilities: [],
  checks: [],
};

test("active tools require choco-pi tool_search provenance and expose custom adapters", () => {
  const entry = (name: string, path: string) => ({ name, sourceInfo: { path } });
  assert.deepEqual(
    activeHostTools([
      entry("tool_search", "/repo/.pi/extensions/tool-search.ts"),
      entry("mcp", "/custom/adapter.ts"),
      entry("mcpScript", "/custom/adapter.ts"),
    ]),
    { chocoToolSearch: true, adapterTools: ["mcp", "mcpScript"] },
  );
  assert.equal(
    activeHostTools([entry("tool_search", "<inline:subagent-tool-search>")]).chocoToolSearch,
    true,
    "a child's scoped search counts",
  );
  for (const path of ["builtin:tool-search", "/custom/search.ts", "<inline:other-search>"]) {
    assert.equal(activeHostTools([entry("tool_search", path)]).chocoToolSearch, false, path);
  }
});

function dependencies(): HarnessCheckExecutionDependencies {
  const owner = { sessionId: "session-a", generation: 4 };
  return {
    capture: () => ({
      runtime: {
        source: "active-host",
        version: "0.87.1",
        path: "/active/sdk",
        authoritative: true,
      },
      nodeVersion: "v24.0.0",
      owner,
    }),
    currentOwner: () => owner,
    check: async (options) => {
      assert.equal(options.runtimeIdentity?.source, "active-host");
      assert.equal(options.runtimeIdentity?.version, "0.87.1");
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
  const parameterProperties = Object.getOwnPropertyDescriptor(
    captured.tool.parameters,
    "properties",
  )?.value;
  assert.ok(isJsonRecord(parameterProperties));
  assert.deepEqual(Object.keys(parameterProperties).sort(), ["mode", "required_capabilities"]);
  await captured.start?.({ type: "session_start", reason: "startup" }, context("session-a"));
  const result = await captured.tool.execute(
    "call-1",
    { mode: "automatic" },
    undefined,
    undefined,
    context("session-a"),
  );
  assert.equal(observedSource, "active-host");
  assert.equal(observedVersion, VERSION);
  assert.equal(result.isError, true);
});

test("tool result text and its nested keys are snake_case", async () => {
  const { registration, captured } = createRegistration(async () => report);
  harnessCheckExtension(registration);
  assert.ok(captured.tool);
  await captured.start?.({ type: "session_start", reason: "startup" }, context("session-a"));
  const result = await captured.tool.execute(
    "call-1",
    { mode: "automatic" },
    undefined,
    undefined,
    context("session-a"),
  );
  const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
  const parsed = JSON.parse(text);
  assert.equal(parsed.config_root, "/fixture/.pi");
  assert.deepEqual(parsed.required_capabilities, []);
  assert.equal("configRoot" in parsed, false);
  assert.equal("requiredCapabilities" in parsed, false);
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

test("in-host observation of built-in extensions reaches the readiness check", async () => {
  const deps = dependencies();
  let observed: readonly string[] | undefined;
  deps.observeBuiltinExtensions = () => ["codemode"];
  deps.observeActiveHostTools = () => ({ chocoToolSearch: true, adapterTools: ["mcpScript"] });
  deps.check = async (options) => {
    observed = options.loadedBuiltinExtensions;
    assert.deepEqual(options.activeHostTools, {
      chocoToolSearch: true,
      adapterTools: ["mcpScript"],
    });
    return report;
  };
  await executeHarnessCheck({ mode: "automatic" }, undefined, deps);
  assert.deepEqual(observed, ["codemode"]);

  const withoutObservation = dependencies();
  withoutObservation.check = async (options) => {
    assert.equal("loadedBuiltinExtensions" in options, false);
    return report;
  };
  await executeHarnessCheck({ mode: "automatic" }, undefined, withoutObservation);
});

test("built-in extensions are identified by their builtin source path", () => {
  const entry = (path: string) => ({ sourceInfo: { path } });
  assert.deepEqual(
    loadedBuiltinExtensions([
      entry("builtin:read"),
      entry("builtin:codemode"),
      entry("builtin:llama.cpp"),
      entry("/repo/.pi/extensions/tool-search.ts"),
      entry("builtin:mcp"),
      entry("builtin:tool-search"),
    ]),
    ["codemode", "tool-search"],
  );
});
