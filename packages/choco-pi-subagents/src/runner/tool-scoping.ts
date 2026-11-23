import type {
  AgentSession,
  AgentSessionEvent,
  DefaultResourceLoader,
  ExtensionAPI,
  ExtensionFactory,
  LoadExtensionsResult,
  ResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createToolSearchToolDefinition } from "../../../../profile/extensions/lib/tool-search-tool.ts";
import { AGENT_MESSAGE_TOOL_NAME } from "../agent-message.ts";
import { BUILTIN_TOOL_NAMES } from "../agent-types.ts";
import {
  buildToolGuidance,
  READ_ONLY_SIDE_CONVERSATION_TOOLS,
  type ToolSurface,
} from "../prompts.ts";
import { SUBAGENT_STATUS_TOOL_NAME, SUBAGENT_TREE_TOOL_NAME } from "../subagent-tree.ts";
import { type HostValue, isHostObject, isString } from "../value-guards.ts";
import { extensionCanonicalNames } from "./extension-selection.ts";

export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
  STOP: "stop_subagent",
  SET_FAST: "set_subagent_fast_mode",
  SET_DAYBREAK: "set_subagent_daybreak",
  MESSAGE: AGENT_MESSAGE_TOOL_NAME,
  LIMITS: "subagent_limits",
  TREE: SUBAGENT_TREE_TOOL_NAME,
  STATUS: SUBAGENT_STATUS_TOOL_NAME,
} as const;

const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

const DISABLED_BUILTIN_TOOL_NAMES = new Set(["grep"]);

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(READ_ONLY_SIDE_CONVERSATION_TOOLS);

const CODE_MODE_TOOL_NAME = "exec";

const TOOL_SEARCH_TOOL_NAME = "tool_search";

const SEARCH_LOADED_EXPOSURES: ReadonlySet<string> = new Set(["deferred", "codemode"]);

export function predictChildToolSurface(input: {
  parentActiveTools: readonly string[];
  extensionsEnabled: boolean;
  toolNames: readonly string[];
  disallowedTools?: readonly string[] | undefined;
}): ToolSurface {
  const denied = new Set(input.disallowedTools ?? []);
  const allowed = input.toolNames.filter(
    (name) => !DISABLED_BUILTIN_TOOL_NAMES.has(name) && !denied.has(name),
  );
  if (!input.extensionsEnabled) return { codeMode: false, tools: allowed };
  const search = denied.has(TOOL_SEARCH_TOOL_NAME) ? [] : [TOOL_SEARCH_TOOL_NAME];
  if (input.parentActiveTools.includes(CODE_MODE_TOOL_NAME))
    return { codeMode: true, tools: ["exec", "wait", "exec_command", "apply_patch", ...search] };
  return { codeMode: false, tools: [...allowed, ...search] };
}

export function observedChildToolSurface(
  session: {
    getActiveToolNames(): string[];
    getAllTools(): ReadonlyArray<{ name: string }>;
  },
  isReachable?: (name: string) => boolean,
): ToolSurface {
  const active = session.getActiveToolNames();
  if (!active.includes(CODE_MODE_TOOL_NAME)) return { codeMode: false, tools: active };
  const callable = session
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => isReachable?.(name) ?? true);
  return { codeMode: true, tools: [...new Set([...active, ...callable])] };
}

export function sameToolGuidance(left: ToolSurface, right: ToolSurface): boolean {
  return buildToolGuidance(left).join("\n") === buildToolGuidance(right).join("\n");
}

export function withLiveSystemPrompt(
  inner: ResourceLoader,
  systemPrompt: () => string,
): ResourceLoader {
  return {
    getExtensions: () => inner.getExtensions(),
    getSkills: () => inner.getSkills(),
    getPrompts: () => inner.getPrompts(),
    getThemes: () => inner.getThemes(),
    getAgentsFiles: () => inner.getAgentsFiles(),
    getSystemPrompt: () => systemPrompt(),
    getSystemPromptSource: () => inner.getSystemPromptSource(),
    getAppendSystemPrompt: () => inner.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => inner.getAppendSystemPromptSources(),
    extendResources: (paths) => inner.extendResources(paths),
    reload: (reloadOptions) => inner.reload(reloadOptions),
  };
}

