import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { prototypeExtension, prototypeProvider } from "./extension.ts";

/** Fresh SDK host with no installed extensions, project context, settings, or session writes. */
export async function createPrototypeHost(options: Parameters<typeof prototypeExtension>[0]) {
  await mkdir("/tmp/choco-pi", { recursive: true });
  const scratch = await mkdtemp("/tmp/choco-pi/codex-prototype-");
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: `${scratch}/models-cache.json`,
      refreshOnCreate: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: scratch,
      agentDir: scratch,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [prototypeExtension(options)],
      systemPromptOverride: () => "Bounded Codex protocol experiment.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: scratch,
      agentDir: scratch,
      resourceLoader: loader,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(scratch),
      settingsManager,
      tools: [],
    });
    try {
      await session.bindExtensions({});
      const model = runtime.getModel(prototypeProvider, "gpt-6-astra");
      if (!model) throw new Error("prototype_model_not_registered");
      await session.setModel(model);
    } catch (error) {
      session.dispose();
      throw error;
    }
    return {
      session,
      async dispose() {
        await session.abort();
        session.dispose();
        await rm(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
