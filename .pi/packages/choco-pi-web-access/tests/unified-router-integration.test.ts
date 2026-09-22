import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const adaptersUrl = new URL("../search-adapters.ts", import.meta.url).href;
const legacyRouterUrl = new URL("../gemini-search.ts", import.meta.url).href;
const coreUrl = new URL("../../choco-pi-web-search/index.ts", import.meta.url).href;

async function runIntegrated(conversationProvider: "anthropic" | "synthetic"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-unified-router-"));
  const child = spawn(process.execPath, ["--input-type=module"], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: root,
      EXA_API_KEY: "",
      KAGI_API_KEY: "",
      OPENAI_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`
    const listeners = new Map();
    const events = {
      on(name, listener) { const entries = listeners.get(name) ?? []; entries.push(listener); listeners.set(name, entries); },
      emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
    };
    const manager = { getSessionId: () => "router-integration-session" };
    const credentialModels = [];
    const context = {
      model: { provider: ${JSON.stringify(conversationProvider)}, id: "conversation-model" },
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { provider: ${JSON.stringify(conversationProvider)}, id: "conversation-model" },
          { provider: "openai-codex", id: "gpt-5.6-terra" },
        ],
        getApiKeyAndHeaders: async (model) => {
          credentialModels.push(model.provider);
          if (model.provider !== "openai-codex") throw new Error("wrong credential provider");
          return { ok: true, apiKey: "subscription-secret", headers: {} };
        },
      },
    };
    globalThis.fetch = async (url, init) => new Response(JSON.stringify({ output: [
      { type: "message", content: [{ type: "output_text", text: "Routed answer", annotations: [
        { type: "url_citation", url: "https://example.test/source", title: "Source", start_index: 0, end_index: 6 },
      ] }] },
    ] }), { status: 200 });
    const { registerWebAccessSearchAdapters } = await import(${JSON.stringify(adaptersUrl)});
    const { getSearchScope, bindSearchSession } = await import(${JSON.stringify(coreUrl)});
    const { search } = await import(${JSON.stringify(legacyRouterUrl)});
    registerWebAccessSearchAdapters({ events });
    bindSearchSession(getSearchScope(events), manager);
    const response = await search("query", { extensionContext: context });
    console.log(JSON.stringify({ credentialModels, response }));
  `);
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
  assert.equal(status, 0, stderr);
  return stdout;
}

for (const provider of ["anthropic", "synthetic"] as const) {
  test(`${provider} integrated search routes through the OpenAI adapter`, async () => {
    const output: {
      credentialModels: string[];
      response: {
        provider: string;
        adapterId: string;
        transport: string;
        billing: string;
        answer: string;
        results: Array<{ url: string }>;
      };
    } = JSON.parse((await runIntegrated(provider)).trim());
    assert.deepEqual(output.credentialModels, ["openai-codex"]);
    assert.equal(output.response.provider, "openai");
    assert.equal(output.response.adapterId, "web-access.openai");
    assert.equal(output.response.transport, "codex-subscription");
    assert.equal(output.response.billing, "subscription");
    assert.equal(output.response.answer, "Routed answer");
    assert.equal(output.response.results[0]?.url, "https://example.test/source");
  });
}

test("canonical Exa routing forwards negative domains as excludeDomains", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-unified-exa-exclusions-"));
  const child = spawn(process.execPath, ["--input-type=module"], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: root,
      EXA_API_KEY: "exa-router-secret",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`
    const listeners = new Map();
    const events = {
      on(name, listener) { const entries = listeners.get(name) ?? []; entries.push(listener); listeners.set(name, entries); },
      emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
    };
    const manager = { getSessionId: () => "exa-exclusion-session" };
    const context = { sessionManager: manager };
    let requestBody;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const { registerWebAccessSearchAdapters } = await import(${JSON.stringify(adaptersUrl)});
    const { getSearchScope, bindSearchSession, search } = await import(${JSON.stringify(coreUrl)});
    registerWebAccessSearchAdapters({ events });
    bindSearchSession(getSearchScope(events), manager);
    const response = await search(
      { query: "query", provider: "exa", domainFilter: ["allowed.test", "-blocked.test"] },
      { context },
    );
    console.log(JSON.stringify({ requestBody, adapterId: response.adapterId }));
  `);
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
  assert.equal(status, 0, stderr);
  const output: {
    requestBody: { includeDomains: string[]; excludeDomains: string[] };
    adapterId: string;
  } = JSON.parse(stdout.trim());
  assert.equal(output.adapterId, "web-access.exa");
  assert.deepEqual(output.requestBody.includeDomains, ["allowed.test"]);
  assert.deepEqual(output.requestBody.excludeDomains, ["blocked.test"]);
});
