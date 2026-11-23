import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeExecutionKind } from "../../tools/code-mode/shared-runtime.ts";
import type { ProgrammaticCodeModeToolDefinition } from "../../tools/code-mode/types.ts";
import type { ExecCommandTracker } from "../../tools/exec/command-state.ts";
import type { ExecSessionManager } from "../../tools/exec/session-manager.ts";
import type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";

export type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";

export interface CodeModeRuntimePolicy {
  isActive(ctx: ExtensionContext): boolean;
  executionKind(ctx: ExtensionContext): CodeModeExecutionKind;
}

export type OptionalNestedToolsPort = (
  ctx: ExtensionContext | undefined,
) => ProgrammaticCodeModeToolDefinition[];

export type AsyncCodeModeCallHook = (owner: string, toolCallId: string) => boolean;

export interface CodeModePorts {
  policy: CodeModeRuntimePolicy;
  describeImage?: ImageDescribeFallbackPort | undefined;
  optionalNestedTools?: OptionalNestedToolsPort | undefined;
  consumeAsyncCall?: AsyncCodeModeCallHook | undefined;
}

export interface CodeModeToolConfig {
  tools: { customRustBinariesDir: string; viewImageFallback: boolean };
  ui: { toolRenaming: boolean; compactTools: boolean; codeModeDetails: boolean };
  notebook: { maxHeapMiB: number; profile?: string | undefined };
}

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
