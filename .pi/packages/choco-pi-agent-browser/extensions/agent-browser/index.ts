import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentToolResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { canRegisterWebSearchTool, loadAgentBrowserConfigSync } from "./lib/config.ts";
import { AGENT_BROWSER_PARAMS } from "./lib/input-modes/params.ts";
import type { AgentBrowserExecuteParams } from "./lib/orchestration/input-plan.ts";
import { isRecord } from "./lib/parsing.ts";
import {
  AgentBrowserResultComponent,
  formatAgentBrowserRenderCall,
  formatAgentBrowserRenderResult,
} from "./lib/pi-tool-rendering.ts";
import { buildToolPromptGuidelines } from "./lib/playbook.ts";
import { createDeferredAgentBrowserWebSearchTool } from "./lib/web-search-registration.ts";

type AgentBrowserTool = ToolDefinition<typeof AGENT_BROWSER_PARAMS>;
type RuntimeEvent =
  | BeforeAgentStartEvent
  | SessionShutdownEvent
  | SessionStartEvent
  | SessionTreeEvent
  | ToolCallEvent
  | ToolResultEvent;
type RuntimeEventName =
  | "before_agent_start"
  | "session_shutdown"
  | "session_start"
  | "session_tree"
  | "tool_call"
  | "tool_result";

interface CapturedRuntime {
  handlers: Map<RuntimeEventName, CapturedHandler>;
  tool: AgentBrowserTool;
}

type DeferredToolResultEventResult = {
  content?: AgentToolResult<unknown>["content"];
  details?: unknown;
  isError?: boolean;
  usage?: ToolResultEvent["usage"];
};

type CapturedResult =
  | BeforeAgentStartEventResult
  | DeferredToolResultEventResult
  | ToolCallEventResult
  | void;
type CapturedHandler = (
  event: RuntimeEvent,
  ctx: ExtensionContext,
) => CapturedResult | Promise<CapturedResult>;

interface InstalledDocsPaths {
  readmePath: string;
}

function findPackageRoot(startDir: string): string {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (isRecord(packageJson) && packageJson.name === "choco-pi-agent-browser") return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return startDir;
    currentDir = parentDir;
  }
}

function getInstalledDocsPaths(): InstalledDocsPaths {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  return { readmePath: join(packageRoot, "README.md") };
}

function hasArgvFlag(argv: readonly string[], longFlag: string, shortFlag: string): boolean {
  return argv.includes(longFlag) || argv.includes(shortFlag);
}

function shouldIncludeProjectConfig(
  ctx: { isProjectTrusted?: () => boolean } | undefined,
  argv: readonly string[] = process.argv,
): boolean {
  if (hasArgvFlag(argv, "--no-approve", "-na")) return false;
  return ctx?.isProjectTrusted?.() ?? true;
}

async function captureRuntime(pi: ExtensionAPI): Promise<CapturedRuntime> {
  const handlers = new Map<RuntimeEventName, CapturedHandler>();
  let tool: AgentBrowserTool | undefined;
  const captureHandler = (eventName: RuntimeEventName, handler: CapturedHandler): void => {
    handlers.set(eventName, handler);
  };
  const captureTool = (candidate: ToolDefinition): void => {
    if (candidate.name !== "agent_browser") return;
    // SAFETY: runtime-extension registers agent_browser with the same AGENT_BROWSER_PARAMS schema imported above.
    tool = candidate as AgentBrowserTool;
  };
  // SAFETY: runtimePi inherits the live host API and replaces only registration methods with collectors.
  const runtimePi = Object.create(pi) as ExtensionAPI;
  Object.defineProperties(runtimePi, {
    on: { value: captureHandler },
    registerTool: { value: captureTool },
  });
  const runtimeExtension = await import("./lib/runtime-extension.ts");
  runtimeExtension.default(runtimePi);
  if (!tool) throw new Error("agent_browser runtime did not register its tool implementation.");
  for (const eventName of [
    "session_start",
    "session_tree",
    "session_shutdown",
    "before_agent_start",
    "tool_call",
    "tool_result",
  ] as const) {
    if (!handlers.has(eventName))
      throw new Error(`agent_browser runtime did not register its ${eventName} handler.`);
  }
  return { handlers, tool };
}

