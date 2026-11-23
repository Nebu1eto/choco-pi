import { getCurrentSystemMessage, getCurrentSystemPrompt, type Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionAPI,
  type ExtensionToolContext,
  type InlineExtension,
  getAgentDir,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.ts";
import { createChildFastModeExtension, snapshotFastMode } from "./fast-mode-bridge.ts";
import { createChildDaybreakExtension, snapshotDaybreak } from "./daybreak-bridge.ts";
import { agentMentionReminder } from "./mention.ts";
import type { SubagentType, ThinkingLevel } from "./types.ts";

interface ModelRegistryWithRuntime {
  runtime?: unknown;
}

interface ContextWithThinkingLevel {
  thinkingLevel?: ThinkingLevel;
}

interface MentionAgentToolParams {
  run_in_background?: boolean;
}

export interface MentionCloneOptions {
  ctx: ExtensionContext;
  type: SubagentType;
  message: string;
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  spawned: boolean;
  error?: string;
}

export interface MentionCloneContext {
  messages: ReturnType<typeof buildSessionContext>["messages"];
  systemPrompt: string;
}

interface MentionCloneContextSource {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries" | "getLeafId">;
  getSystemPrompt(): string;
  cwd: string;
}

export function buildMentionCloneContext(ctx: MentionCloneContextSource): MentionCloneContext {
  const conversation = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  const currentSystemMessage = getCurrentSystemMessage(conversation.messages);
  const transcriptSystemPrompt = currentSystemMessage
    ? getCurrentSystemPrompt(conversation.messages)
    : undefined;
  return {
    systemPrompt: transcriptSystemPrompt ?? ctx.getSystemPrompt(),
    messages: conversation.messages.filter((entry) => entry.role !== "system"),
  };
}

interface MentionSpawnState {
  spawned: boolean;
}

export function seedCloneConversation(
  manager: SessionManager,
  messages: MentionCloneContext["messages"],
): void {
  for (const message of messages) {
    switch (message.role) {
      case "compactionSummary":
        manager.appendCompaction(message.summary, null, message.tokensBefore);
        break;
      case "branchSummary":
        manager.branchWithSummary(manager.getLeafId(), message.summary);
        break;
      default:
        manager.appendMessage(message);
    }
  }
}

interface ParentPromptSnapshot {
  generation: number;
  systemPrompt: string;
}

const parentPromptSnapshots = new Map<string, ParentPromptSnapshot>();
const mentionGenerations = new Map<string, number>();

export function registerMentionCloneParentPromptObserver(pi: ExtensionAPI): void {
  pi.on("agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const generation = (parentPromptSnapshots.get(sessionId)?.generation ?? 0) + 1;
    parentPromptSnapshots.set(sessionId, { generation, systemPrompt: ctx.getSystemPrompt() });
  });
}

export function createMentionClonePromptExtension(systemPrompt: string): InlineExtension {
  return {
    name: "mention-clone-forced-prompt",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => ({ systemPrompt }));
    },
  };
}

