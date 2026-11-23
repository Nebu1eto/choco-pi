import {
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  installAgentTools as registerAgentTools,
  installUserCommands,
} from "./lib/session-bridge/commands-and-tools.ts";
import { installLiveSessionBridge } from "./lib/session-bridge/live-bridge.ts";
import {
  managedSessionSnapshot,
  manageSession,
  resolveEffort,
  resolveModel,
  startManagedTask,
} from "./lib/session-bridge/sessions.ts";
import type { SessionSnapshot } from "./lib/session-bridge/types.ts";
import { createToolSearchResourceLoader } from "./lib/tool-surface.ts";

export { installLiveSessionBridge } from "./lib/session-bridge/live-bridge.ts";
export { registerManagedSession } from "./lib/session-bridge/sessions.ts";
export type { LiveSessionBridgeDependencies } from "./lib/session-bridge/types.ts";

async function createIndependentSession(
  ctx: ExtensionContext,
  input: { initialPrompt: string; model?: string; effort?: string; name?: string },
): Promise<SessionSnapshot> {
  const initialPrompt = input.initialPrompt.trim();
  if (!initialPrompt) throw new Error("Initial prompt must not be empty.");
  const model = resolveModel(ctx, input.model);
  const effort = resolveEffort(input.effort, ctx.thinkingLevel);
  const sessionManager = SessionManager.create(ctx.cwd);
  const resourceLoader = await createToolSearchResourceLoader(ctx.cwd);
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    thinkingLevel: effort,
    sessionManager,
    resourceLoader,
  });

  try {
    await session.bindExtensions({ mode: "print" });
    if (input.name?.trim()) session.setSessionName(input.name.trim());
  } catch (error) {
    session.dispose();
    throw error;
  }

  const managed = manageSession(session);
  void startManagedTask(managed, () => session.sendUserMessage(initialPrompt)).catch(
    () => undefined,
  );

  return managedSessionSnapshot(managed);
}

export function installAgentTools(pi: ExtensionAPI): void {
  registerAgentTools(pi, createIndependentSession);
}

export default function sessionBridge(pi: ExtensionAPI): void {
  installAgentTools(pi);
  installUserCommands(pi, createIndependentSession);
  installLiveSessionBridge(pi);
}
