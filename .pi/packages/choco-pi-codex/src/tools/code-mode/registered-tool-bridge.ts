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

import {
  ExtensionRunner,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { toNestedTool } from "../../adapter/code-mode/nested-tool-adapter.ts";
import { withLiveCtx } from "../../extension/live-context.ts";
import { enhanceCodeModeNestedToolError } from "./nested-tool-errors.ts";
import type { ProgrammaticCodeModeToolDefinition } from "./types.ts";

type BridgedRunnerPrototype = typeof ExtensionRunner.prototype & {
  __chocoPiCodeModeToolBridgeVersion?: number;
  __chocoPiCodeModeToolBridgeRunners?: ExtensionRunner[] | undefined;
};

const BRIDGE_CAPTURE_VERSION = 1;

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

function bridgedRunnerPrototype(): BridgedRunnerPrototype {
  // SAFETY: Both added properties are this module's bookkeeping on the SDK prototype.
  return ExtensionRunner.prototype as BridgedRunnerPrototype;
}

function rememberRunner(runner: ExtensionRunner): void {
  const runners = (bridgedRunnerPrototype().__chocoPiCodeModeToolBridgeRunners ??= []);
  const existingIndex = runners.indexOf(runner);
  if (existingIndex !== -1) runners.splice(existingIndex, 1);
  runners.push(runner);
}

/** Install the capture patch once per process. */
export function installRegisteredToolCapture(): void {
  const prototype = bridgedRunnerPrototype();
  if (prototype.__chocoPiCodeModeToolBridgeVersion === BRIDGE_CAPTURE_VERSION) return;
  const getAllRegisteredTools = prototype.getAllRegisteredTools;
  prototype.getAllRegisteredTools = function captureRegisteredTools(this: ExtensionRunner) {
    rememberRunner(this);
    return getAllRegisteredTools.call(this);
  };
  prototype.__chocoPiCodeModeToolBridgeVersion = BRIDGE_CAPTURE_VERSION;
}

/** The live runner, once Pi has assembled its tool list at least once. */
export function registeredToolRunner(): RegisteredToolSource | undefined {
  const runners = bridgedRunnerPrototype().__chocoPiCodeModeToolBridgeRunners ?? [];
  for (let index = runners.length - 1; index >= 0; index -= 1) {
    const runner = runners[index];
    if (!runner) continue;
    const live = withLiveCtx(() => {
      runner.createContext().isIdle();
      return true;
    });
    if (live) return runner;
    runners.splice(index, 1);
  }
  return undefined;
}

/** Test seam: forget the captured runner. */
export function resetRegisteredToolCapture(ctx?: ExtensionContext): void {
  const runners = bridgedRunnerPrototype().__chocoPiCodeModeToolBridgeRunners ?? [];
  if (!ctx) {
    runners.length = 0;
    return;
  }
  const targetSessionManager = withLiveCtx(() => ctx.sessionManager);
  if (!targetSessionManager) return;
  for (let index = runners.length - 1; index >= 0; index -= 1) {
    const runner = runners[index];
    if (!runner) continue;
    const sessionManager = withLiveCtx(() => runner.createContext().sessionManager);
    if (!sessionManager || sessionManager === targetSessionManager) runners.splice(index, 1);
  }
}

const ToolParametersSchema = Type.Object({
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  required: Type.Optional(Type.Array(Type.String())),
});

/** All direct Pi tool names, including tools intentionally excluded from the bridge. */
export function registeredToolNames(
  runner: RegisteredToolSource | undefined = registeredToolRunner(),
): string[] {
  if (!runner) return [];
  return runner
    .getAllRegisteredTools()
    .map(({ definition }) => definition.name)
    .sort((left, right) => left.localeCompare(right));
}

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
  runner: RegisteredToolSource | undefined = registeredToolRunner(),
): ProgrammaticCodeModeToolDefinition[] {
  if (!runner) return [];
  const bridged: ProgrammaticCodeModeToolDefinition[] = [];
  for (const registered of runner.getAllRegisteredTools()) {
    const definition = registered.definition;
    if (BRIDGE_EXCLUDED_TOOLS.has(definition.name)) continue;
    const nested = toNestedTool(
      definition,
      bridgedToolUsage(definition),
      {},
      {
        deferLoading: true,
      },
    );
    const toolName = definition.name;
    bridged.push({
      ...nested,
      invoke(input, context, signal) {
        const cwd = context.cwd;
        return nested.invoke(input, context, signal).catch((error) => {
          const parsedError = error instanceof Error ? error : new Error(String(error));
          throw enhanceCodeModeNestedToolError(toolName, input, parsedError, cwd);
        });
      },
    });
  }
  return bridged;
}
