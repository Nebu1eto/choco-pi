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
import { Type, type Static } from "typebox";
import { BoundaryValueSchema, type BoundaryValue } from "../../adapter/runtime-values.ts";
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
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "stop_subagent",
  "shell_start",
  "shell_read",
  "agent_browser",
  "tool_search",
]);

export const UI_TOOL_NAMES: ReadonlySet<string> = new Set([
  "find_roots",
  "observe_ui",
  "search_ui",
  "expand_ui",
  "inspect_ui",
  "act_ui",
  "read_text",
  "wait_for",
  "launch_browser",
  "navigate_browser",
  "evaluate_browser",
]);

const FALLBACK_SUMMARY_WORD_LIMIT = 12;

function fallbackToolSummary(description: string): string {
  const firstSentence = description.split(/(?<=[.!?])(?:\s|$)/, 1)[0]?.trim() ?? "";
  const words = firstSentence.split(/\s+/).filter(Boolean);
  if (words.length <= FALLBACK_SUMMARY_WORD_LIMIT) return words.join(" ");
  return words.slice(0, FALLBACK_SUMMARY_WORD_LIMIT).join(" ") + "…";
}

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

/**
 * The runner whose registry code mode must mirror.
 *
 * Every AgentSession — including each subagent's — builds its own
 * ExtensionRunner and lands in this shared capture list, and a child session
 * deliberately skips whole extensions (choco-pi-subagents returns early
 * there), so the newest live runner is not necessarily the calling session's.
 * Resolving by session identity keeps a root `exec` cell from mirroring a
 * subagent's narrower registry while background agents run, which otherwise
 * hides every orchestration tool from both the tools namespace and the
 * "outside code mode" hint. Without a ctx, with a ctx that has no session
 * manager, or when the caller's session never registered a runner, the newest
 * live runner remains the answer.
 */
export function registeredToolRunner(ctx?: ExtensionContext): RegisteredToolSource | undefined {
  const runners = bridgedRunnerPrototype().__chocoPiCodeModeToolBridgeRunners ?? [];
  const targetSessionManager = ctx ? withLiveCtx(() => ctx.sessionManager) : undefined;
  let newestLive: ExtensionRunner | undefined;
  for (let index = runners.length - 1; index >= 0; index -= 1) {
    const runner = runners[index];
    if (!runner) continue;
    const probe = withLiveCtx(() => {
      const context = runner.createContext();
      context.isIdle();
      return { sessionManager: context.sessionManager };
    });
    if (!probe) {
      runners.splice(index, 1);
      continue;
    }
    if (targetSessionManager !== undefined && probe.sessionManager === targetSessionManager)
      return runner;
    newestLive ??= runner;
  }
  return newestLive;
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
  properties: Type.Optional(Type.Record(Type.String(), BoundaryValueSchema)),
  required: Type.Optional(Type.Array(Type.String())),
});

/** The JSON Schema facets the usage line renders; everything else is opaque. */
const UsageNodeSchema = Type.Object({
  type: Type.Optional(Type.String()),
  const: Type.Optional(BoundaryValueSchema),
  enum: Type.Optional(Type.Array(BoundaryValueSchema)),
  anyOf: Type.Optional(Type.Array(BoundaryValueSchema)),
  items: Type.Optional(BoundaryValueSchema),
  properties: Type.Optional(Type.Record(Type.String(), BoundaryValueSchema)),
  required: Type.Optional(Type.Array(Type.String())),
});
const MAX_USAGE_LITERALS = 8;
const MAX_USAGE_DEPTH = 2;

/**
 * Render the shape a caller must produce: literal unions inline, arrays with their element
 * shape, and object unions by their discriminator key and values. Plain scalars stay as bare
 * names so the common case keeps its one-line form.
 */
type UsageNode = Static<typeof UsageNodeSchema>;

function parseUsageNode(candidate: BoundaryValue): UsageNode | undefined {
  return Value.Check(UsageNodeSchema, candidate) ? candidate : undefined;
}

