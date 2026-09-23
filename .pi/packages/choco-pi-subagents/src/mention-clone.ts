/**
 * mention-clone.ts — start a mentioned agent through a clone of this
 * conversation, without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn — the model's
 * reasoning and its tool block land in the transcript, for a decision the user
 * already made when they typed the handle.
 *
 * So the turn happens somewhere else. The conversation is cloned into a
 * throwaway in-memory session — same messages, same system prompt, same model —
 * and that copy takes the turn off-screen. A literal clone: the session's own
 * entries, projected by pi's own `sessionEntryToContextMessages`, not
 * `inherit_context`'s text rendering of them.
 *
 * Cloned from memory rather than from the session file, which cannot be relied
 * on: `SessionManager._persist` withholds every write until the first assistant
 * message lands, so a fork taken before then reads an empty file and throws.
 * `buildSessionContext()` has no such timing, and is compaction-aware — it walks
 * the leaf path and substitutes the summary for entries folded into it, so a
 * long conversation clones as what the main model is actually working from. A
 * conversation with nothing in it yet clones to nothing in it yet, which is the
 * correct answer rather than a failure.
 *
 * It is also the oldest of the equivalent Pi APIs — `buildContextEntries` on
 * ReadonlySessionManager and the `sessionEntryToContextMessages` export both
 * arrived in 0.80.5 — where this one has been exported unchanged from before
 * the declared peer floor, and is the same code path (`byId` is only an index
 * cache, so passing it or not cannot change the result). Keeping the floor
 * honest costs nothing here: see the `compat-floor-pi` job.
 *
 * Its `thinkingLevel` is NOT used, and is the one place the newer API would be
 * better. `getSessionContextSettings` starts at "off" and moves only on an
 * explicit `thinking_level_change` entry, so a session where nobody ran
 * `/think` reports "off" rather than the level it is really using. Omitting the
 * field instead lets `createAgentSession` resolve it from settings, which is
 * that real level.
 *
 * Three details make the spawn belong to the real session rather than the
 * clone:
 *
 *   - the clone is handed the *registered* `Agent` tool, whose handler closes
 *     over the main activation, so it spawns top-level: widget, fleet row,
 *     handle, completion notification, all as if the main model had called it;
 *   - that tool is re-bound to the main `ExtensionContext`, because the handler
 *     reads `cwd`, `model` and `sessionManager.getSessionId()` off it to place
 *     the transcript and the `rootSessionId`. The clone's own context would
 *     file both under the throwaway fork;
 *   - it is called with no tool-call id. The clone's turn produces one, but the
 *     real session never issued it, and a `<tool-use-id>` pointing at nothing
 *     is exactly the bug the mention-resume path had to fix;
 *   - and it is forced into the background. A foreground agent returns its
 *     answer as the tool result and is marked `resultConsumed` so no completion
 *     notification is sent — correct when the caller is the real conversation,
 *     silent loss when the caller is a fork about to be discarded. Background
 *     delivery is the only route from a mention back to the main model.
 *
 * The clone gets one tool and one job. It cannot read, write or run anything —
 * an invisible turn with the full toolset could do invisible work.
 */

import { getCurrentSystemMessage, getCurrentSystemPrompt, type Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionAPI,
  type InlineExtension,
  getAgentDir,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.ts";
import { createChildFastModeExtension, snapshotFastMode } from "./fast-mode-bridge.ts";
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
  /** The MAIN session's context — what the spawn is attributed to, and the
   * source of both the conversation and the live system prompt. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone actually called `Agent`. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

export interface MentionCloneContext {
  messages: ReturnType<typeof buildSessionContext>["messages"];
  systemPrompt: string;
}

/** Resolve the active branch exactly as Pi will present it to a provider. */
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

interface ParentPromptSnapshot {
  generation: number;
  systemPrompt: string;
}

const parentPromptSnapshots = new Map<string, ParentPromptSnapshot>();
const mentionGenerations = new Map<string, number>();

/**
 * Record the parent's effective provider prompt for each run. `agent_start` fires after every
 * `before_agent_start` handler has run and the session has adopted the final forced prompt, so
 * `ctx.getSystemPrompt()` (AgentSession.systemPrompt) returns the text the provider receives
 * regardless of the order this package loads relative to prompt-forcing extensions.
 */
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

export function createMentionCloneAgentTool(
  agentTool: ToolDefinition,
  ctx: ExtensionContext,
  state: MentionSpawnState,
): ToolDefinition {
  return {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, _cloneCtx) => {
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
      // Agent schema accepts this wrapper's optional background flag alongside its own params.
      return agentTool.execute(
        undefined as never,
        { ...(params as MentionAgentToolParams), run_in_background: true },
        signal,
        onUpdate,
        ctx,
      );
    },
  };
}