export function bindToolContextToSession(
  session: ExtensionContext,
  call: ExtensionToolContext,
): ExtensionToolContext {
  return {
    get ui() {
      return session.ui;
    },
    get mode() {
      return session.mode;
    },
    get hasUI() {
      return session.hasUI;
    },
    get cwd() {
      return session.cwd;
    },
    get sessionManager() {
      return session.sessionManager;
    },
    get modelRegistry() {
      return session.modelRegistry;
    },
    get model() {
      return session.model;
    },
    get scopedModels() {
      return session.scopedModels;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
    isIdle: () => session.isIdle(),
    isProjectTrusted: () => session.isProjectTrusted(),
    get signal() {
      return session.signal;
    },
    abort: () => session.abort(),
    hasPendingMessages: () => session.hasPendingMessages(),
    shutdown: () => session.shutdown(),
    getContextUsage: () => session.getContextUsage(),
    compact: (options) => session.compact(options),
    getSystemPrompt: () => session.getSystemPrompt(),
    get tools() {
      return call.tools;
    },
    executeTool: (name, args, options) => call.executeTool(name, args, options),
  };
}

export function createMentionCloneAgentTool(
  agentTool: ToolDefinition,
  ctx: ExtensionContext,
  state: MentionSpawnState,
): ToolDefinition {
  return {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, cloneCtx) => {
      if (state.spawned) {
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: "Already started an agent for this mention. Stop here.",
            },
          ],
          details: undefined,
          isError: true,
        });
      }
      state.spawned = true;
      // SAFETY: Synthetic clone calls intentionally omit the tool-call id, and the registered
      return agentTool.execute(
        undefined as never,
        { ...(params as MentionAgentToolParams), run_in_background: true },
        signal,
        onUpdate,
        bindToolContextToSession(ctx, cloneCtx),
      );
    },
  };
}

export function shouldHandleMentionCloneCompletion(
  originatingGeneration: number | undefined,
  currentGeneration: number | undefined,
): boolean {
  return originatingGeneration !== undefined && currentGeneration === originatingGeneration;
}

export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  const sessionId = ctx.sessionManager.getSessionId();
  const fastMode = snapshotFastMode(sessionId);
  const daybreak = snapshotDaybreak(sessionId);
  const mentionGeneration = (mentionGenerations.get(sessionId) ?? 0) + 1;
  mentionGenerations.set(sessionId, mentionGeneration);
  const cwd = ctx.cwd;
  const model = ctx.model;
  const modelRegistry = ctx.modelRegistry;
  // SAFETY: Supported Pi registries may expose the optional runtime field before their public facade types do.
  const registryFacade = Object(modelRegistry) as ModelRegistryWithRuntime;
  const parentModelRuntime = registryFacade.runtime;
  // SAFETY: Pi 0.82+ ExtensionContext instances own this optional documented thinking level.
  const thinkingLevel = (ctx as ContextWithThinkingLevel).thinkingLevel;
  const conversation = buildMentionCloneContext(ctx);
  const promptSnapshot = parentPromptSnapshots.get(sessionId);
  const systemPrompt = promptSnapshot?.systemPrompt ?? conversation.systemPrompt;

  const spawnState: MentionSpawnState = { spawned: false };
  const cloneAgentTool = createMentionCloneAgentTool(agentTool, ctx, spawnState);

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // SAFETY: Supported Pi registries may expose the optional runtime field before their public facade types do.
    // SAFETY: Pi 0.82+ ExtensionContext instances own this optional documented thinking level.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        createMentionClonePromptExtension(systemPrompt),
        createChildFastModeExtension(opts, mentionGeneration, {
          ...fastMode,
          source: "inherited",
        }),
        createChildDaybreakExtension(opts, mentionGeneration, {
          ...daybreak,
          source: "inherited",
        }),
      ],
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await runInChildSessionContext(() => resourceLoader.reload());
    if (mentionGenerations.get(sessionId) !== mentionGeneration) {
      return { spawned: false, error: "the parent session changed while preparing the clone" };
    }
    // SAFETY: The compatibility-only modelRuntime and model generic match the parent session that owns both values.
    const created = await runInChildSessionContext(() =>
      createAgentSession({
        cwd,
        sessionManager: SessionManager.inMemory(cwd),
        model: model as Model<never> | undefined,
        ...(thinkingLevel && { thinkingLevel }),
        modelRegistry,
        ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
        resourceLoader,
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      } as Parameters<typeof createAgentSession>[0]),
    );
    if (mentionGenerations.get(sessionId) !== mentionGeneration) {
      created.session.dispose();
      return { spawned: false, error: "the parent session changed while preparing the clone" };
    }
    session = created.session;

    seedCloneConversation(session.sessionManager, conversation.messages);
    session.refreshContext();

    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned: spawnState.spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawnState.spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
