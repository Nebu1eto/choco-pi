/**
 * tool-scoping.ts — Child tool surface prediction/observation, registry gating, read-only guards, and live extension tool scoping.
 */

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

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
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

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/** Pi built-ins intentionally unavailable in every choco-pi child session. */
const DISABLED_BUILTIN_TOOL_NAMES = new Set(["grep"]);

/** Built-ins available to read-only side conversations. No shell or write path. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(READ_ONLY_SIDE_CONVERSATION_TOOLS);

/** The Code Mode entry point; an active one means the child runs in Code Mode. */
const CODE_MODE_TOOL_NAME = "exec";

/** choco-pi's discovery tool, registered in every extension-enabled child. */
const TOOL_SEARCH_TOOL_NAME = "tool_search";

/** Exposures only `tool_search` can activate; an active one was loaded by a search. */
const SEARCH_LOADED_EXPOSURES: ReadonlySet<string> = new Set(["deferred", "codemode"]);

/**
 * The tool surface a child is expected to start with, for the prompt composed
 * before its extensions bind. A child with extensions inherits the parent's
 * mode: the Codex adapter decides Code Mode from the same configuration for
 * both. In Code Mode the adapter ships exec_command and apply_patch inside exec.
 * {@link observedChildToolSurface} replaces the prediction once binding is done.
 */
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

/**
 * The tool surface a bound child actually has: its active tools and, in Code
 * Mode, every registered tool it may reach, since those are callable in exec.
 */
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

/** Whether two surfaces produce the same sub-agent guidance text. */
export function sameToolGuidance(left: ToolSurface, right: ToolSurface): boolean {
  return buildToolGuidance(left).join("\n") === buildToolGuidance(right).join("\n");
}

/**
 * `inner` with a system prompt read on every call. DefaultResourceLoader
 * computes its prompt once, at reload; a child's guidance can change after its
 * extensions bind, and Pi re-reads the loader whenever it rebuilds the prompt.
 */
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

/**
 * The lean tool surface choco-pi's `tool-search` extension publishes.
 *
 * A sub-agent used to start with every tool its loaded extensions register —
 * probe evidence put child sessions at 78-83 tool schemas against the main
 * agent's 22-28 — so each one carried the whole catalog in its cached prefix
 * for the life of the task. Sub-agents now start from the same always-active
 * set as the main agent and reach the rest through `tool_search`.
 *
 * Matched over `Symbol.for` because a package must not import the profile.
 * When the extension is absent the policy is undefined and scope falls back to
 * the previous behavior, so this package still runs standalone.
 */
const LEAN_SURFACE_SYMBOL = Symbol.for("choco-pi.tool-search.lean-surface");

interface LeanSurfaceRegistry {
  [LEAN_SURFACE_SYMBOL]?: { alwaysActive?: () => readonly string[] };
}

function leanSurfaceNames(): Set<string> | undefined {
  try {
    // SAFETY: The registry slot is optional in this declaration, so an absent
    // publisher yields undefined; a publisher that throws is caught below.
    const registry = globalThis as typeof globalThis & LeanSurfaceRegistry;
    const names = registry[LEAN_SURFACE_SYMBOL]?.alwaysActive?.();
    if (!Array.isArray(names) || names.length === 0) return undefined;
    return new Set(names);
  } catch {
    return undefined;
  }
}

/** Late-bound reachability of one child, filled after its scope is installed. */
export interface ChildToolScopeSlot {
  isReachable?: (name: string) => boolean;
  /** Tools the child's `tool_search` activated; the scope keeps them while reachable. */
  searchLoaded: Set<string>;
}

/**
 * choco-pi's `tool_search`, seeing only the tools this child may reach.
 *
 * Outside Code Mode it activates matching inactive tools, including `direct`
 * tools the lean surface withholds, and reports them through `onActivate` so
 * the scope keeps them; in Code Mode it only lists the tools callable inside
 * `exec`. Handing it a view whose `getAllTools()` is filtered by the child's
 * scope keeps a search from naming, let alone loading, a tool the child was
 * denied. The same predicate blocks every `tool_call` outside the scope, which
 * also covers calls other tools issue through `ctx.executeTool()`
 * (`parentToolCallId` set); `agent.beforeToolCall` never sees those. The root
 * `tool-search.ts` registers nothing while a child loads, so this is the
 * child's only `tool_search`.
 *
 * `isReachable` must fail closed until the scope is installed.
 */
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

/**
 * Extension tools a child without `edit` and `write` may never reach: every
 * call can change files. Added to that child's `disallowedTools`, so the
 * registry drops them and no tool bridge can run them directly either.
 */
export const READ_ONLY_DENIED_TOOL_NAMES: readonly string[] = ["ast_grep_replace"];

/** `lsp_navigation` operations that can change files or run server commands. */
const LSP_MUTATING_OPERATIONS: ReadonlySet<string> = new Set([
  "rename",
  "renamefile",
  "codeaction",
  "executecommand",
]);

