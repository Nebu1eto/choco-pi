import assert from "node:assert/strict";
import test from "node:test";
import type {
  CacheWarmingStatus,
  ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import statusCommands, { statusBody } from "../.pi/extensions/status-commands.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";

function fakeContext(): ExtensionCommandContext {
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    sessionManager: {
      getEntries: () => [],
      getSessionName: () => undefined,
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
      getHeader: () => null,
    },
    getContextUsage: () => undefined,
    modelRegistry: { find: () => undefined },
    getSystemPromptOptions: () => ({ cwd: process.cwd(), contextFiles: [], skills: [] }),
  } satisfies Pick<ExtensionCommandContext, "cwd" | "model" | "getContextUsage"> & {
    sessionManager: Pick<
      ExtensionCommandContext["sessionManager"],
      "getEntries" | "getSessionName" | "getSessionId" | "getSessionFile" | "getHeader"
    >;
    modelRegistry: Pick<ModelRegistry, "find">;
    getSystemPromptOptions: ExtensionCommandContext["getSystemPromptOptions"];
  };
  return reinterpretHostValue<ExtensionCommandContext>(ctx);
}

test("statusBody includes cache warming when the host capture is unavailable", () => {
  const body = statusBody(fakeContext(), "medium");
  assert.match(body, /^Cache warming {2}unavailable$/m);
});

test("the interactive host is captured when InteractiveMode.run starts", async () => {
  type Host = {
    session: { cacheWarmingStatus: CacheWarmingStatus; prompt: () => Promise<void> };
    settingsManager: { getCacheWarmingMode: () => "streaming" };
  };
  const prototype = reinterpretHostValue<{ run: (this: Host) => Promise<void> }>(
    InteractiveMode.prototype,
  );
  assert.ok(InteractiveMode.prototype.run instanceof Function);
  const originalRun = prototype.run;
  const appliedPrototype = reinterpretHostValue<{ __chocoPiSessionCommandApplied?: boolean }>(
    InteractiveMode.prototype,
  );
  const originalApplied = appliedPrototype.__chocoPiSessionCommandApplied;
  test.after(() => {
    prototype.run = originalRun;
    appliedPrototype.__chocoPiSessionCommandApplied = originalApplied;
  });
  let delegated = 0;
  prototype.run = async function stubbedRun() {
    delegated += 1;
  };
  const api = {
    on: () => () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getThinkingLevel: () => "medium",
  };
  statusCommands(reinterpretHostValue<Parameters<typeof statusCommands>[0]>(api));
  const status: CacheWarmingStatus = { state: "inactive", reason: "waiting for first request" };
  const host: Host = {
    session: { cacheWarmingStatus: status, prompt: async () => undefined },
    settingsManager: { getCacheWarmingMode: () => "streaming" as const },
  };
  await prototype.run.call(host);
  assert.equal(delegated, 1);
  const body = statusBody(fakeContext(), "medium");
  assert.match(body, /^Cache warming {2}streaming · Inactive \(waiting for first request\)$/m);
  host.session = {
    cacheWarmingStatus: { state: "inactive", reason: "second session" },
    prompt: async () => undefined,
  };
  assert.match(statusBody(fakeContext(), "medium"), /Inactive \(second session\)/);
});
