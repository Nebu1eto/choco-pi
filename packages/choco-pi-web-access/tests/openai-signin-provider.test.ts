import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Regression coverage for Pi's "Sign in with ChatGPT" credential on the stock `openai`
// provider: the token is a JWT carrying the `https://api.openai.com/auth` claim (without a
// ChatGPT account id) and must reach api.openai.com, never the chatgpt.com Codex backend.

const openaiUrl = new URL("../openai-search.ts", import.meta.url).href;
const adaptersUrl = new URL("../search-adapters.ts", import.meta.url).href;
const legacyRouterUrl = new URL("../gemini-search.ts", import.meta.url).href;
const coreUrl = new URL("../../choco-pi-web-search/index.ts", import.meta.url).href;
const summaryUrl = new URL("../summary-review.ts", import.meta.url).href;

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

interface OpenAIAuthClaim {
  chatgpt_account_id?: string;
  per_user_salt?: string;
  encrypted_auth_metadata?: string;
}

interface JwtPayload {
  "https://api.openai.com/auth": OpenAIAuthClaim;
}

interface WebSearchConfigFixture {
  openaiSearchProviders?: string[];
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function createJwt(payload: JwtPayload): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  return `${header}.${base64Url(JSON.stringify(payload))}.signature`;
}

const SIGN_IN_TOKEN = createJwt({
  "https://api.openai.com/auth": {
    per_user_salt: "fixture-salt",
    encrypted_auth_metadata: "fixture",
  },
});
const CODEX_TOKEN = createJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
});

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runChild(script: string, config?: WebSearchConfigFixture): Promise<ChildResult> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-openai-signin-"));
  if (config) {
    await writeFile(join(root, "web-search.json"), JSON.stringify(config), "utf8");
  }
  const child = spawn(process.execPath, ["--input-type=module"], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: root,
      HOME: root,
      USERPROFILE: root,
      OPENAI_API_KEY: "",
      EXA_API_KEY: "",
      KAGI_API_KEY: "",
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

/**
 * Registry fixture: built-in catalog entries plus per-provider credential results.
 * `oauthProviders` drives `isUsingOAuth`; `null` omits the method (minimal registry).
 */
function registryScript(
  credentials: Readonly<Record<string, string | null>>,
  oauthProviders: readonly string[] | null = ["openai", "openai-codex"],
): string {
  return `
    const attempted = [];
    const credentials = ${JSON.stringify(credentials)};
    const oauthProviders = ${JSON.stringify(oauthProviders)};
    const ctx = {
      model: { provider: "anthropic", id: "conversation-model" },
      modelRegistry: {
        getAll: () => [
          { provider: "anthropic", id: "conversation-model", baseUrl: "https://api.anthropic.com" },
          { provider: "openai-codex", id: "gpt-5.6-terra", baseUrl: ${JSON.stringify(CODEX_BASE_URL)} },
          { provider: "openai", id: "gpt-5.6-terra", baseUrl: ${JSON.stringify(OPENAI_BASE_URL)} },
          { provider: "openai", id: "gpt-6.1-sol", baseUrl: ${JSON.stringify(OPENAI_BASE_URL)} },
        ],
        getApiKeyAndHeaders: async (model) => {
          attempted.push(model.provider);
          const key = credentials[model.provider];
          return key ? { ok: true, apiKey: key, headers: {} } : { ok: true, headers: {} };
        },
      },
    };
    if (oauthProviders) {
      ctx.modelRegistry.isUsingOAuth = (model) => oauthProviders.includes(model.provider);
    }
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ output: [
        { type: "web_search_call", action: { type: "search", sources: [{ url: "https://nodejs.org/en", title: "Node" }] } },
        { type: "message", content: [{ type: "output_text", text: "Node 24 is LTS.", annotations: [
          { type: "url_citation", url: "https://nodejs.org/en/about/releases?utm_source=openai", title: "Releases", start_index: 0, end_index: 4 },
        ] }] },
      ] }), { status: 200 });
    };
  `;
}

interface WebSearchToolBody {
  type: string;
  filters?: { allowed_domains?: string[]; blocked_domains?: string[] };
}

interface CapturedBody {
  model?: string;
  include?: string[];
  store?: boolean;
  stream?: boolean;
  tool_choice?: string;
  tools?: WebSearchToolBody[];
  max_output_tokens?: number;
  temperature?: number;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: CapturedBody;
}

interface SearchOutput {
  attempted: string[];
  auth: { providerId: string; transport: string; billing: string; model: string };
  calls: CapturedCall[];
  response: { answer: string; results: Array<{ url: string }> };
}

const SEARCH_AND_REPORT = `
  const { resolveOpenAIAuth, searchWithResolvedOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
  const auth = await resolveOpenAIAuth(ctx);
  const response = await searchWithResolvedOpenAIAuth("node lts", { domainFilter: ["nodejs.org"] }, auth);
  console.log(JSON.stringify({
    attempted,
    auth: { providerId: auth.providerId, transport: auth.transport, billing: auth.billing, model: auth.model },
    calls,
    response,
  }));
`;

async function runSearch(
  credentials: Readonly<Record<string, string | null>>,
  config?: WebSearchConfigFixture,
  oauthProviders?: readonly string[] | null,
): Promise<SearchOutput> {
  const result = await runChild(
    registryScript(credentials, oauthProviders) + SEARCH_AND_REPORT,
    config,
  );
  assert.equal(result.status, 0, result.stderr);
  const output: SearchOutput = JSON.parse(result.stdout.trim());
  return output;
}

test("ChatGPT sign-in on openai is preferred and sent to api.openai.com as subscription", async () => {
  const output = await runSearch({ openai: SIGN_IN_TOKEN, "openai-codex": CODEX_TOKEN });
  // openai is first; the legacy openai-codex credential is never touched.
  assert.deepEqual(output.attempted, ["openai"]);
  assert.deepEqual(output.auth, {
    providerId: "openai",
    transport: "responses-api",
    billing: "subscription",
    model: "gpt-5.6-terra",
  });
  assert.equal(output.calls.length, 1);
  const [call] = output.calls;
  assert.ok(call);
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(call.headers.Authorization, `Bearer ${SIGN_IN_TOKEN}`);
  assert.equal(call.headers["chatgpt-account-id"], undefined);
  assert.equal(call.headers.originator, undefined);
  assert.deepEqual(Object.keys(call.body).sort(), [
    "include",
    "input",
    "instructions",
    "model",
    "parallel_tool_calls",
    "store",
    "stream",
    "tool_choice",
    "tools",
  ]);
  // Fields Sign in with ChatGPT rejects are never sent.
  assert.equal(call.body.max_output_tokens, undefined);
  assert.equal(call.body.temperature, undefined);
  assert.equal(call.body.prompt_cache_key, undefined);
  assert.equal(call.body.prompt_cache_retention, undefined);
  assert.deepEqual(call.body.tools, [
    { type: "web_search", filters: { allowed_domains: ["nodejs.org"] } },
  ]);
  assert.deepEqual(call.body.include, ["web_search_call.action.sources"]);
  assert.equal(call.body.store, false);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.tool_choice, "required");
  assert.equal(output.response.answer, "Node 24 is LTS.");
  assert.deepEqual(
    output.response.results.map((entry) => entry.url),
    ["https://nodejs.org/en/about/releases", "https://nodejs.org/en"],
  );
});