function renderUsageValue(node: UsageNode, depth: number): string | undefined {
  const literals = (branches: readonly BoundaryValue[]): string[] | undefined => {
    const values: string[] = [];
    for (const candidate of branches) {
      const branch = parseUsageNode(candidate);
      if (!branch || branch.const === undefined) return undefined;
      values.push(JSON.stringify(branch.const));
    }
    return values;
  };
  const joinLiterals = (values: string[]): string =>
    values.length > MAX_USAGE_LITERALS
      ? values.slice(0, MAX_USAGE_LITERALS).join("|") + "|…"
      : values.join("|");
  if (node.enum) return joinLiterals(node.enum.map((value) => JSON.stringify(value)));
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.anyOf) {
    const flat = literals(node.anyOf);
    if (flat) return joinLiterals(flat);
    if (depth >= MAX_USAGE_DEPTH) return undefined;
    const discriminator = unionDiscriminator(node.anyOf);
    return discriminator ? "{" + discriminator + ", …}" : undefined;
  }
  if (node.type === "array") {
    const item = parseUsageNode(node.items);
    const element = item && depth < MAX_USAGE_DEPTH ? renderUsageValue(item, depth + 1) : undefined;
    return "[" + (element ?? "…") + "]";
  }
  if (node.type === "object" && node.properties && depth < MAX_USAGE_DEPTH) {
    return "{" + usageParams(node.properties, node.required ?? [], depth + 1) + "}";
  }
  return undefined;
}

/** `key:"a"|"b"` when every branch pins the same key to a literal; otherwise undefined. */
function unionDiscriminator(branches: readonly BoundaryValue[]): string | undefined {
  const values = new Map<string, string[]>();
  for (const candidate of branches) {
    const branch = parseUsageNode(candidate);
    if (!branch?.properties) return undefined;
    for (const [key, property] of Object.entries(branch.properties)) {
      const literal = parseUsageNode(property);
      if (!literal || literal.const === undefined) continue;
      const seen = values.get(key) ?? [];
      seen.push(JSON.stringify(literal.const));
      values.set(key, seen);
    }
  }
  for (const [key, seen] of values)
    if (seen.length === branches.length) return key + ":" + [...new Set(seen)].join("|");
  return undefined;
}

function usageParams(
  properties: Record<string, BoundaryValue>,
  required: readonly string[],
  depth: number,
): string {
  const requiredNames = new Set(required);
  return Object.entries(properties)
    .map(([name, property]) => {
      const label = requiredNames.has(name) ? name : name + "?";
      const node = parseUsageNode(property);
      const rendered = node ? renderUsageValue(node, depth) : undefined;
      return rendered ? label + ":" + rendered : label;
    })
    .join(", ");
}

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

/**
 * One compact call line, e.g. `await tools.symbol_search({query, limit?})` or
 * `await tools.harness_check({mode:"automatic"|"full", required_capabilities?:[…]})`.
 */
export function bridgedToolUsage(definition: ToolDefinition): string {
  const parameters = Value.Check(ToolParametersSchema, definition.parameters)
    ? definition.parameters
    : undefined;
  const names = parameters?.properties ? Object.keys(parameters.properties) : [];
  if (names.length === 0) return "await tools." + definition.name + "()";
  const params = usageParams(parameters?.properties ?? {}, parameters?.required ?? [], 0);
  return "await tools." + definition.name + "({" + params + "})";
}

/**
 * Wrap every registered tool the bridge may expose. Returns an empty list
 * until Pi has built its tool list once, so a cold start degrades to the
 * native tools rather than failing.
 */
export function collectBridgedTools(
  runner: RegisteredToolSource | undefined = registeredToolRunner(),
  hasUI = true,
): ProgrammaticCodeModeToolDefinition[] {
  if (!runner) return [];
  const bridged: ProgrammaticCodeModeToolDefinition[] = [];
  for (const registered of runner.getAllRegisteredTools()) {
    const definition = registered.definition;
    if (BRIDGE_EXCLUDED_TOOLS.has(definition.name)) continue;
    if (!hasUI && UI_TOOL_NAMES.has(definition.name)) continue;
    const nested = toNestedTool(
      definition,
      bridgedToolUsage(definition),
      {},
      {
        deferLoading: true,
        dispatch: "session",
      },
    );
    const toolName = definition.name;
    bridged.push({
      ...nested,
      summary: definition.promptSnippet?.trim() || fallbackToolSummary(definition.description),
      async invoke(input, context, signal) {
        const cwd = context.cwd;
        try {
          return await nested.invoke(input, context, signal);
        } catch (error) {
          const parsedError = error instanceof Error ? error : new Error(String(error));
          throw await enhanceCodeModeNestedToolError(toolName, input, parsedError, cwd);
        }
      },
    });
  }
  return bridged;
}
