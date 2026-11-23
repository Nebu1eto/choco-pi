import {
  ExtensionRunner,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { arr, compile, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { isBoundaryValue, type BoundaryValue } from "../../adapter/runtime-values.ts";
import { toNestedTool } from "../../adapter/code-mode/nested-tool-adapter.ts";
import { enhanceCodeModeNestedToolError } from "./nested-tool-errors.ts";
import type { ProgrammaticCodeModeToolDefinition } from "./types.ts";

function withLiveCtx<Result>(action: () => Result): Result | undefined {
  try {
    return action();
  } catch (error) {
    if (isBoundaryValue(error) && isStaleContextError(error)) return undefined;
    throw error;
  }
}

type BridgedRunnerPrototype = typeof ExtensionRunner.prototype & {
  __chocoPiCodeModeToolBridgeVersion?: number;
  __chocoPiCodeModeToolBridgeRunners?: ExtensionRunner[] | undefined;
};

const BRIDGE_CAPTURE_VERSION = 1;

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

export type RegisteredToolSource = Pick<ExtensionRunner, "getAllRegisteredTools">;

function bridgedRunnerPrototype(): BridgedRunnerPrototype {
  // SAFETY: Both added properties are this module's bookkeeping on the SDK prototype.
  return ExtensionRunner.prototype as BridgedRunnerPrototype;
}

type RuntimeSessionManager = ExtensionContext["sessionManager"] | undefined;

function liveRunnerProbe(
  runner: ExtensionRunner,
): { sessionManager: RuntimeSessionManager } | undefined {
  return withLiveCtx(() => {
    const context = runner.createContext();
    context.isIdle();
    return { sessionManager: context.sessionManager };
  });
}

function pruneStaleRunners(runners: ExtensionRunner[]): void {
  for (let index = runners.length - 1; index >= 0; index -= 1) {
    const runner = runners[index];
    if (!runner || !liveRunnerProbe(runner)) runners.splice(index, 1);
  }
}

function rememberRunner(runner: ExtensionRunner): void {
  const runners = (bridgedRunnerPrototype().__chocoPiCodeModeToolBridgeRunners ??= []);
  pruneStaleRunners(runners);
  const existingIndex = runners.indexOf(runner);
  if (existingIndex !== -1) runners.splice(existingIndex, 1);
  runners.push(runner);
}

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

export function registeredToolRunner(ctx?: ExtensionContext): RegisteredToolSource | undefined {
  const runners = bridgedRunnerPrototype().__chocoPiCodeModeToolBridgeRunners ?? [];
  pruneStaleRunners(runners);
  const targetSessionManager = ctx ? withLiveCtx(() => ctx.sessionManager) : undefined;
  let newestLive: ExtensionRunner | undefined;
  for (let index = runners.length - 1; index >= 0; index -= 1) {
    const runner = runners[index];
    if (!runner) continue;
    const probe = liveRunnerProbe(runner);
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

const isToolParameters = compile(
  obj({ properties: opt(map(unknown())), required: opt(arr(str())) }, { open: true }),
).check;

const UsageNodeSchema = obj(
  {
    type: opt(str()),
    const: opt(unknown()),
    enum: opt(arr(unknown())),
    anyOf: opt(arr(unknown())),
    items: opt(unknown()),
    properties: opt(map(unknown())),
    required: opt(arr(str())),
  },
  { open: true },
);
const isUsageNode = compile(UsageNodeSchema).check;
const MAX_USAGE_LITERALS = 8;
const MAX_USAGE_DEPTH = 2;

type UsageNode = Static<typeof UsageNodeSchema>;

function parseUsageNode(candidate: BoundaryValue): UsageNode | undefined {
  return isUsageNode(candidate) ? candidate : undefined;
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

export function registeredToolNames(
  runner: RegisteredToolSource | undefined = registeredToolRunner(),
): string[] {
  if (!runner) return [];
  return runner
    .getAllRegisteredTools()
    .map(({ definition }) => definition.name)
    .sort((left, right) => left.localeCompare(right));
}

export function bridgedToolUsage(definition: ToolDefinition): string {
  const cached = usageCache.get(definition);
  if (cached && cached.parameters === definition.parameters) return cached.usage;
  const usage = computeBridgedToolUsage(definition);
  usageCache.set(definition, { parameters: definition.parameters, usage });
  return usage;
}

const usageCache = new WeakMap<
  ToolDefinition,
  { parameters: ToolDefinition["parameters"]; usage: string }
>();

function computeBridgedToolUsage(definition: ToolDefinition): string {
  const parameters = isToolParameters(definition.parameters) ? definition.parameters : undefined;
  const names = parameters?.properties ? Object.keys(parameters.properties) : [];
  if (names.length === 0) return "await tools." + definition.name + "()";
  const params = usageParams(parameters?.properties ?? {}, parameters?.required ?? [], 0);
  return "await tools." + definition.name + "({" + params + "})";
}

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
