import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerAgents } from "../src/agent-types.ts";
import { runAgent, type RunOptions } from "../src/agent-runner.ts";
import type { AgentConfig } from "../src/types.ts";

type LoaderOptions = Parameters<NonNullable<RunOptions["createResourceLoader"]>>[0];
type RuntimeValue = {} | null | undefined;
interface StatusMessageResult {
  message: { customType: string; content: string; display: boolean };
}
type BeforeAgentStartHandler = (event: {
  prompt: string;
  systemPrompt: string;
}) => StatusMessageResult | undefined;
interface NamedInlineFactory {
  name: string;
  hidden?: boolean;
  factory(pi: ExtensionAPI): void | Promise<void>;
}

function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: RuntimeValue covers the host fixtures, and each caller supplies the exact slice reached by the probe.
  return value as Target;
}

function config(
  name: string,
  extensions: AgentConfig["extensions"],
  excludeExtensions?: string[],
): AgentConfig {
  return {
    name,
    description: `${name} loader probe`,
    builtinToolNames: ["read"],
    extensions,
    excludeExtensions,
    skills: false,
    systemPrompt: "loader probe",
    promptMode: "replace",
  };
}

async function captureLoaderOptions(agentConfig: AgentConfig): Promise<LoaderOptions> {
  registerAgents(new Map([[agentConfig.name, agentConfig]]));
  let captured: LoaderOptions | undefined;
  const stop = new Error("loader options captured");
  const pi = reinterpretHostValue<ExtensionAPI>({
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  const ctx = reinterpretHostValue<ExtensionContext>({
    cwd: process.cwd(),
    getSystemPrompt: () => "parent system",
  });
  const manager = reinterpretHostValue<NonNullable<RunOptions["nestedRuntime"]>["manager"]>({
    getActiveCount: () => 2,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
  });

  await assert.rejects(
    runAgent(ctx, agentConfig.name, "probe", {
      pi,
      nestedRuntime: {
        manager,
        parentAgentId: "parent-id",
        depth: 2,
        maxSubagentDepth: 3,
      },
      createResourceLoader: (loaderOptions) => {
        captured = loaderOptions;
        throw stop;
      },
    }),
    stop,
  );
  assert.ok(captured, "runAgent must reach the DefaultResourceLoader options seam");
  return captured;
}

function extensionPathsAfterOverride(options: LoaderOptions): string[] {
  const extensions = [
    { path: "<inline:subagent-status>" },
    { path: "/tmp/extensions/alpha.ts" },
    { path: "/tmp/extensions/beta.ts" },
  ];
  const base = reinterpretHostValue<
    Parameters<NonNullable<LoaderOptions["extensionsOverride"]>>[0]
  >({ extensions, errors: [], runtime: {} });
  const result = options.extensionsOverride?.(base);
  assert.ok(result, "the allowlist or exclude must install an extension override");
  return result.extensions.map((extension) => extension.path);
}

async function invokeStatusFactory(options: LoaderOptions) {
  const inline = options.extensionFactories?.find((factory) => factory.name === "subagent-status");
  assert.ok(inline, "runAgent must pass the subagent-status factory to the child loader");
  const statusFactory = reinterpretHostValue<NamedInlineFactory>(inline);
  assert.equal(statusFactory.hidden, true);
  const handlers = new Map<string, BeforeAgentStartHandler>();
  await statusFactory.factory(
    reinterpretHostValue<ExtensionAPI>({
      on: (event: string, handler: BeforeAgentStartHandler) => {
        handlers.set(event, handler);
      },
    }),
  );
  const handler = handlers.get("before_agent_start");
  assert.ok(handler, "the child inline factory must register before_agent_start");
  assert.deepEqual(handler({ prompt: "next", systemPrompt: "system" }), {
    message: {
      customType: "subagent-status",
      content:
        "<system-reminder>Turn-start subagent snapshot (historical after this turn): 1 scheduled / cap 4; 2 in tree; inherited depth ceiling 3; current depth 2 of 3</system-reminder>",
      display: false,
    },
  });
}

test("runAgent wires child status through loader allowlists and excludes", async () => {
  try {
    const allowlist = await captureLoaderOptions(config("status-allowlist", ["alpha"]));
    assert.deepEqual(extensionPathsAfterOverride(allowlist), [
      "<inline:subagent-status>",
      "/tmp/extensions/alpha.ts",
    ]);
    await invokeStatusFactory(allowlist);

    const exclude = await captureLoaderOptions(config("status-exclude", true, ["alpha"]));
    assert.deepEqual(extensionPathsAfterOverride(exclude), [
      "<inline:subagent-status>",
      "/tmp/extensions/beta.ts",
    ]);
    await invokeStatusFactory(exclude);
  } finally {
    registerAgents(new Map());
  }
});
