import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

type ToolCallOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/**
 * Tool-execution context for tests that hold only an ExtensionContext. Every
 * base member is read lazily, so partial fixtures and getter-backed contexts
 * behave as they would when passed directly. No tools are callable: nested
 * calls resolve to an error outcome, matching a host without `executeTool`.
 */
export function toolContext(
  base: ExtensionContext,
  toolCallId = "fixture-call",
): ExtensionToolContext {
  let nestedCalls = 0;
  return {
    get ui() {
      return base.ui;
    },
    get mode() {
      return base.mode;
    },
    get hasUI() {
      return base.hasUI;
    },
    get cwd() {
      return base.cwd;
    },
    get sessionManager() {
      return base.sessionManager;
    },
    get modelRegistry() {
      return base.modelRegistry;
    },
    get model() {
      return base.model;
    },
    get scopedModels() {
      return base.scopedModels;
    },
    get thinkingLevel() {
      return base.thinkingLevel;
    },
    isIdle: () => base.isIdle(),
    isProjectTrusted: () => base.isProjectTrusted(),
    get signal() {
      return base.signal;
    },
    abort: () => base.abort(),
    hasPendingMessages: () => base.hasPendingMessages(),
    shutdown: () => base.shutdown(),
    getContextUsage: () => base.getContextUsage(),
    compact: (options) => base.compact(options),
    getSystemPrompt: () => base.getSystemPrompt(),
    tools: [],
    async executeTool(name): Promise<ToolCallOutcome> {
      nestedCalls += 1;
      return {
        toolCall: { type: "toolCall", id: `${toolCallId}/${nestedCalls}`, name, arguments: {} },
        result: {
          content: [{ type: "text", text: "Nested tool calls are not available in this context" }],
          details: {},
        },
        isError: true,
      };
    },
  };
}