test("sign-in JWT auth claim alone does not route openai to the Codex backend", async () => {
  // Minimal registry without isUsingOAuth: the sign-in token shape is the fallback signal.
  const output = await runSearch(
    { openai: SIGN_IN_TOKEN },
    { openaiSearchProviders: ["openai"] },
    null,
  );
  assert.equal(output.auth.transport, "responses-api");
  assert.equal(output.auth.billing, "subscription");
  assert.equal(output.calls[0]?.url, "https://api.openai.com/v1/responses");
});

test("non-sk environment or config keys on openai are not reported as subscription", async () => {
  // Registry reports a non-OAuth credential (env/config API key) that lacks the sk- prefix.
  const output = await runSearch({ openai: "integration-openai-key" }, undefined, []);
  assert.deepEqual(output.attempted, ["openai"]);
  assert.equal(output.auth.transport, "responses-api");
  assert.equal(output.auth.billing, "api");
  assert.equal(output.calls[0]?.url, "https://api.openai.com/v1/responses");
});

test("openai API keys keep API billing on the Responses API", async () => {
  const output = await runSearch({ openai: "sk-fixture-api-key", "openai-codex": CODEX_TOKEN });
  assert.deepEqual(output.attempted, ["openai"]);
  assert.equal(output.auth.transport, "responses-api");
  assert.equal(output.auth.billing, "api");
  assert.equal(output.calls[0]?.url, "https://api.openai.com/v1/responses");
});

