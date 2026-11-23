import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isJsonRecord } from "@choco-pi/shared/runtime-values";
import {
  registerScratchRoot,
  scratchChangedNotice,
  scratchDirForSession,
  scratchPromptLine,
  scratchRootFor,
  setPreviousScratchDir,
  unregisterScratchRoot,
} from "@choco-pi/shared/scratch-path";
import { createAgentMessageTool } from "../agent-message.ts";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getToolNamesForType,
} from "../agent-types.ts";
import { createChildCompactionBridge } from "../child-compaction-bridge.ts";
import {
  registerChildSessionId,
  runInChildSessionContext,
  unregisterChildSessionId,
} from "../child-context.ts";
import { buildParentContext } from "../context.ts";
import {
  createChildDaybreakExtension,
  reconcileChildDaybreak,
  type DaybreakSnapshot,
} from "../daybreak-bridge.ts";
import { DEFAULT_AGENTS } from "../default-agents.ts";
import { detectEnv } from "../env.ts";
import {
  createChildFastModeExtension,
  reconcileChildFastMode,
  type FastModeSnapshot,
} from "../fast-mode-bridge.ts";
import { registerSubagentStatusMessage } from "../limits.ts";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../memory.ts";
import {
  createNestedSubagentTools,
  getMaxSubagentDepth,
  type NestedAgentManager,
} from "../nested-tools.ts";
import {
  buildAgentPrompt,
  buildReadOnlySideConversationPrompt,
  type PromptExtras,
  type ToolSurface,
} from "../prompts.ts";
import { preloadSkills } from "../skill-loader.ts";
import type { AgentConfig, SubagentType, ThinkingLevel } from "../types.ts";
import { isString } from "../value-guards.ts";
import {
  extensionCanonicalNames,
  parseExtensionsSpec,
  parseExtSelectors,
  shouldKeepExtension,
  warmExtensionPackageNames,
} from "./extension-selection.ts";
import {
  type ChildToolScopeSlot,
  computeChildToolGate,
  createChildToolSearchExtension,
  guardSessionReadOnlyToolCalls,
  installExtensionToolScope,
  lacksFileMutationTools,
  observedChildToolSurface,
  predictChildToolSurface,
  READ_ONLY_DENIED_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  restrictSessionToolScope,
  sameToolGuidance,
  withLiveSystemPrompt,
} from "./tool-scoping.ts";
import { getRememberAgents } from "./turn-limit.ts";

interface ModelRegistryWithRuntime {
  runtime?: unknown;
}

export const SUBAGENT_SESSION_MARKER = "choco-pi:subagent";
export const SUBAGENT_SCRATCH_ENTRY = "choco-pi:scratch";

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface MainSessionFork {
  sessionManager: SessionManager;
  systemPrompt: string;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  capturedAt: number;
}

export interface RunOptions {
  onFinishAttempt?: () => { steer?: string; failure?: string } | undefined;
  pi: ExtensionAPI;
  createResourceLoader?: (
    loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0],
  ) => DefaultResourceLoader;
  agentId?: string;
  model?: Model<Api>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  mainSessionFork?: MainSessionFork;
  readOnly?: boolean;
  resumeSessionFile?: string;
  nested?: boolean;
  cwd?: string;
  worktreeBase?: string;
  configCwd?: string;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: {
    reason: "manual" | "threshold" | "overflow";
    tokensBefore: number;
  }) => void;
  nestedRuntime?: {
    manager: NestedAgentManager;
    parentAgentId: string;
    depth: number;
    maxSubagentDepth?: number;
  };
  fastMode?: FastModeSnapshot;
  fastModeGeneration?: number;
  daybreak?: DaybreakSnapshot;
  daybreakGeneration?: number;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  aborted: boolean;
  steered: boolean;
  failure?: string;
}

function fallbackAgentConfig(type: string): AgentConfig {
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
  return { ...fallback, name: type };
}

function parentActiveToolNames(pi: Pick<ExtensionAPI, "getActiveTools">): string[] {
  try {
    return pi.getActiveTools();
  } catch {
    return [];
  }
}