/**
 * A detached clone completion may use its captured session objects only while
 * the activation generation that started it is still active. ExtensionContext
 * wrappers are deliberately absent: Pi creates a fresh one for every event.
 */
export function shouldHandleMentionCloneCompletion(
  originatingGeneration: number | undefined,
  currentGeneration: number | undefined,
): boolean {
  return originatingGeneration !== undefined && currentGeneration === originatingGeneration;
}

/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  const sessionId = ctx.sessionManager.getSessionId();
  const fastMode = snapshotFastMode(sessionId);
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
  // One spawn per mention. The clone has a single tool and every reason to stop
  // after using it, but a model that calls twice must not launch unseen work.
  const cloneAgentTool = createMentionCloneAgentTool(agentTool, ctx, spawnState);

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // Pi 0.80.8 moved createAgentSession from modelRegistry to modelRuntime;
    // agent-runner.ts carries the same shim for the same reason — pass both so
    // the clone keeps the parent's providers across the supported range.
    // SAFETY: Supported Pi registries may expose the optional runtime field before their public facade types do.
    // Pi 0.82.0 added this; below it the field is absent and the clone takes
    // the settings level instead, which is what a session that never ran
    // `/think` is on anyway. Same shim shape as `modelRuntime` below.
    // SAFETY: Pi 0.82+ ExtensionContext instances own this optional documented thinking level.
    // Pi 0.86 records the prompt and its later deltas as system messages. Replay
    // those messages for the effective prompt, falling back only for a session
    // that has not made its first provider request and therefore has no system
    // message yet.
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
      ],
      // This is the SDK's supported exact-prompt construction seam. Suppress
      // appended prompt fragments too: they are already present in the resolved
      // parent prompt and applying them again would duplicate the baseline.
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
        // Nothing about the copy is worth persisting, and an in-memory manager
        // is also what keeps the real session untouched.
        sessionManager: SessionManager.inMemory(cwd),
        model: model as Model<never> | undefined,
        ...(thinkingLevel && { thinkingLevel }),
        modelRegistry,
        ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
        resourceLoader,
        // An allowlist naming exactly the clone's own tool. NOT `noTools:
        // "all"`, whose doc comment ("start with no tools enabled") reads like
        // it spares custom tools and does not: it resolves to an EMPTY
        // allowlist, and `isAllowedTool` then drops every tool from the
        // registry — the custom one included. The clone would be prompted with
        // nothing to call, answer in prose, and every mention would fall
        // through to the direct start with a warning. Same idiom as
        // agent-runner's `tools: sessionTools` beside its nested `customTools`.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      } as Parameters<typeof createAgentSession>[0]),
    );
    if (mentionGenerations.get(sessionId) !== mentionGeneration) {
      created.session.dispose();
      return { spawned: false, error: "the parent session changed while preparing the clone" };
    }
    session = created.session;

    // The conversation itself. Pushed rather than assigned so the array the
    // session was built around stays the one it goes on using. System messages
    // are omitted because their fully replayed prompt is already the clone's
    // baseline; retaining them would apply parent deltas twice and would also
    // import the parent's tool declarations over the one-tool clone allowlist.
    session.agent.state.messages.push(...conversation.messages);

    // User text first, reminder after — the order Claude Code's attachment
    // renderer produces, where the reminder trails the message it is about.
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