test("unauthenticated openai falls back to the unchanged legacy openai-codex transport", async () => {
  const output = await runSearch({ openai: null, "openai-codex": CODEX_TOKEN });
  assert.deepEqual(output.attempted, ["openai", "openai-codex"]);
  assert.deepEqual(output.auth, {
    providerId: "openai-codex",
    transport: "codex-subscription",
    billing: "subscription",
    model: "gpt-5.6-terra",
  });
  const [call] = output.calls;
  assert.ok(call);
  assert.equal(call.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(call.headers["chatgpt-account-id"], "fixture-account");
  assert.equal(call.headers.originator, "pi");
});

test("configured legacy provider order still selects openai-codex first", async () => {
  const output = await runSearch(
    { openai: SIGN_IN_TOKEN, "openai-codex": CODEX_TOKEN },
    { openaiSearchProviders: ["openai-codex", "openai"] },
  );
  assert.deepEqual(output.attempted, ["openai-codex"]);
  assert.equal(output.auth.transport, "codex-subscription");
  assert.equal(output.calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
});

test("integrated router reports the openai sign-in transport and subscription billing", async () => {
  const result = await runChild(`
    ${registryScript({ openai: SIGN_IN_TOKEN, "openai-codex": CODEX_TOKEN })}
    const listeners = new Map();
    const events = {
      on(name, listener) { const entries = listeners.get(name) ?? []; entries.push(listener); listeners.set(name, entries); },
      emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
    };
    const manager = { getSessionId: () => "openai-signin-session" };
    ctx.sessionManager = manager;
    const { registerWebAccessSearchAdapters } = await import(${JSON.stringify(adaptersUrl)});
    const { getSearchScope, bindSearchSession } = await import(${JSON.stringify(coreUrl)});
    const { search } = await import(${JSON.stringify(legacyRouterUrl)});
    registerWebAccessSearchAdapters({ events });
    bindSearchSession(getSearchScope(events), manager);
    const response = await search("node lts", { extensionContext: ctx });
    console.log(JSON.stringify({ attempted, urls: calls.map((call) => call.url), response }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output: {
    attempted: string[];
    urls: string[];
    response: { provider: string; adapterId: string; transport: string; billing: string };
  } = JSON.parse(result.stdout.trim());
  assert.ok(output.attempted.every((provider) => provider === "openai"));
  assert.deepEqual(output.urls, ["https://api.openai.com/v1/responses"]);
  assert.equal(output.response.provider, "openai");
  assert.equal(output.response.adapterId, "web-access.openai");
  assert.equal(output.response.transport, "responses-api");
  assert.equal(output.response.billing, "subscription");
});

test("summary review prefers openai models over legacy openai-codex models", async () => {
  const result = await runChild(`
    const models = [
      { provider: "openai-codex", id: "gpt-5.6-luna", baseUrl: ${JSON.stringify(CODEX_BASE_URL)} },
      { provider: "openai-codex", id: "gpt-5.6-terra", baseUrl: ${JSON.stringify(CODEX_BASE_URL)} },
      { provider: "openai", id: "gpt-5.6-luna", baseUrl: ${JSON.stringify(OPENAI_BASE_URL)} },
      { provider: "openai", id: "gpt-5.6-terra", baseUrl: ${JSON.stringify(OPENAI_BASE_URL)} },
    ];
    const ctx = {
      modelRegistry: {
        getAvailable: () => models,
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: ${JSON.stringify(SIGN_IN_TOKEN)}, headers: {} }),
      },
      cwd: process.cwd(),
      isProjectTrusted: () => false,
    };
    const completed = [];
    const { generateSummaryDraft } = await import(${JSON.stringify(summaryUrl)});
    const draft = await generateSummaryDraft(
      [{ query: "q", answer: "a", results: [{ title: "t", url: "https://example.test" }], error: null, provider: "openai" }],
      ctx,
      undefined,
      undefined,
      undefined,
      async (model) => {
        completed.push(model.provider + "/" + model.id);
        return { role: "assistant", content: [{ type: "text", text: "Summary text" }], stopReason: "stop" };
      },
    );
    console.log(JSON.stringify({ completed, model: draft.meta.model, fallbackUsed: draft.meta.fallbackUsed }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output: { completed: string[]; model: string | null; fallbackUsed: boolean } = JSON.parse(
    result.stdout.trim(),
  );
  assert.deepEqual(output.completed, ["openai/gpt-5.6-luna"]);
  assert.equal(output.model, "openai/gpt-5.6-luna");
  assert.equal(output.fallbackUsed, false);
});