export function resolveDefaultModel(
  parentModel: Model<Api> | undefined,
  registry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getAvailable?(): Model<Api>[];
  },
  configModel?: string,
): Model<Api> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

export function captureMainSessionFork(ctx: ExtensionContext): MainSessionFork {
  const parent = ctx.sessionManager;
  const fork = SessionManager.inMemory(
    ctx.cwd,
    { parentSession: parent.getSessionFile?.() },
    parent.getBranch(),
  );

  return {
    sessionManager: fork,
    systemPrompt: ctx.getSystemPrompt(),
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
    capturedAt: Date.now(),
  };
}

export function buildEffectivePrompt(
  ctx: ExtensionContext,
  prompt: string,
  options: Pick<RunOptions, "inheritContext" | "mainSessionFork">,
): string {
  if (options.mainSessionFork) return prompt;
  if (!options.inheritContext) return prompt;
  const parentContext = buildParentContext(ctx);
  return parentContext ? parentContext + prompt : prompt;
}

function resolveConfiguredSessionDir(
  sessionDir: string | undefined,
  cwd: string,
): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/"))
    return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

export interface PreparedChildSession {
  session: AgentSession;
  childCompaction: ReturnType<typeof createChildCompactionBridge>;
  scratchNotice: string | undefined;
}

interface LoadedChildContext {
  agentConfig: AgentConfig | undefined;
  effectiveCwd: string;
  configCwd: string;
  effectiveMaxDepth: number;
  toolNames: string[];
  fileReadOnly: boolean;
  parentSessionId: string | undefined;
  scratchDir: string | undefined;
  agentDir: string;
  noExtensions: boolean;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  childToolScope: ChildToolScopeSlot;
  childCompaction: ReturnType<typeof createChildCompactionBridge>;
  loader: DefaultResourceLoader;
  toolSurface: ToolSurface;
  composePrompt: (surface: ToolSurface) => string;
  getSystemPrompt: () => string;
  setSystemPrompt: (value: string) => void;
}

