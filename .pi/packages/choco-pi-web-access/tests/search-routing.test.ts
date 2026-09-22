import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const moduleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const extensionUrl = new URL("../index.ts", import.meta.url).href;
const conflictFixturePath = fileURLToPath(
  new URL("./fixtures/conflicting-search-config-runner.ts", import.meta.url),
);

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type TestConfigValue = null | boolean | number | string | TestConfigValue[] | TestConfig;
interface TestConfig {
  readonly [key: string]: TestConfigValue;
}

async function run(
  config: TestConfig,
  script: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<ChildResult> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-search-routing-"));
  await writeFile(join(root, "web-search.json"), JSON.stringify(config), "utf8");
  const child = spawn(process.execPath, ["--input-type=module-typescript"], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: root,
      HOME: root,
      USERPROFILE: root,
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(script);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

async function runFixture(config: TestConfig, path: string): Promise<ChildResult> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-search-routing-"));
  await writeFile(join(root, "web-search.json"), JSON.stringify(config), "utf8");
  const child = spawn(process.execPath, [path], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: root,
      HOME: root,
      USERPROFILE: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

test("search provider lists expose shared logical families", async () => {
  const { SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS } = await import(moduleUrl);
  assert.deepEqual(SEARCH_PROVIDERS, [
    "auto",
    "all",
    "openai",
    "exa",
    "kagi",
    "synthetic",
    "brave",
  ]);
  assert.deepEqual(RESOLVED_SEARCH_PROVIDERS, ["openai", "exa", "kagi", "synthetic", "brave"]);
});

test("selection normalization accepts shared values and rejects unknown values", async () => {
  const { normalizeSearchProviderSelection } = await import(moduleUrl);
  assert.equal(normalizeSearchProviderSelection(" KAGI "), "kagi");
  assert.equal(normalizeSearchProviderSelection("removed-provider"), "auto");
  assert.deepEqual(normalizeSearchProviderSelection(["openai", "exa"]), ["openai", "exa"]);
  assert.throws(() => normalizeSearchProviderSelection(["removed-provider"]), /invalid provider/);
});

test("registered search schemas expose canonical logical providers and actions", async () => {
  const child = await run(
    {},
    `
      import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
      import extension from ${JSON.stringify(extensionUrl)};

      const agentDir = process.env.PI_CODING_AGENT_DIR;
      if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");
      const loader = new DefaultResourceLoader({
        agentDir,
        cwd: process.cwd(),
        extensionFactories: [{ factory: extension, name: "web-access" }],
        noContextFiles: true,
        noExtensions: true,
        noPromptTemplates: true,
        noSkills: true,
        noThemes: true,
        settingsManager: SettingsManager.inMemory(),
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
      const tools = loaded.extensions.flatMap((entry) =>
        [...entry.tools.values()].map((registered) => registered.definition),
      );
      const schemas = ["web_search", "source_check"].map((name) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error("Missing registered tool: " + name);
        return { name, provider: tool.parameters.properties.provider };
      });
      const webSearch = tools.find((candidate) => candidate.name === "web_search");
      if (!webSearch) throw new Error("Missing registered web_search tool");
      console.log(JSON.stringify({ schemas, properties: Object.keys(webSearch.parameters.properties) }));
    `,
  );
  assert.equal(child.status, 0, child.stderr);
  const output: {
    schemas: Array<{ provider: { anyOf: Array<{ enum?: string[]; items?: { enum: string[] } }> } }>;
    properties: string[];
  } = JSON.parse(child.stdout.trim());
  const expected = ["auto", "all", "openai", "exa", "kagi", "synthetic", "brave"];
  for (const schema of output.schemas) {
    assert.deepEqual(schema.provider.anyOf[0]?.enum, expected);
    assert.deepEqual(schema.provider.anyOf[1]?.items?.enum, expected.slice(2));
  }
  for (const property of ["action", "imageQuery", "url", "reference"]) {
    assert.ok(output.properties.includes(property), property);
  }
});

test("configured routing falls back from Kagi network failure to Exa", async () => {
  const child = await run(
    { searchRouting: { providers: ["kagi", "exa"], fallbackOn: ["network"] } },
    `
      globalThis.fetch = async (url) => {
        if (String(url) === "https://kagi.com/api/v1/search") throw new TypeError("fetch failed");
        if (String(url) === "https://api.exa.ai/answer") return new Response(JSON.stringify({ answer: "Exa answer", citations: [] }), { status: 200 });
        throw new Error("Unexpected URL " + url);
      };
      const { search } = await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(await search("route", { provider: "auto" })));
    `,
    { KAGI_API_KEY: "kagi-test", EXA_API_KEY: "exa-test" },
  );
  assert.equal(child.status, 0, child.stderr);
  const result: { provider: string; answer: string } = JSON.parse(child.stdout.trim());
  assert.equal(result.provider, "exa");
  assert.equal(result.answer, "Exa answer");
});

test("invalid routing provider fails loudly", async () => {
  const child = await run(
    { searchRouting: { providers: ["removed-provider"], fallbackOn: ["network"] } },
    `
      const { search } = await import(${JSON.stringify(moduleUrl)});
      try { await search("route"); } catch (error) { console.log(String(error)); }
    `,
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /invalid provider/);
});

test("conflicting configuration is never published to the process cache", async () => {
  const child = await runFixture(
    {
      searchProvider: "openai",
      searchRouting: { providers: ["synthetic"], fallbackOn: ["transient"] },
    },
    conflictFixturePath,
  );
  assert.equal(child.status, 0, child.stderr);
  const messages: string[] = JSON.parse(child.stdout);
  assert.equal(messages.length, 6);
  for (const message of messages) assert.match(message, /Conflicting search configuration/);
});