/** A `tool_call` handler result that refuses the call. */
export interface ToolCallBlock {
  block: true;
  reason: string;
}

/** The `lsp_navigation` `operation` argument, or undefined when absent or not a string. */
function operationField(input: HostValue): string | undefined {
  if (!isHostObject(input) || !("operation" in input)) return undefined;
  return isString(input.operation) ? input.operation : undefined;
}

/** The `diagnostic_mark` `disposition` argument, or undefined when absent or not a string. */
function dispositionField(input: HostValue): string | undefined {
  if (!isHostObject(input) || !("disposition" in input)) return undefined;
  return isString(input.disposition) ? input.disposition : undefined;
}

/** Operation spelling-insensitive: `rename_file`, `renameFile` and `"rename_file"` match. */
function operationKey(operation: string | undefined): string {
  return (operation ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/** `apply` asks for a real change unless it is absent, null, or exactly false. */
function requestsApply(input: HostValue): boolean {
  if (!isHostObject(input) || !("apply" in input)) return false;
  return input.apply !== undefined && input.apply !== null && input.apply !== false;
}

/** `<tool>/<operation>` label for the block reason. */
function readOnlyBlock(label: string): ToolCallBlock {
  return { block: true, reason: `read-only agent: ${label} can change files` };
}

/**
 * The `tool_call` guard for a child whose effective tools exclude both `edit`
 * and `write`. Narrowing by `ext:` selectors is per tool, but
 * `lsp_navigation` and `diagnostic_mark` mix reads with file mutations, so
 * the mutating operations are refused here per call; read operations pass.
 *
 * Covers model-issued calls and nested `ctx.executeTool()` calls (code-mode
 * `exec` when the target tool is session-callable). A bridge that runs a
 * tool's `execute()` directly never reaches this hook.
 */
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
    // `suppress` writes an inline ignore comment into the source file.
    return readOnlyBlock("diagnostic_mark/suppress");
  }
  return undefined;
}

/** Whether a child's effective built-in tools exclude both `edit` and `write`. */
export function lacksFileMutationTools(
  toolNames: readonly string[],
  disallowed: ReadonlySet<string> | undefined,
): boolean {
  const has = (name: string) => toolNames.includes(name) && disallowed?.has(name) !== true;
  return !has("edit") && !has("write");
}

/**
 * Pi's ExtensionAPI members are closures over the extension, so a copy with
 * one replaced member registers and activates exactly like the original.
 */
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

/**
 * Per-session tool scopes for tool bridges that can run a registered tool
 * without Pi's hooks (choco-pi-codex's exec bridge falls back to a direct
 * `execute()` for tools `ctx.executeTool()` cannot reach). Keyed by the
 * session's SessionManager, which is the object `ctx.sessionManager` returns
 * inside that session. A session without a scope is unrestricted.
 *
 * Matched over `Symbol.for` because a package must not import another; the
 * consumer types this boundary independently. Do not rename the symbol.
 */
const TOOL_SCOPE_SYMBOL = Symbol.for("choco-pi.tool-scope.v1");

/** The session identity a scope is keyed by: the session's own SessionManager. */
type ToolScopeOwner = Pick<SessionManager, "getSessionId">;

/**
 * Per-call decision for a session: the refusal reason, or undefined to allow.
 * Bridges that run a tool without Pi's `tool_call` hooks consult it so the
 * child's call guard applies on every path.
 */
type ToolCallGuard = (name: string, input: HostValue) => string | undefined;

interface ToolScopeRegistry {
  isToolAllowed(sessionManager: ToolScopeOwner, name: string): boolean;
  restrict(sessionManager: ToolScopeOwner, allows: (name: string) => boolean): void;
  /** Install the per-call guard for a session (optional: older registries lack it). */
  guardToolCalls?(sessionManager: ToolScopeOwner, guard: ToolCallGuard): void;
  /** The session guard's refusal reason for this call, or undefined to allow. */
  toolCallBlock?(
    sessionManager: ToolScopeOwner,
    name: string,
    input: HostValue,
  ): string | undefined;
}

/** Members of a registry found on `globalThis`, unvalidated until checked. */
interface ToolScopeRegistryCandidate {
  isToolAllowed?: HostValue;
  restrict?: HostValue;
}

/** Structural check of a published registry: an object with both callable members. */
function isToolScopeRegistry(value: HostValue): value is ToolScopeRegistry {
  if (!isHostObject(value)) return false;
  const candidate: ToolScopeRegistryCandidate = value;
  return candidate.isToolAllowed instanceof Function && candidate.restrict instanceof Function;
}

/** Give a registry the call-guard members when it predates them. */
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

/** Restrict what tool bridges may run inside the session owning `sessionManager`. */
export function restrictSessionToolScope(
  sessionManager: ToolScopeOwner,
  allows: (name: string) => boolean,
): void {
  toolScopeRegistry().restrict(sessionManager, allows);
}