export async function prepareAgentResourceLoader(
  ctx: ExtensionContext,
  type: SubagentType,
  options: RunOptions,
): Promise<LoadedChildContext> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  const effectiveCwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? effectiveCwd;
  const statusRuntime = options.nestedRuntime;
  const effectiveMaxDepth = statusRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  const subagentStatusSource = statusRuntime
    ? {
        getActiveCount: () => statusRuntime.manager.getActiveCount(),
        getScheduledActiveCount: () => statusRuntime.manager.getScheduledActiveCount(),
        getMaxConcurrent: () => statusRuntime.manager.getMaxConcurrent(),
        getMaxSubagentDepth: () => effectiveMaxDepth,
        depth: statusRuntime.depth,
      }
    : undefined;

  const extensions = options.isolated || options.readOnly ? false : config.extensions;
  const excludeExtensions =
    options.isolated || options.readOnly ? undefined : config.excludeExtensions;
  const skills = options.isolated ? false : config.skills;

  let toolNames = getToolNamesForType(type);
  if (options.readOnly) {
    toolNames = toolNames.filter((name) => READ_ONLY_TOOL_NAMES.has(name));
  }

  let memoryBlock: Promise<string> | undefined;
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  const fileReadOnly = lacksFileMutationTools(
    toolNames,
    agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined,
  );
  const [env, loadedSkills, loadedMemoryBlock] = await Promise.all([
    detectEnv(options.pi, effectiveCwd),
    Array.isArray(skills) ? preloadSkills(skills, configCwd) : undefined,
    memoryBlock,
  ]);

  const parentSystemPrompt = ctx.getSystemPrompt();

  const extras: PromptExtras = {};
  const parentSessionId = ctx.sessionManager?.getSessionId?.();
  const scratchDir = parentSessionId ? scratchDirForSession(parentSessionId) : undefined;
  if (parentSessionId) extras.scratchLine = scratchPromptLine(parentSessionId);
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.readOnly) extras.readOnly = true;
  if (loadedSkills !== undefined && loadedSkills.length > 0) extras.skillBlocks = loadedSkills;
  if (loadedMemoryBlock !== undefined) extras.memoryBlock = loadedMemoryBlock;

  const mainSessionFork = options.mainSessionFork;
  if (mainSessionFork && !options.readOnly)
    throw new Error("Main-session forks are restricted to read-only side conversations.");
  const promptConfig = mainSessionFork ? undefined : (agentConfig ?? fallbackAgentConfig(type));
  const composePrompt = (surface: ToolSurface): string =>
    promptConfig === undefined
      ? buildReadOnlySideConversationPrompt(options.mainSessionFork?.systemPrompt ?? "")
      : buildAgentPrompt(promptConfig, effectiveCwd, env, parentSystemPrompt, {
          ...extras,
          toolSurface: surface,
        });
  const toolSurface = predictChildToolSurface({
    parentActiveTools: parentActiveToolNames(options.pi),
    extensionsEnabled: extensions !== false,
    toolNames,
    disallowedTools: agentConfig?.disallowedTools,
  });
  let systemPrompt = composePrompt(toolSurface);

  const noSkills =
    options.mainSessionFork !== undefined || skills === false || Array.isArray(skills);
  const agentDir = getAgentDir();

  const { extNames, narrowing } = parseExtSelectors(
    options.isolated || options.readOnly ? [] : (agentConfig?.extSelectors ?? []),
  );
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  let discoveredNames: Set<string> | undefined;
  const keepExtension = (extension: { path: string }) =>
    shouldKeepExtension(extension.path, { loadAll, keepNames, excludeNames });
  let overrideBase: LoadExtensionsResult | undefined;
  let ownedExtensions: LoadExtensionsResult | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          overrideBase = base;
          discoveredNames = new Set(
            base.extensions.flatMap((e) => extensionCanonicalNames(e.path)),
          );
          ownedExtensions = { ...base, extensions: base.extensions.filter(keepExtension) };
          return ownedExtensions;
        };

  const childToolScope: ChildToolScopeSlot = { searchLoaded: new Set() };
  const childCompaction = createChildCompactionBridge({
    parentSessionId: ctx.sessionManager?.getSessionId?.(),
    mainSessionFork: options.mainSessionFork !== undefined,
    readOnly: options.readOnly === true,
    isolated: options.isolated === true,
    onError: (message) =>
      options.onToolActivity?.({ type: "end", toolName: `extension-error:${message}` }),
  });
  const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    extensionFactories: [
      ...(options.fastMode
        ? [
            {
              name: "subagent-fast-mode",
              hidden: true,
              factory: createChildFastModeExtension(
                options.nestedRuntime?.manager ?? options,
                options.fastModeGeneration ?? 1,
                options.fastMode,
              ),
            },
          ]
        : []),
      ...(options.daybreak
        ? [
            {
              name: "subagent-daybreak",
              hidden: true,
              factory: createChildDaybreakExtension(
                options.nestedRuntime?.manager ?? options,
                options.daybreakGeneration ?? 1,
                options.daybreak,
              ),
            },
          ]
        : []),
      ...(subagentStatusSource
        ? [
            {
              name: "subagent-status",
              hidden: true,
              factory: (childPi: ExtensionAPI) =>
                registerSubagentStatusMessage(childPi, subagentStatusSource),
            },
          ]
        : []),
      ...(noExtensions
        ? []
        : [
            {
              name: "subagent-tool-search",
              hidden: true,
              factory: createChildToolSearchExtension(
                (name) => childToolScope.isReachable?.(name) === true,
                (names) => {
                  for (const name of names) childToolScope.searchLoaded.add(name);
                },
                fileReadOnly,
              ),
            },
          ]),
      ...(childCompaction ? [childCompaction.extension] : []),
    ],
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  };
  const loader = options.createResourceLoader
    ? options.createResourceLoader(loaderOptions)
    : new DefaultResourceLoader(loaderOptions);
  await runInChildSessionContext(() => loader.reload());
  {
    const base = overrideBase;
    const owned = ownedExtensions;
    const loaded = base?.extensions ?? loader.getExtensions().extensions;
    await warmExtensionPackageNames(loaded.map((extension) => extension.path));
    if (base !== undefined && owned !== undefined) {
      discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
      owned.extensions = base.extensions.filter(keepExtension);
    }
  }

  emitLoaderWarnings({
    type,
    agentConfig,
    options,
    loader,
    noExtensions,
    hasExcludes,
    discoveredNames,
    excludeNames,
    keepNames,
    extNames,
  });

  return {
    agentConfig,
    effectiveCwd,
    configCwd,
    effectiveMaxDepth,
    toolNames,
    fileReadOnly,
    parentSessionId,
    scratchDir,
    agentDir,
    noExtensions,
    extNames,
    narrowing,
    childToolScope,
    childCompaction,
    loader,
    toolSurface,
    composePrompt,
    getSystemPrompt: () => systemPrompt,
    setSystemPrompt: (value: string) => {
      systemPrompt = value;
    },
  };
}