async function dispatchRuntimeEvent<Result>(
  runtimePromise: Promise<CapturedRuntime>,
  eventName: RuntimeEventName,
  event: RuntimeEvent,
  ctx: ExtensionContext,
): Promise<Result | void> {
  const runtime = await runtimePromise;
  const handler = runtime.handlers.get(eventName);
  if (!handler) throw new Error(`agent_browser runtime handler ${eventName} is unavailable.`);
  // SAFETY: each proxy is registered for the same Pi event name captured from runtime-extension.
  return (await handler(event, ctx)) as Result | void;
}

export default function agentBrowserExtension(pi: ExtensionAPI): void {
  const agentBrowserConfig = loadAgentBrowserConfigSync({
    cwd: process.cwd(),
    includeProjectConfig: false,
  });
  const webSearchToolAvailable = canRegisterWebSearchTool(agentBrowserConfig);
  const toolPromptGuidelines = buildToolPromptGuidelines({
    browserDefaultProfile: agentBrowserConfig.trustedBrowserDefaultProfile,
    browserExecutablePath: agentBrowserConfig.trustedBrowserExecutablePath,
    includeWebSearch: webSearchToolAvailable,
    docs: getInstalledDocsPaths(),
  });
  let runtimePromise: Promise<CapturedRuntime> | undefined;
  const getRuntime = (): Promise<CapturedRuntime> => {
    runtimePromise ??= captureRuntime(pi);
    return runtimePromise;
  };

  pi.on("session_start", async (event, ctx) => {
    await dispatchRuntimeEvent(getRuntime(), "session_start", event, ctx);
  });
  pi.on("session_tree", async (event, ctx) => {
    await dispatchRuntimeEvent(getRuntime(), "session_tree", event, ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await dispatchRuntimeEvent(getRuntime(), "session_shutdown", event, ctx);
  });
  pi.on("before_agent_start", async (event, ctx) =>
    dispatchRuntimeEvent<BeforeAgentStartEventResult>(
      getRuntime(),
      "before_agent_start",
      event,
      ctx,
    ),
  );
  pi.on("tool_call", async (event, ctx) =>
    dispatchRuntimeEvent<ToolCallEventResult>(getRuntime(), "tool_call", event, ctx),
  );
  pi.on("tool_result", async (event, ctx) =>
    dispatchRuntimeEvent<DeferredToolResultEventResult>(getRuntime(), "tool_result", event, ctx),
  );

  const agentBrowserTool = {
    name: "agent_browser",
    label: "Agent Browser",
    description:
      "Browse and interact with websites using agent-browser. Use this for web research, reading live docs, opening pages, taking snapshots or screenshots, clicking links, filling forms, extracting page content, and authenticated/profile-based browser work. Input choice: `script` for one-shot JavaScript orchestration; default `args` for open → snapshot -i → click/fill @refs; `semanticAction` for stable role/text/label targets; `job` or `qa` for multi-step checks; `electron` only for desktop apps; experimental `sourceLookup` / `networkSourceLookup` for candidates only.",
    promptSnippet:
      "Browse websites, read live docs, click and fill pages, extract browser content, take screenshots, and automate real web workflows.",
    promptGuidelines: toolPromptGuidelines,
    parameters: AGENT_BROWSER_PARAMS,
    renderCall(args, theme, context) {
      const text =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
      return text;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof AgentBrowserResultComponent
          ? context.lastComponent
          : new AgentBrowserResultComponent();
      component.setState(
        formatAgentBrowserRenderResult(result, options, theme, context.isError),
        options.expanded,
        theme,
      );
      return component;
    },
    async execute(toolCallId, params: AgentBrowserExecuteParams, signal, onUpdate, ctx) {
      const runtime = await getRuntime();
      return runtime.tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } satisfies AgentBrowserTool;
  pi.registerTool(agentBrowserTool);

  if (webSearchToolAvailable) {
    pi.registerTool(
      createDeferredAgentBrowserWebSearchTool(agentBrowserConfig, {
        loadConfigState(ctx) {
          return loadAgentBrowserConfigSync({
            cwd: ctx.cwd,
            includeProjectConfig: shouldIncludeProjectConfig(ctx),
          });
        },
      }),
    );
  }
}