export function computeChildToolGate({
  noExtensions,
  toolNames,
  disallowedSet,
  nestedToolNames,
  alwaysToolNames,
}: {
  noExtensions: boolean;
  toolNames: string[];
  disallowedSet: Set<string> | undefined;
  nestedToolNames: Set<string>;
  alwaysToolNames: Set<string>;
}) {
  if (noExtensions) {
    return {
      sessionTools: [
        ...toolNames.filter(
          (name) =>
            !EXCLUDED_TOOL_NAMES.includes(name) &&
            !DISABLED_BUILTIN_TOOL_NAMES.has(name) &&
            !disallowedSet?.has(name),
        ),
        ...[...alwaysToolNames].filter((name) => !DISABLED_BUILTIN_TOOL_NAMES.has(name)),
        ...[...nestedToolNames].filter(
          (name) => !DISABLED_BUILTIN_TOOL_NAMES.has(name) && !disallowedSet?.has(name),
        ),
      ],
    };
  }

  const builtinToolNameSet = new Set(toolNames);
  const denyTools = new Set<string>(
    EXCLUDED_TOOL_NAMES.filter((name) => !nestedToolNames.has(name) && !alwaysToolNames.has(name)),
  );
  for (const name of BUILTIN_TOOL_NAMES) {
    if (!builtinToolNameSet.has(name)) denyTools.add(name);
  }
  if (disallowedSet) {
    for (const name of disallowedSet) {
      if (!alwaysToolNames.has(name)) denyTools.add(name);
    }
  }
  for (const name of DISABLED_BUILTIN_TOOL_NAMES) denyTools.add(name);
  return { sessionExcludeTools: [...denyTools] };
}

const LEAN_SURFACE_SYMBOL = Symbol.for("choco-pi.tool-search.lean-surface");

interface LeanSurfaceRegistry {
  [LEAN_SURFACE_SYMBOL]?: { alwaysActive?: () => readonly string[] };
}

function leanSurfaceNames(): Set<string> | undefined {
  try {
    // SAFETY: The registry slot is optional in this declaration, so an absent
    const registry = globalThis as typeof globalThis & LeanSurfaceRegistry;
    const names = registry[LEAN_SURFACE_SYMBOL]?.alwaysActive?.();
    if (!Array.isArray(names) || names.length === 0) return undefined;
    return new Set(names);
  } catch {
    return undefined;
  }
}

export interface ChildToolScopeSlot {
  isReachable?: (name: string) => boolean;
  searchLoaded: Set<string>;
}

export function createChildToolSearchExtension(
  isReachable: (name: string) => boolean,
  onActivate?: (names: readonly string[]) => void,
  readOnly = false,
): ExtensionFactory {
  return (childPi) => {
    const host = reachableToolsView(childPi, isReachable);
    childPi.registerTool(
      createToolSearchToolDefinition(onActivate === undefined ? { host } : { host, onActivate }),
    );
    childPi.on(
      "tool_call",
      (event) =>
        (readOnly ? readOnlyToolCallBlock(event.toolName, event.input) : undefined) ??
        blockUnreachableToolCall(isReachable, event.toolName),
    );
  };
}

export const READ_ONLY_DENIED_TOOL_NAMES: readonly string[] = ["ast_grep_replace"];

const LSP_MUTATING_OPERATIONS: ReadonlySet<string> = new Set([
  "rename",
  "renamefile",
  "codeaction",
  "executecommand",
]);

export interface ToolCallBlock {
  block: true;
  reason: string;
}

function operationField(input: HostValue): string | undefined {
  if (!isHostObject(input) || !("operation" in input)) return undefined;
  return isString(input.operation) ? input.operation : undefined;
}

function dispositionField(input: HostValue): string | undefined {
  if (!isHostObject(input) || !("disposition" in input)) return undefined;
  return isString(input.disposition) ? input.disposition : undefined;
}