/**
 * Refuse file-changing calls in a read-only child on every bridge path. The
 * guard is {@link readOnlyToolCallBlock}, the same decision the child's
 * `tool_call` hook makes, published through the tool-scope seam so a bridge
 * that runs `execute()` directly (no hooks) refuses the same calls.
 */
export function guardSessionReadOnlyToolCalls(sessionManager: ToolScopeOwner): void {
  toolScopeRegistry().guardToolCalls(
    sessionManager,
    (name, input) => readOnlyToolCallBlock(name, input)?.reason,
  );
}

/** Inputs to the two tool scopes `installExtensionToolScope` derives on demand. */
interface ToolScopeInputs {
  loader: DefaultResourceLoader;
  toolNames: string[];
  disallowedSet: Set<string> | undefined;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  nestedToolNames: Set<string>;
  alwaysToolNames: Set<string>;
  /** The lean surface, read once when the scope is installed. */
  leanAllows: (name: string) => boolean;
}

type LoadedExtension = LoadExtensionsResult["extensions"][number];

/**
 * The names allowed right now. Mirrors the `ext:` opt-in flip: when any `ext:`
 * selector is present, extension tools become an explicit allowlist — a loaded
 * extension not named by a selector contributes nothing (its handlers still ran),
 * and `ext:foo/bar` narrows `foo` to just `bar`.
 *
 * `applyLean` separates the two scopes: with it, the names active without a
 * search (the lean surface); without it, every name this child may reach at
 * all, through `tool_search` or a tool bridge. Both honor `ext:` narrowing
 * and `disallowedTools`; only the lean surface is optional.
 */
function toolScopeNames(scope: ToolScopeInputs, options: { applyLean: boolean }): Set<string> {
  const { toolNames, disallowedSet, nestedToolNames, alwaysToolNames } = scope;
  const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
  for (const extension of scope.loader.getExtensions().extensions) {
    addExtensionScopeTools(keep, extension, scope, options);
  }
  // Discovery grants nothing by itself: the child's search sees only reachable tools.
  if (!disallowedSet?.has(TOOL_SEARCH_TOOL_NAME)) keep.add(TOOL_SEARCH_TOOL_NAME);
  for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
  // Opt-in nested delegation tools share EXCLUDED_TOOL_NAMES' names but are
  // legitimately active for this agent — re-admit them so the renarrow keeps
  // them in the active set and beforeToolCall doesn't block them.
  for (const name of nestedToolNames) {
    if (!disallowedSet?.has(name)) keep.add(name);
  }
  for (const name of alwaysToolNames) keep.add(name);
  for (const name of DISABLED_BUILTIN_TOOL_NAMES) keep.delete(name);
  return keep;
}

/** Add the tools one loaded extension contributes to a scope. */
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
  // First alias that carries a narrowing set — a user won't narrow one
  // extension under two different names, so first-match is correct.
  const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
  for (const name of extension.tools.keys()) {
    if (narrowed && !narrowed.has(name)) continue;
    if (disallowedSet?.has(name)) continue;
    // An explicitly configured tool name stays available; the lean surface
    // only gates what an extension contributes on its own.
    // A tool named by an `ext:<extension>/<tool>` selector is configured just as
    // explicitly, so it is active from turn 1 even when the extension registered
    // it inactive (choco-pi-lsp's situational tools) or the lean surface omits it.
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

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. `registerTool` writes into the very `extension.tools` maps this reads,
 * so `inScope()` sees late arrivals on the next call.
 *
 * Two enforcement points, because neither covers the whole picture:
 *
 *   - `turn_end` re-narrows the ACTIVE set. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks out-of-scope calls. Turn 1 cannot be narrowed at all:
 *     `before_agent_start` fires INSIDE `prompt()` and may widen the tool set, but
 *     `createContextSnapshot()` freezes that turn's tools immediately after — there
 *     is no hook in between. A call-time check is the only correct guard there.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Only meaningful when extensions are loaded — under `noExtensions`/`isolated` the
 * static `allowedToolNames` allowlist already gates the registry itself.
 *
 * Returns the live reachability predicate: the scope without the lean surface,
 * which `tool_search`, the `tool_call` guard, and tool bridges enforce.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    /** Opt-in nested-delegation tool names to keep active despite the EXCLUDED strip. */
    nestedToolNames: Set<string>;
    /** Tree messaging is always available, regardless of depth or frontmatter tool denies. */
    alwaysToolNames: Set<string>;
    /** Tools the child's `tool_search` activated; kept active while reachable. */
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

  // Keep the current order and append newcomers, so a tool `tool_search` loaded
  // stays where Pi put it instead of being re-sorted into registry order.
  // A loaded `deferred`/`codemode` tool survives only while it stays reachable.
  //
  // A name is offered once, the first time it is registered and in scope. Appending
  // every in-scope name on each turn would restore the tools another extension
  // deactivated on purpose: the Codex adapter hides the direct tools Code Mode
  // replaces, and the next `turn_end` used to put them back.
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
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  // Activate what registered during session_start (eager MCP servers); pi would
  // otherwise leave only its four default built-ins active at turn 1.
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
