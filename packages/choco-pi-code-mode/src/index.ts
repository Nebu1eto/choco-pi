// @choco-pi/code-mode: universal Code Mode (exec/wait), the core nested tools
// (apply_patch, exec_command, write_stdin, view_image) and their engines.
// Library entry; the Pi extension entry is ./extension.ts.
export { createNestedTools, registerCodeMode, registerCodexCodeMode } from "./adapter/code-mode.ts";
export type {
  AsyncCodeModeCallHook,
  CodeModeHost,
  CodeModePorts,
  CodeModeRuntimePolicy,
  CodeModeToolConfig,
  ImageDescribeFallbackPort,
  OptionalNestedToolsPort,
} from "./adapter/code-mode/ports.ts";
export type { CodeModeRegistration } from "./tools/code-mode/tools.ts";
export {
  CODE_MODE_HOST_CHANNEL,
  claimCodeModeHost,
  probeCodeModeHostOwner,
  type CodeModeHostOwner,
  type CodeModeHostOwnerKind,
} from "./host-slot.ts";
export {
  DEFAULT_STANDALONE_CODE_MODE_CONFIG,
  STANDALONE_CODE_MODE_TOOL_NAMES,
  registerStandaloneCodeMode,
  standaloneCodeModeActiveTools,
  type StandaloneCodeMode,
} from "./standalone.ts";
export { default as codeModeExtension } from "./extension.ts";