function operationKey(operation: string | undefined): string {
  return (operation ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function requestsApply(input: HostValue): boolean {
  if (!isHostObject(input) || !("apply" in input)) return false;
  return input.apply !== undefined && input.apply !== null && input.apply !== false;
}

function readOnlyBlock(label: string): ToolCallBlock {
  return { block: true, reason: `read-only agent: ${label} can change files` };
}

export function readOnlyToolCallBlock(
  toolName: string,
  input: HostValue,
): ToolCallBlock | undefined {
  if (READ_ONLY_DENIED_TOOL_NAMES.includes(toolName)) return readOnlyBlock(toolName);
  if (toolName === "lsp_navigation") {
    const operation = operationField(input);
    if (LSP_MUTATING_OPERATIONS.has(operationKey(operation)) || requestsApply(input)) {
      return readOnlyBlock(`lsp_navigation/${operation ?? "unknown"}`);
    }
    return undefined;
  }
  if (toolName === "diagnostic_mark" && operationKey(dispositionField(input)) === "suppress") {
    return readOnlyBlock("diagnostic_mark/suppress");
  }
  return undefined;
}

export function lacksFileMutationTools(
  toolNames: readonly string[],
  disallowed: ReadonlySet<string> | undefined,
): boolean {
  const has = (name: string) => toolNames.includes(name) && disallowed?.has(name) !== true;
  return !has("edit") && !has("write");
}

function reachableToolsView(
  childPi: ExtensionAPI,
  isReachable: (name: string) => boolean,
): ExtensionAPI {
  return {
    ...childPi,
    getAllTools: () => childPi.getAllTools().filter((tool) => isReachable(tool.name)),
  };
}

function blockUnreachableToolCall(
  isReachable: (name: string) => boolean,
  toolName: string,
): { block: true; reason: string } | undefined {
  return isReachable(toolName)
    ? undefined
    : { block: true, reason: `Tool "${toolName}" is not available to this subagent.` };
}

const TOOL_SCOPE_SYMBOL = Symbol.for("choco-pi.tool-scope.v1");

type ToolScopeOwner = Pick<SessionManager, "getSessionId">;

type ToolCallGuard = (name: string, input: HostValue) => string | undefined;

interface ToolScopeRegistry {
  isToolAllowed(sessionManager: ToolScopeOwner, name: string): boolean;
  restrict(sessionManager: ToolScopeOwner, allows: (name: string) => boolean): void;
  guardToolCalls?(sessionManager: ToolScopeOwner, guard: ToolCallGuard): void;
  toolCallBlock?(
    sessionManager: ToolScopeOwner,
    name: string,
    input: HostValue,
  ): string | undefined;
}

interface ToolScopeRegistryCandidate {
  isToolAllowed?: HostValue;
  restrict?: HostValue;
}

function isToolScopeRegistry(value: HostValue): value is ToolScopeRegistry {
  if (!isHostObject(value)) return false;
  const candidate: ToolScopeRegistryCandidate = value;
  return candidate.isToolAllowed instanceof Function && candidate.restrict instanceof Function;
}

function withCallGuards(registry: ToolScopeRegistry): Required<ToolScopeRegistry> {
  const guardToolCalls = registry.guardToolCalls;
  const toolCallBlock = registry.toolCallBlock;
  if (guardToolCalls instanceof Function && toolCallBlock instanceof Function) {
    return { ...registry, guardToolCalls, toolCallBlock };
  }
  const guards = new WeakMap<ToolScopeOwner, ToolCallGuard>();
  registry.guardToolCalls = (sessionManager, guard) => {
    guards.set(sessionManager, guard);
  };
  registry.toolCallBlock = (sessionManager, name, input) =>
    guards.get(sessionManager)?.(name, input);
  return {
    ...registry,
    guardToolCalls: registry.guardToolCalls,
    toolCallBlock: registry.toolCallBlock,
  };
}

function toolScopeRegistry(): Required<ToolScopeRegistry> {
  const existing: HostValue = Object.getOwnPropertyDescriptor(globalThis, TOOL_SCOPE_SYMBOL)?.value;
  if (isToolScopeRegistry(existing)) return withCallGuards(existing);
  const scopes = new WeakMap<ToolScopeOwner, (name: string) => boolean>();
  const registry: ToolScopeRegistry = {
    isToolAllowed: (sessionManager, name) => scopes.get(sessionManager)?.(name) ?? true,
    restrict: (sessionManager, allows) => {
      scopes.set(sessionManager, allows);
    },
  };
  Object.defineProperty(globalThis, TOOL_SCOPE_SYMBOL, {
    configurable: true,
    writable: true,
    value: registry,
  });
  return withCallGuards(registry);
}

export function restrictSessionToolScope(
  sessionManager: ToolScopeOwner,
  allows: (name: string) => boolean,
): void {
  toolScopeRegistry().restrict(sessionManager, allows);
}

export function guardSessionReadOnlyToolCalls(sessionManager: ToolScopeOwner): void {
  toolScopeRegistry().guardToolCalls(
    sessionManager,
    (name, input) => readOnlyToolCallBlock(name, input)?.reason,
  );
}

interface ToolScopeInputs {
  loader: DefaultResourceLoader;
  toolNames: string[];
  disallowedSet: Set<string> | undefined;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  nestedToolNames: Set<string>;
  alwaysToolNames: Set<string>;
  leanAllows: (name: string) => boolean;
}

type LoadedExtension = LoadExtensionsResult["extensions"][number];

function toolScopeNames(scope: ToolScopeInputs, options: { applyLean: boolean }): Set<string> {
  const { toolNames, disallowedSet, nestedToolNames, alwaysToolNames } = scope;
  const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
  for (const extension of scope.loader.getExtensions().extensions) {
    addExtensionScopeTools(keep, extension, scope, options);
  }
  if (!disallowedSet?.has(TOOL_SEARCH_TOOL_NAME)) keep.add(TOOL_SEARCH_TOOL_NAME);
  for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
  for (const name of nestedToolNames) {
    if (!disallowedSet?.has(name)) keep.add(name);
  }
  for (const name of alwaysToolNames) keep.add(name);
  for (const name of DISABLED_BUILTIN_TOOL_NAMES) keep.delete(name);
  return keep;
}

function addExtensionScopeTools(
  keep: Set<string>,
  extension: LoadedExtension,
  scope: ToolScopeInputs,
  options: { applyLean: boolean },
): void {
  const { toolNames, disallowedSet, extNames, narrowing, leanAllows } = scope;
  const canons = extensionCanonicalNames(extension.path);
  const optInActive = extNames.size > 0;
  if (optInActive && !canons.some((c) => extNames.has(c))) return;
  const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
  for (const name of extension.tools.keys()) {
    if (narrowed && !narrowed.has(name)) continue;
    if (disallowedSet?.has(name)) continue;
    if (
      options.applyLean &&
      !toolNames.includes(name) &&
      narrowed?.has(name) !== true &&
      !leanAllows(name)
    )
      continue;
    keep.add(name);
  }
}

export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    nestedToolNames: Set<string>;
    alwaysToolNames: Set<string>;
    searchLoaded?: ReadonlySet<string>;
  },
): (name: string) => boolean {
  const lean = leanSurfaceNames();
  const scope: ToolScopeInputs = {
    ...ctx,
    leanAllows: (name) => lean === undefined || lean.has(name),
  };
  const inScope = (): Set<string> => toolScopeNames(scope, { applyLean: true });
  const reachable = (): Set<string> => toolScopeNames(scope, { applyLean: false });

  const offered = new Set<string>();
  const renarrow = () => {
    const allowed = inScope();
    const reach = reachable();
    const registered = session.getAllTools();
    const loadable = new Set(
      registered
        .filter((tool) => SEARCH_LOADED_EXPOSURES.has(tool.exposure) && reach.has(tool.name))
        .map((tool) => tool.name),
    );
    const current = session.getActiveToolNames();
    const searched = ctx.searchLoaded;
    const kept = current.filter(
      (n) => allowed.has(n) || loadable.has(n) || (searched?.has(n) === true && reach.has(n)),
    );
    const keptSet = new Set(kept);
    const inScopeNames = registered.map((t) => t.name).filter((n) => allowed.has(n));
    const next = [...kept, ...inScopeNames.filter((n) => !keptSet.has(n) && !offered.has(n))];
    for (const name of inScopeNames) offered.add(name);
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (!reachable().has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };

  return (name) => reachable().has(name);
}
