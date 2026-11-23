import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

function unexpectedHostService(name: string): never {
  throw new Error(`Unexpected ExtensionToolContext access in fixture: ${name}`);
}

export interface ToolContextFixtureOptions {
  cwd?: string;
  tools?: ExtensionToolContext["tools"];
  executeTool?: ExtensionToolContext["executeTool"];
  sessionManager?: ExtensionToolContext["sessionManager"];
}

export function createToolContextFixture(
  options: ToolContextFixtureOptions = {},
): ExtensionToolContext {
  const callable = options.tools ?? [];
  const sessionManager = options.sessionManager;
  return {
    get ui(): ExtensionToolContext["ui"] {
      return unexpectedHostService("ui");
    },
    mode: "json",
    hasUI: false,
    cwd: options.cwd ?? "/tmp",
    get sessionManager(): ExtensionToolContext["sessionManager"] {
      return sessionManager ?? unexpectedHostService("sessionManager");
    },
    get modelRegistry(): ExtensionToolContext["modelRegistry"] {
      return unexpectedHostService("modelRegistry");
    },
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => false,
    signal: undefined,
    abort: () => unexpectedHostService("abort"),
    hasPendingMessages: () => false,
    shutdown: () => unexpectedHostService("shutdown"),
    getContextUsage: () => undefined,
    compact: () => unexpectedHostService("compact"),
    getSystemPrompt: () => "",
    tools: callable,
    executeTool: options.executeTool ?? (async () => unexpectedHostService("executeTool")),
  };
}
