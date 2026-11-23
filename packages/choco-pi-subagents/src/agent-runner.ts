/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 *
 * Orchestrates the internal runner modules under ./runner/ while preserving every
 * public export and signature.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentType } from "./types.ts";
import {
  createAndBindChildSession,
  prepareAgentResourceLoader,
  type RunOptions,
  type RunResult,
} from "./runner/loader-setup.ts";
import { executeChildSession } from "./runner/session-execution.ts";

export {
  extensionCanonicalName,
  extensionCanonicalNames,
  parseExtSelectors,
  parseExtensionsSpec,
  shouldKeepExtension,
  warmExtensionPackageNames,
  type ExtensionSelection,
  type ExtensionToolSelection,
} from "./runner/extension-selection.ts";

export {
  SUBAGENT_SCRATCH_ENTRY,
  SUBAGENT_SESSION_MARKER,
  buildEffectivePrompt,
  captureMainSessionFork,
  resolveDefaultModel,
  type MainSessionFork,
  type RunOptions,
  type RunResult,
  type ToolActivity,
} from "./runner/loader-setup.ts";

export { getAgentConversation } from "./runner/result-collection.ts";

export { resumeAgent, steerAgent } from "./runner/session-execution.ts";

export {
  READ_ONLY_DENIED_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  computeChildToolGate,
  createChildToolSearchExtension,
  guardSessionReadOnlyToolCalls,
  installExtensionToolScope,
  lacksFileMutationTools,
  observedChildToolSurface,
  predictChildToolSurface,
  readOnlyToolCallBlock,
  restrictSessionToolScope,
  sameToolGuidance,
  withLiveSystemPrompt,
  type ToolCallBlock,
} from "./runner/tool-scoping.ts";

export {
  getDefaultMaxTurns,
  getGraceTurns,
  getRememberAgents,
  installRunnerTurnLimit,
  normalizeMaxTurns,
  resolveAgentMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "./runner/turn-limit.ts";

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const loaded = await prepareAgentResourceLoader(ctx, type, options);
  const prepared = await createAndBindChildSession(ctx, type, options, loaded);
  return executeChildSession(ctx, type, prompt, options, prepared);
}
