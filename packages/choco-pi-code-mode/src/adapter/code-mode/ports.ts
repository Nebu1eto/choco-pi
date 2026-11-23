import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeExecutionKind } from "../../tools/code-mode/shared-runtime.ts";
import type { ProgrammaticCodeModeToolDefinition } from "../../tools/code-mode/types.ts";
import type { ExecCommandTracker } from "../../tools/exec/command-state.ts";
import type { ExecSessionManager } from "../../tools/exec/session-manager.ts";
import type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";

export type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";

/** Policy port determining whether code mode is active and which execution backend to use. */
export interface CodeModeRuntimePolicy {
  isActive(ctx: ExtensionContext): boolean;
  executionKind(ctx: ExtensionContext): CodeModeExecutionKind;
}

/** Port supplying optional nested Pi tools exposed inside code-mode execution. */
export type OptionalNestedToolsPort = (
  ctx: ExtensionContext | undefined,
) => ProgrammaticCodeModeToolDefinition[];

/** Hook invoked to claim or consume an asynchronous code-mode tool call by owner and call id. */
export type AsyncCodeModeCallHook = (owner: string, toolCallId: string) => boolean;

/** Dependency-injection port bundle separating code-mode core logic from host extension adapters. */
export interface CodeModePorts {
  policy: CodeModeRuntimePolicy;
  describeImage?: ImageDescribeFallbackPort | undefined;
  optionalNestedTools?: OptionalNestedToolsPort | undefined;
  consumeAsyncCall?: AsyncCodeModeCallHook | undefined;
}

/** Host UI, tool binary, and Deno notebook resource configuration for code-mode tools. */
export interface CodeModeToolConfig {
  tools: { customRustBinariesDir: string; viewImageFallback: boolean };
  ui: { toolRenaming: boolean; compactTools: boolean; codeModeDetails: boolean };
  notebook: { maxHeapMiB: number; profile?: string | undefined };
}

/** Aggregate host state, command/session managers, and ports injected into code-mode registration. */
export interface CodeModeHost {
  state: {
    config: CodeModeToolConfig;
    executionMode: string;
    previousToolNames?: string[] | undefined;
  };
  tracker: ExecCommandTracker;
  sessions: ExecSessionManager;
  codeMode: CodeModePorts;
}
