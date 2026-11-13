import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type CreateAgentSessionOptions,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";

export async function createSdkFixture(
  model?: Model<Api>,
  factories: readonly ExtensionFactory[] = [],
): Promise<{
  session: AgentSession;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}> {
  let pi: ExtensionAPI | undefined;
  let ctx: ExtensionContext | undefined;
  const capture: ExtensionFactory = (api) => {
    pi = api;
    api.on("session_start", (_event, context) => {
      ctx = context;
    });
  };
  const cwd = process.cwd();
  const settings = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [capture, ...factories],
  });
  await loader.reload();
  const credentials = new InMemoryCredentialStore();
  const providerIds = model ? ["anthropic", model.provider] : ["anthropic"];
  for (const providerId of new Set(providerIds)) {
    await credentials.modify(providerId, async () => ({ type: "api_key", key: "test-key" }));
  }
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const options: CreateAgentSessionOptions = {
    cwd,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
    noTools: "all",
  };
  if (model) options.model = model;
  const created = await createAgentSession(options);
  await created.session.bindExtensions({});
  if (!pi || !ctx) {
    created.session.dispose();
    throw new Error("SDK fixture did not initialize its extension context.");
  }
  return { session: created.session, pi, ctx };
}
