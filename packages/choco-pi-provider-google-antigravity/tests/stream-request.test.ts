import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  AssistantMessage,
  Context,
  GoogleOptions,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { googleAntigravityProviderConfig } from "../extensions/provider/index.ts";
import { FALLBACK_CATALOG, setActiveCatalog } from "../src/catalog/group.ts";
import type { AntigravityCatalog } from "../src/catalog/group.ts";
import { buildAntigravityUserAgent } from "../src/config.ts";
import { streamGoogleAntigravityWith } from "../src/stream/index.ts";
import type { AntigravityStreamDeps } from "../src/stream/index.ts";
import { ENV_SYSTEM_PROMPT_PLACEMENT } from "../src/stream/request.ts";
import {
  API_KEY,
  FAKE_TOKEN,
  PROJECT_ID,
  at,
  collect,
  keyPaths,
  keysAt,
  parseJson,
  piFetch,
  sentBodies,
  streamFixture,
  stringAt,
  testModel,
  transcript,
} from "./fixtures/stream/harness.ts";
import { fakeFetch, json } from "./helpers.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const noSleep: AntigravityStreamDeps = { sleep: async () => undefined, env: {} };

const tools: Tool[] = [
  {
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path." } },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Run a command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function firstContext(): Context {
  return {
    systemPrompt: "You are a coding agent.",
    tools,
    messages: [{ role: "user", content: "Reply with OK", timestamp: 1 }],
  };
}

function assistant(model: string, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

async function captureSse() {
  const text = await streamFixture("capture-response.sse");
  return () =>
    new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function catalogWithEnum(): AntigravityCatalog {
  return {
    ...FALLBACK_CATALOG,
    models: FALLBACK_CATALOG.models.map((model) =>
      model.id === "gemini-3.8-flash"
        ? {
            ...model,
            variants: model.variants.map((variant) => ({
              ...variant,
              modelEnum: "MODEL_PLACEHOLDER_REDACTED",
            })),
          }
        : model,
    ),
  };
}

afterEach(() => setActiveCatalog(undefined));

describe("streamGenerateContent request", () => {
  it("has the captured envelope key set and identity values", async () => {
    setActiveCatalog(catalogWithEnum());
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    const options: SimpleStreamOptions = {
      apiKey: API_KEY,
      reasoning: "low",
      sessionId: "session-1",
      fetch: piFetch(fake),
    };
    const { result } = await collect(
      streamGoogleAntigravityWith(testModel(), transcript(firstContext()), options, noSleep),
    );
    assert.equal(result.stopReason, "stop");
    assert.equal(fake.calls.length, 1);
    const sent = sentBodies(fake)[0];
    const capture = parseJson(await streamFixture("capture-request.json"));

    const declarations = "request.tools[].functionDeclarations[].";
    const comparable = (paths: string[]) => paths.filter((path) => !path.startsWith(declarations));
    assert.deepEqual(comparable(keyPaths(sent, 4)), comparable(keyPaths(capture, 4)));
    assert.deepEqual(keysAt(sent, "request", "labels"), keysAt(capture, "request", "labels"));
    assert.deepEqual(keysAt(sent, "request", "tools", 0, "functionDeclarations", 0), [
      "description",
      "name",
      "parametersJsonSchema",
    ]);

    assert.equal(at(sent, "project"), PROJECT_ID);
    assert.equal(at(sent, "model"), "gemini-3.8-flash-low");
    assert.equal(at(sent, "userAgent"), "antigravity");
    assert.equal(at(sent, "requestType"), "agent");
    assert.deepEqual(at(sent, "request", "generationConfig"), {
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
    });
    assert.deepEqual(at(sent, "request", "systemInstruction"), {
      role: "user",
      parts: [{ text: "You are a coding agent." }],
    });
    assert.deepEqual(at(sent, "request", "contents"), [
      { role: "user", parts: [{ text: "Reply with OK" }] },
    ]);
    const requestId = stringAt(sent, "requestId");
    const match = new RegExp(`^agent/(${UUID})/[0-9]{13}/(${UUID})/1$`).exec(requestId);
    assert.ok(match, requestId);
    const sessionId = BigInt(stringAt(sent, "request", "sessionId"));
    assert.ok(sessionId >= -(2n ** 63n) && sessionId < 2n ** 63n);
    assert.deepEqual(at(sent, "request", "labels"), {
      cascade_id: match[1],
      last_step_index: "0",
      model_enum: "MODEL_PLACEHOLDER_REDACTED",
      request_id: `${match[2]}-0`,
      root_cascade_id: match[1],
      trajectory_id: match[2],
      used_claude: "false",
      used_claude_conservative: "false",
      used_non_gemini_model: "false",
    });

    const call = fake.calls[0];
    assert.equal(
      call?.url,
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    assert.equal(call?.headers.get("authorization"), `Bearer ${FAKE_TOKEN}`);
    assert.equal(call?.headers.get("user-agent"), buildAntigravityUserAgent());
    assert.equal(call?.headers.get("content-type"), "application/json");
  });

  it("omits model_enum when the catalog has none and adds no toolConfig by default", async () => {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    await collect(
      streamGoogleAntigravityWith(
        testModel(),
        transcript(firstContext()),
        { apiKey: API_KEY, reasoning: "low", fetch: piFetch(fake) },
        noSleep,
      ),
    );
    const sent = sentBodies(fake)[0];
    assert.equal(at(sent, "request", "labels", "model_enum"), undefined);
    assert.equal(at(sent, "request", "toolConfig"), undefined);
  });

  it("keeps sessionId and conversation ids stable across turns and a retry", async () => {
    const respond = await captureSse();
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      return calls === 2 ? json(503, '{"error":{"code":503,"status":"UNAVAILABLE"}}') : respond();
    });
    const options: SimpleStreamOptions = {
      apiKey: API_KEY,
      reasoning: "low",
      sessionId: "session-stable",
      fetch: piFetch(fake),
    };
    const first = await collect(
      streamGoogleAntigravityWith(testModel(), transcript(firstContext()), options, noSleep),
    );
    const second: Context = {
      ...firstContext(),
      messages: [
        ...firstContext().messages,
        first.result,
        { role: "user", content: "Again", timestamp: 3 },
      ],
    };
    const retried = await collect(
      streamGoogleAntigravityWith(testModel(), transcript(second), options, noSleep),
    );
    assert.equal(retried.result.stopReason, "stop");
    assert.equal(fake.calls.length, 3);
    const [turn1, failed, turn2] = sentBodies(fake);
    assert.equal(fake.calls[1]?.body, fake.calls[2]?.body, "a retry resends the same body");
    const ids = (body: typeof turn1) => [
      stringAt(body, "request", "sessionId"),
      stringAt(body, "request", "labels", "cascade_id"),
      stringAt(body, "request", "labels", "trajectory_id"),
    ];
    assert.deepEqual(ids(turn1), ids(failed));
    assert.deepEqual(ids(turn1), ids(turn2));
    assert.equal(at(turn2, "request", "labels", "last_step_index"), "1");
    assert.match(stringAt(turn2, "requestId"), /\/2$/u);

    const other = fakeFetch(respond);
    await collect(
      streamGoogleAntigravityWith(
        testModel(),
        transcript(firstContext()),
        { ...options, sessionId: "another-session", fetch: piFetch(other) },
        noSleep,
      ),
    );
    assert.notEqual(stringAt(sentBodies(other)[0], "request", "sessionId"), ids(turn1)[0]);
  });

  it("sends the onPayload replacement", async () => {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    const seen: string[] = [];
    await collect(
      streamGoogleAntigravityWith(
        testModel(),
        transcript(firstContext()),
        {
          apiKey: API_KEY,
          reasoning: "low",
          fetch: piFetch(fake),
          onPayload: (payload) => {
            seen.push(JSON.stringify(payload));
            return { replaced: true, project: PROJECT_ID };
          },
        },
        noSleep,
      ),
    );
    assert.equal(seen.length, 1);
    assert.equal(at(parseJson(seen[0] ?? "null"), "model"), "gemini-3.8-flash-low");
    assert.deepEqual(sentBodies(fake)[0], { replaced: true, project: PROJECT_ID });
  });

  it("accepts both Pi option shapes (streamSimple reasoning and stream() thinking)", async () => {
    const respond = await captureSse();
    const run = async (options: SimpleStreamOptions & Pick<GoogleOptions, "thinking">) => {
      const fake = fakeFetch(respond);
      await collect(
        streamGoogleAntigravityWith(
          testModel(),
          transcript(firstContext()),
          { apiKey: API_KEY, fetch: piFetch(fake), ...options },
          noSleep,
        ),
      );
      const sent = sentBodies(fake)[0];
      return [at(sent, "model"), at(sent, "request", "generationConfig", "thinkingConfig")];
    };
    const medium = ["gemini-3.8-flash-medium", { includeThoughts: true, thinkingLevel: "MEDIUM" }];
    assert.deepEqual(await run({ reasoning: "medium" }), medium);
    assert.deepEqual(await run({ thinking: { enabled: true, level: "MEDIUM" } }), medium);
    const off = ["gemini-3.8-flash-low", { includeThoughts: false, thinkingLevel: "LOW" }];
    assert.deepEqual(await run({ thinking: { enabled: false } }), off);
    assert.deepEqual(await run({}), off);
    assert.deepEqual(await run({ reasoning: "xhigh" }), [
      "gemini-3.8-flash-high",
      { includeThoughts: true, thinkingLevel: "HIGH" },
    ]);
  });

  it("is reachable through the registered provider streamSimple", async () => {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    const config = googleAntigravityProviderConfig();
    assert.ok(config.streamSimple);
    const { result } = await collect(
      config.streamSimple(testModel(), transcript(firstContext()), {
        apiKey: API_KEY,
        reasoning: "low",
        fetch: piFetch(fake),
      }),
    );
    assert.equal(result.stopReason, "stop");
    assert.equal(result.provider, "google");
    assert.equal(result.api, "google-generative-ai");
    assert.equal(result.model, "gemini-3.8-flash");
    assert.equal(fake.calls.length, 1);
  });

  it("sends Claude tools as JSON Schema, unions included, with explicit tool-call ids", async () => {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    const unionTool: Tool = {
      name: "browse",
      description: "Browse.",
      parameters: {
        type: "object",
        properties: {
          qa: {
            anyOf: [
              {
                type: "object",
                properties: { attached: { const: true } },
                required: ["attached"],
              },
              {
                type: "object",
                properties: { attached: { const: false }, url: { type: "string" } },
                required: ["url"],
              },
            ],
          },
        },
      },
    };
    const context: Context = {
      systemPrompt: "sys",
      tools: [...tools, unionTool],
      messages: [
        { role: "user", content: "read it", timestamp: 1 },
        assistant("claude-opus-5-5", [
          { type: "toolCall", id: "toolu_01", name: "read_file", arguments: { path: "/a" } },
        ]),
        {
          role: "toolResult",
          toolCallId: "toolu_01",
          toolName: "read_file",
          content: [{ type: "text", text: "contents" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    await collect(
      streamGoogleAntigravityWith(
        testModel("claude-opus-5-5"),
        transcript(context),
        { apiKey: API_KEY, reasoning: "high", fetch: piFetch(fake) },
        noSleep,
      ),
    );
    const sent = sentBodies(fake)[0];
    assert.equal(at(sent, "model"), "claude-opus-5-5-high");
    assert.deepEqual(keysAt(sent, "request", "tools", 0, "functionDeclarations", 0), [
      "description",
      "name",
      "parametersJsonSchema",
    ]);
    const union = at(
      sent,
      "request",
      "tools",
      0,
      "functionDeclarations",
      2,
      "parametersJsonSchema",
      "properties",
      "qa",
      "anyOf",
    );
    assert.ok(Array.isArray(union) && union.length === 2, "the union reaches Claude intact");
    assert.equal(at(sent, "request", "contents", 1, "parts", 0, "functionCall", "id"), "toolu_01");
    assert.equal(
      at(sent, "request", "contents", 2, "parts", 0, "functionResponse", "id"),
      "toolu_01",
    );
    assert.equal(at(sent, "request", "labels", "used_claude"), "true");
    assert.equal(at(sent, "request", "labels", "used_non_gemini_model"), "true");
  });

  it("moves the system prompt into the first user turn only when switched on", async () => {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    await collect(
      streamGoogleAntigravityWith(
        testModel(),
        transcript(firstContext()),
        {
          apiKey: API_KEY,
          reasoning: "low",
          fetch: piFetch(fake),
          env: { [ENV_SYSTEM_PROMPT_PLACEMENT]: "first_user_turn" },
        },
        noSleep,
      ),
    );
    const sent = sentBodies(fake)[0];
    assert.equal(at(sent, "request", "systemInstruction"), undefined);
    assert.deepEqual(at(sent, "request", "contents", 0), {
      role: "user",
      parts: [{ text: "You are a coding agent." }, { text: "Reply with OK" }],
    });
  });

  it("never lets caller headers replace Authorization or User-Agent", async () => {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    await collect(
      streamGoogleAntigravityWith(
        testModel(),
        transcript(firstContext()),
        {
          apiKey: API_KEY,
          fetch: piFetch(fake),
          headers: { Authorization: "Bearer other", "User-Agent": "pi", "X-Extra": "1" },
        },
        noSleep,
      ),
    );
    const headers = fake.calls[0]?.headers;
    assert.equal(headers?.get("authorization"), `Bearer ${FAKE_TOKEN}`);
    assert.equal(headers?.get("user-agent"), buildAntigravityUserAgent());
    assert.equal(headers?.get("x-extra"), "1");
  });
});

describe("generationConfig matches agy 1.5.14", () => {
  async function generationConfig(
    modelId: string,
    options: SimpleStreamOptions & Pick<GoogleOptions, "thinking">,
  ) {
    const respond = await captureSse();
    const fake = fakeFetch(respond);
    await collect(
      streamGoogleAntigravityWith(
        testModel(modelId),
        transcript(firstContext()),
        { apiKey: API_KEY, fetch: piFetch(fake), ...options },
        noSleep,
      ),
    );
    const sent = sentBodies(fake)[0];
    return { model: at(sent, "model"), config: at(sent, "request", "generationConfig") };
  }

  it("sends xhigh as the numeric thinkingLevel 100 and keeps named levels otherwise", async () => {
    assert.deepEqual(await generationConfig("gemini-4-neon", { reasoning: "xhigh" }), {
      model: "gemini-4-neon-xhigh",
      config: {
        maxOutputTokens: 262_144,
        thinkingConfig: { includeThoughts: true, thinkingLevel: 100 },
      },
    });
    assert.deepEqual(await generationConfig("gemini-4-neon", { reasoning: "max" }), {
      model: "gemini-4-neon-xhigh",
      config: {
        maxOutputTokens: 262_144,
        thinkingConfig: { includeThoughts: true, thinkingLevel: 100 },
      },
    });
    assert.deepEqual(await generationConfig("gemini-4-neon", { reasoning: "high" }), {
      model: "gemini-4-neon-high",
      config: {
        maxOutputTokens: 262_144,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      },
    });
    assert.deepEqual(await generationConfig("claude-sonnet-5-5", { reasoning: "xhigh" }), {
      model: "claude-sonnet-5-5-high",
      config: {
        maxOutputTokens: 128_000,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      },
    });
  });

  it("sends no temperature, topP or topK for any family", async () => {
    for (const modelId of ["gemini-4-neon", "gemini-3.8-flash", "claude-sonnet-5-5"]) {
      const { config } = await generationConfig(modelId, { reasoning: "high", temperature: 0.3 });
      assert.deepEqual(keysAt(config), ["maxOutputTokens", "thinkingConfig"], modelId);
    }
  });
});
