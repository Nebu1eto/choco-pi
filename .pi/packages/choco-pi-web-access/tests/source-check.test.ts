import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type ExtensionActions,
  type ExtensionContext,
  type ExtensionContextActions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "choco-pi-source-check-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

const { default: initializeExtension } = await import("../index.ts");
const {
  assessClaim,
  buildResearchArtifact,
  buildPassages,
  getResearchArtifact,
  hashContent,
  storeResearchArtifact,
} = await import("../source-check.ts");
const { clearResults } = await import("../storage.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(isolatedAgentDir, { recursive: true, force: true });
});

const SourceCheckDetailsSchema = Type.Object(
  {
    sourceCount: Type.Number(),
    passageCount: Type.Number(),
    artifact: Type.Object(
      {
        sources: Type.Array(
          Type.Object(
            { fetch_error: Type.Optional(Type.String()) },
            { additionalProperties: true },
          ),
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

type SourceCheckDetails = Static<typeof SourceCheckDetailsSchema>;

interface StoredEntry {
  type: string;
}

interface SourceCheckParams {
  claim: string;
  fetchContent?: boolean;
  provider?: "openai";
  queries?: string[];
}

interface SourceCheckHost {
  context: ExtensionContext;
  entries: StoredEntry[];
  tool: ToolDefinition;
}

function result(url: string, snippet: string, rank = 1) {
  return { url, title: "Example", snippet, rank };
}

function conversationModel(): Model<Api> {
  return {
    id: "fixture-conversation",
    name: "Fixture conversation model",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  };
}

async function createSourceCheckHost(t: TestContext): Promise<SourceCheckHost> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-source-check-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd: root,
    extensionFactories: [{ factory: initializeExtension, name: "web-access" }],
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

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory(root);
  const entries: StoredEntry[] = [];
  let activeTools: string[] = [];
  const actions = {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: (type: string) => {
      entries.push({ type });
    },
    setSessionName: () => undefined,
    getSessionName: () => undefined,
    setLabel: () => undefined,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    refreshTools: () => undefined,
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => undefined,
  } satisfies ExtensionActions;
  const model = conversationModel();
  const contextActions = {
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "fixture prompt",
  } satisfies ExtensionContextActions;
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, registry);
  runner.bindCore(actions, contextActions);
  activeTools = runner.getAllRegisteredTools().map(({ definition }) => definition.name);
  const tool = runner.getToolDefinition("source_check");
  assert.ok(tool, "source_check must be registered by the SDK-loaded extension");
  return { context: runner.createContext(), entries, tool };
}

function requireSourceCheckDetails(resultValue: AgentToolResult<unknown>): SourceCheckDetails {
  assert.ok(
    Check(SourceCheckDetailsSchema, resultValue.details),
    "source_check must return its typed details contract",
  );
  return resultValue.details;
}

async function executeSourceCheck(
  host: SourceCheckHost,
  params: SourceCheckParams,
  signal?: AbortSignal,
): Promise<SourceCheckDetails> {
  const response = await host.tool.execute("call", params, signal, undefined, host.context);
  return requireSourceCheckDetails(response);
}

test("source-check creates a real SHA-256 hash and exact whitespace offsets", () => {
  const content = "Intro.\n\nThe API\t supports streaming responses.\nTail.";
  const passages = buildPassages(
    [
      {
        rank: 1,
        url: "https://docs.example.com/api",
        title: "API",
        snippet: "API supports streaming responses.",
        quality: "official_docs",
      },
    ],
    [{ url: "https://docs.example.com/api", title: "API", content, error: null }],
  );
  const pagePassage = passages.find((passage) => passage.extraction_span);
  assert.ok(pagePassage);
  assert.ok(pagePassage.extraction_span);
  assert.equal(pagePassage.text, "The API\t supports streaming responses.");
  assert.equal(
    content.slice(pagePassage.extraction_span.start, pagePassage.extraction_span.end),
    pagePassage.text,
  );
  assert.equal(
    hashContent("abc"),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("fetched content supplies exact passages when the provider snippet is empty", () => {
  const content = "The API supports streaming responses. Other details follow.";
  const artifact = buildResearchArtifact({
    query: "API supports streaming responses",
    results: [result("https://docs.example.com/api", "")],
    fetched: [{ url: "https://docs.example.com/api", title: "API", content, error: null }],
  });
  assert.deepEqual(
    artifact.passages.map((passage) => passage.text),
    ["The API supports streaming responses."],
  );
  assert.deepEqual(artifact.passages[0]?.extraction_span, { start: 0, end: 37 });
});

test("artifact assembly handles omitted domain filters and failed fetches", () => {
  const artifact = buildResearchArtifact({
    query: "API claim",
    results: [result("https://example.com/a", "The API is confirmed.")],
    fetched: [{ url: "https://example.com/a", title: "Example", content: "", error: "blocked" }],
  });
  const source = artifact.sources[0];
  assert.ok(source);
  assert.equal(artifact.filters?.domain_include?.length, 0);
  assert.equal(source.fetched, false);
  assert.equal(source.fetch_error, "blocked");
  assert.equal(source.content_hash, undefined);
  const fetchTimestamp = source.fetch_timestamp;
  assert.equal(Object.prototype.toString.call(fetchTimestamp), "[object Number]");
  assert.notEqual(Object(fetchTimestamp), fetchTimestamp);
});

test("claim assessment references passage IDs and stores a non-empty artifact ID", () => {
  clearResults();
  const artifact = buildResearchArtifact({
    query: "API claim",
    results: [
      result("https://example.com/a", "According to the API documentation, the API is confirmed."),
    ],
  });
  const assessed = {
    ...artifact,
    claims: [assessClaim("API documentation is confirmed", artifact.passages)],
  };
  storeResearchArtifact(assessed);
  assert.ok(assessed.id);
  assert.deepEqual(getResearchArtifact(assessed.id), assessed);
  assert.deepEqual(assessed.claims[0]?.supporting_passages, ["p-1-0"]);
});

test("claim assessment ignores polarity substrings, negated markers, and discourse words", () => {
  const claim = "API supports streaming responses";
  const passage = (passageId: string, text: string) => ({
    passage_id: passageId,
    source_url: "https://example.com/api",
    source_rank: 1,
    text,
  });
  for (const [passageId, text] of [
    ["p-yesterday", "Yesterday, the API documentation discussed streaming responses."],
    ["p-unverified", "The API is unverified; documentation discusses streaming responses."],
    ["p-however", "However, the API supports streaming responses."],
  ]) {
    assert.ok(passageId);
    assert.ok(text);
    const assessment = assessClaim(claim, [passage(passageId, text)]);
    assert.equal(assessment.status, "unclear", text);
    assert.deepEqual(assessment.supporting_passages, [], text);
    assert.deepEqual(assessment.contradicting_passages, [], text);
  }
});

test("source_check executes a successful OpenAI provider response with runtime context", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "source-check-test-key";
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "web_search_call",
            action: { sources: [{ title: "API docs", url: "https://docs.example.com/api" }] },
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "The API supports streaming responses." }],
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const host = await createSourceCheckHost(t);
    const details = await executeSourceCheck(host, {
      claim: "API supports streaming responses",
      provider: "openai",
    });
    assert.equal(details.sourceCount, 1);
    assert.equal(details.passageCount, 0);
    assert.equal(host.entries[0]?.type, "web-search-results");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("source_check stops on cancellation instead of continuing queries", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  const controller = new AbortController();
  process.env.OPENAI_API_KEY = "source-check-test-key";
  globalThis.fetch = async () => {
    calls++;
    controller.abort();
    throw new DOMException("canceled", "AbortError");
  };
  try {
    const host = await createSourceCheckHost(t);
    const details = await executeSourceCheck(
      host,
      { claim: "cancel this", queries: ["first", "second"], provider: "openai" },
      controller.signal,
    );
    assert.equal(calls, 1);
    assert.equal(details.sourceCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("source_check retains a rejected page fetch in the artifact", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "source-check-test-key";
  globalThis.fetch = async (input) => {
    if (String(input) === "https://api.openai.com/v1/responses") {
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "web_search_call",
              action: { sources: [{ title: "API docs", url: "https://example.com/api" }] },
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error("fetch rejected");
  };
  try {
    const host = await createSourceCheckHost(t);
    const details = await executeSourceCheck(host, {
      claim: "API docs",
      provider: "openai",
      fetchContent: true,
    });
    assert.equal(details.sourceCount, 1);
    const source = details.artifact.sources[0];
    assert.ok(source?.fetch_error);
    assert.match(source.fetch_error, /^fetch rejected/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("registered source_check validates the claim at runtime", async (t) => {
  const host = await createSourceCheckHost(t);
  const response = await host.tool.execute(
    "call",
    { claim: "   " },
    undefined,
    undefined,
    host.context,
  );
  assert.deepEqual(response.details, { error: "Missing claim" });
});
