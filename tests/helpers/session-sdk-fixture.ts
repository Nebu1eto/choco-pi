import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export type SessionSdkFixture = {
  session: AgentSession;
  sessionManager: SessionManager;
  contexts: ExtensionContext[];
};

export async function createSessionSdkFixture(
  root: string,
  factories: readonly ExtensionFactory[],
  options: { bind?: boolean; id?: string } = {},
): Promise<SessionSdkFixture> {
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  const contexts: ExtensionContext[] = [];
  const capture: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      contexts.push(ctx);
    });
    pi.on("agent_start", (_event, ctx) => {
      contexts.push(ctx);
    });
    pi.on("agent_settled", (_event, ctx) => {
      contexts.push(ctx);
    });
  };
  const settings = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [...factories, capture],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const sessionManager = SessionManager.create(cwd, sessionDir, { id: options.id });
  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager: settings,
    noTools: "all",
  });
  if (options.bind !== false) await session.bindExtensions({});
  return { session, sessionManager, contexts };
}