function emitLoaderWarnings(params: {
  type: SubagentType;
  agentConfig: AgentConfig | undefined;
  options: RunOptions;
  loader: DefaultResourceLoader;
  noExtensions: boolean;
  hasExcludes: boolean;
  discoveredNames: Set<string> | undefined;
  excludeNames: Set<string>;
  keepNames: Set<string>;
  extNames: Set<string>;
}): void {
  const {
    type,
    agentConfig,
    options,
    loader,
    noExtensions,
    hasExcludes,
    discoveredNames,
    excludeNames,
    keepNames,
    extNames,
  } = params;

  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }
}

export async function createAndBindChildSession(
  ctx: ExtensionContext,
  type: SubagentType,
  options: RunOptions,
  loaded: LoadedChildContext,
): Promise<PreparedChildSession> {
  const {
    agentConfig,
    effectiveCwd,
    configCwd,
    effectiveMaxDepth,
    toolNames,
    fileReadOnly,
    parentSessionId,
    scratchDir,
    agentDir,
    noExtensions,
    extNames,
    narrowing,
    childToolScope,
    childCompaction,
    loader,
    toolSurface,
    composePrompt,
    getSystemPrompt,
    setSystemPrompt,
  } = loaded;

  const locked = agentConfig?.modelLocked === true;
  let model = ctx.model;
  let thinkingLevel = locked
    ? agentConfig?.thinking
    : (options.thinkingLevel ?? agentConfig?.thinking);
  if (options.mainSessionFork) {
    model = options.mainSessionFork.model;
    thinkingLevel = options.mainSessionFork.thinkingLevel;
  } else if (locked) {
    model = resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
  } else if (options.model) {
    model = options.model;
  } else {
    model = resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
  }

  const disallowedNames = [
    ...(agentConfig?.disallowedTools ?? []),
    ...(fileReadOnly ? READ_ONLY_DENIED_TOOL_NAMES : []),
  ];
  const disallowedSet = disallowedNames.length > 0 ? new Set(disallowedNames) : undefined;

  const messagingTools = options.nestedRuntime
    ? [
        createAgentMessageTool({
          manager: options.nestedRuntime.manager,
          pi: options.pi,
          senderAgentId: options.nestedRuntime.parentAgentId,
        }),
      ]
    : [];
  const alwaysToolNames = new Set(messagingTools.map((tool) => tool.name));

  const nestedRuntime =
    options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
      ? options.nestedRuntime
      : undefined;
  const nestedTools =
    agentConfig?.allowedSubagents && nestedRuntime && !options.isolated && !options.readOnly
      ? await createNestedSubagentTools({
          manager: nestedRuntime.manager,
          pi: options.pi,
          parentAgentId: nestedRuntime.parentAgentId,
          depth: nestedRuntime.depth,
          maxSubagentDepth: effectiveMaxDepth,
          allowedSubagents: agentConfig.allowedSubagents,
          configCwd,
        })
      : [];
  const nestedToolNames = new Set(nestedTools.map((tool) => tool.name));
  const childTools = [...messagingTools, ...nestedTools];

  const { sessionTools, sessionExcludeTools } = computeChildToolGate({
    noExtensions,
    toolNames,
    disallowedSet,
    nestedToolNames,
    alwaysToolNames,
  });

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  const persistSession = agentConfig?.persistSession ?? getRememberAgents();
  const sessionManager = options.mainSessionFork
    ? options.mainSessionFork.sessionManager
    : options.resumeSessionFile
      ? SessionManager.open(options.resumeSessionFile, configuredSessionDir ?? defaultSessionDir)
      : persistSession
        ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, {
            parentSession: ctx.sessionManager?.getSessionFile?.(),
          })
        : SessionManager.inMemory(effectiveCwd);

  // SAFETY: Supported Pi registries may expose the optional runtime field before their public facade types do.
  const registryFacade = Object(ctx.modelRegistry) as ModelRegistryWithRuntime;
  const parentModelRuntime = registryFacade.runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
    modelRuntime?: unknown;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    // SAFETY: This compatibility field comes from the same parent registry facade passed above.
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    model,
    tools: sessionTools,
    customTools: childTools,
    resourceLoader: withLiveSystemPrompt(loader, getSystemPrompt),
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));
  const childSessionId = session.sessionManager.getSessionId();
  registerChildSessionId(childSessionId);
  if (parentSessionId) registerScratchRoot(childSessionId, scratchRootFor(parentSessionId));
  childCompaction?.bindSession(session);

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );
  if (!options.resumeSessionFile) {
    session.sessionManager.appendCustomEntry(SUBAGENT_SESSION_MARKER, {
      schemaVersion: 1,
      agentId: options.agentId ?? null,
      agentType: type,
      parentSessionId: ctx.sessionManager?.getSessionId?.() ?? null,
    });
  }

  let scratchNotice: string | undefined;
  if (scratchDir) {
    const recorded = session.sessionManager
      .getEntries()
      .findLast((entry) => entry.type === "custom" && entry.customType === SUBAGENT_SCRATCH_ENTRY);
    const recordedData = recorded?.type === "custom" ? recorded.data : undefined;
    const previous =
      isJsonRecord(recordedData) && isString(recordedData["scratchDir"])
        ? recordedData["scratchDir"]
        : undefined;
    if (previous !== scratchDir) {
      if (previous) {
        scratchNotice = scratchChangedNotice(previous, scratchDir);
        setPreviousScratchDir(childSessionId, previous);
      }
      session.sessionManager.appendCustomEntry(SUBAGENT_SCRATCH_ENTRY, { scratchDir });
    }
  }

  try {
    await session.bindExtensions({
      onError: (err) => {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:${err.extensionPath}`,
        });
      },
    });
  } catch (error) {
    unregisterChildSessionId(childSessionId);
    unregisterScratchRoot(childSessionId);
    childCompaction?.dispose();
    throw error;
  }
  if (options.nestedRuntime && options.agentId) {
    reconcileChildFastMode(session.sessionManager.getSessionId(), {
      id: options.agentId,
      manager: options.nestedRuntime.manager,
    });
    reconcileChildDaybreak(session.sessionManager.getSessionId(), {
      id: options.agentId,
      manager: options.nestedRuntime.manager,
    });
  }

  if (!noExtensions) {
    const isReachable = installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      nestedToolNames,
      alwaysToolNames,
      searchLoaded: childToolScope.searchLoaded,
    });
    childToolScope.isReachable = isReachable;
    restrictSessionToolScope(session.sessionManager, isReachable);
  }
  if (fileReadOnly) guardSessionReadOnlyToolCalls(session.sessionManager);

  if (!options.mainSessionFork) {
    const observed = observedChildToolSurface(session, childToolScope.isReachable);
    if (!sameToolGuidance(toolSurface, observed)) {
      setSystemPrompt(composePrompt(observed));
      session.setActiveToolsByName(session.getActiveToolNames());
    }
  }

  options.onSessionCreated?.(session);

  return { session, childCompaction, scratchNotice };
}
