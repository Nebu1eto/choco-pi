/**
 * ports.ts — Injection points between the provider-neutral Code Mode layer and
 * the provider that composes it.
 *
 * Nothing under `src/adapter/code-mode*`, `src/tools/{code-mode,apply-patch,exec,
 * view-image,native}/`, `src/patch/` or `src/shell/` may import OpenAI Codex or
 * Responses code. The Codex extension composition root (`src/extension/`)
 * implements these ports and hands them in on `CodeModeHost.codeMode`.
 * `tests/universal-layer-boundary.test.ts` enforces the direction.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeExecutionKind } from "../../tools/code-mode/shared-runtime.ts";
import type { ProgrammaticCodeModeToolDefinition } from "../../tools/code-mode/types.ts";
import type { ExecCommandTracker } from "../../tools/exec/command-state.ts";
import type { ExecSessionManager } from "../../tools/exec/session-manager.ts";
import type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";

export type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";

/** Port (CodeModePolicyPort): whether Code Mode owns a turn and which runtime runs it. */
export interface CodeModeRuntimePolicy {
  isActive(ctx: ExtensionContext): boolean;
  executionKind(ctx: ExtensionContext): CodeModeExecutionKind;
}

/**
 * Port (OptionalNestedToolsPort): provider-contributed nested tools, appended
 * after the core tools (apply_patch, exec_command, write_stdin, view_image) and
 * before the bridged session tools, in the order returned.
 */
export type OptionalNestedToolsPort = (
  ctx: ExtensionContext | undefined,
) => ProgrammaticCodeModeToolDefinition[];

/** Port (AsyncCodeModeCallHook): consumes a provider's native async exec-call record. */
export type AsyncCodeModeCallHook = (owner: string, toolCallId: string) => boolean;

export interface CodeModePorts {
  policy: CodeModeRuntimePolicy;
  describeImage?: ImageDescribeFallbackPort | undefined;
  optionalNestedTools?: OptionalNestedToolsPort | undefined;
  consumeAsyncCall?: AsyncCodeModeCallHook | undefined;
}

/** The configuration Code Mode itself reads; a provider config may carry more. */
export interface CodeModeToolConfig {
  tools: { customRustBinariesDir: string; viewImageFallback: boolean };
  ui: { toolRenaming: boolean; compactTools: boolean; codeModeDetails: boolean };
  notebook: { maxHeapMiB: number; profile?: string | undefined };
}

/** The runtime surface Code Mode needs from its host extension. */
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
