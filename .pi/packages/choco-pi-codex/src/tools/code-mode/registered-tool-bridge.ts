/**
 * registered-tool-bridge.ts — Expose Pi-registered tools inside code mode.
 *
 * Code mode ships the Codex-native tools (apply_patch, exec_command, ...) in
 * its tools namespace; everything else choco-pi registers — LSP navigation,
 * the MCP gateway, sub-agent and session control, goals, web access — was
 * reachable only as a separate tool call outside exec, so a script could not
 * compose them.
 *
 * Pi hands extensions tool schemas (pi.getAllTools) but not executable
 * definitions, and no event carries the live session. The runner does own
 * them, so this module patches ExtensionRunner.prototype the same way
 * .pi/extensions/command-filter.ts does, captures the live instance the first
 * time Pi assembles its tool list, and wraps each definition as a code-mode
 * tool.
 *
 * Bridged tools are deferred: they cost no prompt tokens, appear in ALL_TOOLS
 * for discovery, and run through the same nested-tool preflight as the native
 * ones.
 */

import { ExtensionRunner, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { toNestedTool } from "../../adapter/code-mode/nested-tool-adapter.ts";
import type { ProgrammaticCodeModeToolDefinition } from "./types.ts";

type BridgedRunnerPrototype = typeof ExtensionRunner.prototype & {
  __chocoPiCodeModeToolBridgeApplied?: boolean;
};

/**
 * Names code mode must never bridge: its own entry points (recursion) and the
 * Codex-native tools it already exposes with hand-written usage lines.
 */
export const BRIDGE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "exec",
  "wait",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "view_image",
  "web__run",
  "web_run",
  "image_gen__imagegen",
]);

/** The single runner method the bridge needs; keeps fakes and tests honest. */
export type RegisteredToolSource = Pick<ExtensionRunner, "getAllRegisteredTools">;

let capturedRunner: RegisteredToolSource | undefined;

function rememberRunner(runner: RegisteredToolSource): void {
  capturedRunner = runner;
}

/** Install the capture patch once per process. */
export function installRegisteredToolCapture(): void {
  // SAFETY: the marker property is this module's own bookkeeping on the SDK prototype.
  const prototype = ExtensionRunner.prototype as BridgedRunnerPrototype;
  if (prototype.__chocoPiCodeModeToolBridgeApplied) return;
  const getAllRegisteredTools = prototype.getAllRegisteredTools;
  prototype.getAllRegisteredTools = function captureRegisteredTools(this: ExtensionRunner) {
    rememberRunner(this);
    return getAllRegisteredTools.call(this);
  };
  prototype.__chocoPiCodeModeToolBridgeApplied = true;
}

/** The live runner, once Pi has assembled its tool list at least once. */
export function registeredToolRunner(): RegisteredToolSource | undefined {
  return capturedRunner;
}

/** Test seam: forget the captured runner. */
export function resetRegisteredToolCapture(): void {
  capturedRunner = undefined;
}

const ToolParametersSchema = Type.Object({
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  required: Type.Optional(Type.Array(Type.String())),
});

/** One compact call line, e.g. await tools.symbol_search({query, limit?}). */
export function bridgedToolUsage(definition: ToolDefinition): string {
  const parameters = Value.Check(ToolParametersSchema, definition.parameters)
    ? definition.parameters
    : undefined;
  const names = parameters?.properties ? Object.keys(parameters.properties) : [];
  if (names.length === 0) return "await tools." + definition.name + "()";
  const requiredNames = new Set(parameters?.required ?? []);
  const params = names.map((name) => (requiredNames.has(name) ? name : name + "?")).join(", ");
  return "await tools." + definition.name + "({" + params + "})";
}

/**
 * Wrap every registered tool the bridge may expose. Returns an empty list
 * until Pi has built its tool list once, so a cold start degrades to the
 * native tools rather than failing.
 */
export function collectBridgedTools(
  runner: RegisteredToolSource | undefined = capturedRunner,
): ProgrammaticCodeModeToolDefinition[] {
  if (!runner) return [];
  const bridged: ProgrammaticCodeModeToolDefinition[] = [];
  for (const registered of runner.getAllRegisteredTools()) {
    const definition = registered.definition;
    if (BRIDGE_EXCLUDED_TOOLS.has(definition.name)) continue;
    bridged.push(
      toNestedTool(definition, bridgedToolUsage(definition), {}, { deferLoading: true }),
    );
  }
  return bridged;
}
