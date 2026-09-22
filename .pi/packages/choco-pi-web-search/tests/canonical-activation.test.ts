import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Type } from "typebox";
import {
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import unifiedSearchCore from "../extension.ts";
import { getSearchScope, hasCanonicalSearch } from "../index.ts";
import { registeredCanonicalSearchFrontend } from "./fixtures/registered-canonical-tool.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-canonical-activation-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const legacySearch: ExtensionFactory = (pi) => {
  if (hasCanonicalSearch(pi.events)) return;
  pi.registerTool({
    name: "legacy_search",
    label: "Legacy search",
    description: "Legacy search fixture",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    async execute() {
      return { content: [{ type: "text", text: "legacy" }], details: {} };
    },
  });
};

interface ActivationResult {
  canonical: boolean;
  tools: string[];
}

async function loadFactories(
  name: string,
  factories: Array<{ factory: ExtensionFactory; name: string }>,
): Promise<ActivationResult> {
  const cwd = join(agentDir, name);
  await mkdir(cwd, { recursive: true });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd,
    eventBus,
    extensionFactories: factories,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  return {
    canonical: hasCanonicalSearch(getSearchScope(eventBus)),
    tools: loaded.extensions.flatMap((extension) => [...extension.tools.keys()]),
  };
}

before(async () => {
  await mkdir(agentDir, { recursive: true });
});

test("canonical activation follows actual frontend registration", async () => {
  const coreWithoutFrontend = await loadFactories("core-only", [
    { factory: unifiedSearchCore, name: "canonical-core" },
    { factory: legacySearch, name: "legacy-search" },
  ]);
  assert.equal(coreWithoutFrontend.canonical, false);
  assert.deepEqual(coreWithoutFrontend.tools, ["legacy_search"]);

  const disabledFrontend = await loadFactories("disabled-frontend", [
    { factory: unifiedSearchCore, name: "canonical-core" },
    { factory: () => undefined, name: "disabled-search-frontend" },
    { factory: legacySearch, name: "legacy-search" },
  ]);
  assert.equal(disabledFrontend.canonical, false);
  assert.ok(!disabledFrontend.tools.includes("web_search"));
  assert.ok(disabledFrontend.tools.includes("legacy_search"));

  const enabledFrontend = await loadFactories("enabled-frontend", [
    { factory: unifiedSearchCore, name: "canonical-core" },
    { factory: registeredCanonicalSearchFrontend, name: "canonical-search-frontend" },
    { factory: legacySearch, name: "legacy-search" },
  ]);
  assert.equal(enabledFrontend.canonical, true);
  assert.equal(enabledFrontend.tools.filter((name) => name === "web_search").length, 1);
  assert.ok(!enabledFrontend.tools.includes("legacy_search"));

  const standaloneFrontend = await loadFactories("standalone-frontend", [
    { factory: registeredCanonicalSearchFrontend, name: "canonical-search-frontend" },
    { factory: legacySearch, name: "legacy-search" },
  ]);
  assert.equal(standaloneFrontend.canonical, false);
  assert.ok(standaloneFrontend.tools.includes("web_search"));
  assert.ok(standaloneFrontend.tools.includes("legacy_search"));
});
