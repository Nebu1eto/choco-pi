import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { bool, compile, num, obj, str } from "@earendil-works/pi-schema";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";

const namedToolValidator = compile(obj({ name: str() }, { open: true }));
const roleValidator = compile(obj({ role: str() }, { open: true }));

const MODEL: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 100_000,
};

const CONTEXT: Context = {
  systemPrompt: "Keep the request prefix stable.",
  messages: [{ role: "user", content: "Inspect the request.", timestamp: 1 }],
  tools: [
    {
      name: "zeta",
      description: "Runs after alpha alphabetically but first by registration.",
      parameters: obj({ value: str() }, { open: true }),
    },
    {
      name: "alpha",
      description: "Runs before zeta alphabetically but second by registration.",
      parameters: obj({ count: num() }, { open: true }),
    },
  ],
};
const TRANSCRIPT = normalizeContext(CONTEXT);

test("buildRequestBody keeps session cache identity and request ordering stable", () => {
  const sessionId = `session-${"😀".repeat(80)}`;
  const expectedCacheKey = Array.from(sessionId).slice(0, 64).join("");

  const first = buildRequestBody(MODEL, TRANSCRIPT, { sessionId });
  const second = buildRequestBody(MODEL, TRANSCRIPT, { sessionId });

  assert.equal(first.prompt_cache_key, expectedCacheKey);
  assert.equal(second.prompt_cache_key, expectedCacheKey);
  assert.deepEqual(first.client_metadata, { session_id: sessionId, thread_id: sessionId });
  assert.deepEqual(first, second);

  const firstJson = JSON.stringify(first);
  assert.equal(firstJson, JSON.stringify(second));
  assert.ok(firstJson.indexOf('"instructions"') < firstJson.indexOf('"tools"'));
  assert.ok(firstJson.indexOf('"name":"zeta"') < firstJson.indexOf('"name":"alpha"'));
});

test("buildRequestBody omits unsupported prompt cache retention", () => {
  const previous = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = "long";
  try {
    const body = buildRequestBody(MODEL, TRANSCRIPT, { sessionId: "session-stable" });
    assert.equal("prompt_cache_retention" in body, false);
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
  }
});

test("buildRequestBody replays transcript instructions and current tools exactly once", () => {
  const initial = CONTEXT.tools ?? [];
  const transcript = normalizeContext({
    systemPrompt: "Initial instructions.",
    tools: initial,
    messages: [
      { role: "user", content: "Before the update.", timestamp: 1 },
      {
        role: "system",
        content: "Updated instructions.",
        toolsAdded: [
          {
            name: "gamma",
            description: "Added later.",
            parameters: obj({ enabled: bool() }, { open: true }),
          },
        ],
        toolsRemoved: [{ name: "zeta" }],
        timestamp: 2,
      },
      { role: "user", content: "After the update.", timestamp: 3 },
    ],
  });

  const body = buildRequestBody(MODEL, transcript);
  assert.equal(body.instructions, "Initial instructions.\n\nUpdated instructions.");
  assert.equal(JSON.stringify(body).match(/Initial instructions\./g)?.length, 1);
  assert.deepEqual(
    body.tools?.map((tool) => (namedToolValidator.check(tool) ? tool.name : undefined)),
    ["alpha", "gamma"],
  );
  assert.equal(
    body.input.some((item) => JSON.stringify(item).includes("Updated instructions.")),
    false,
  );
});

test("buildRequestBody preserves later system messages only for compatible models", () => {
  const transcript = normalizeContext({
    systemPrompt: "Leading instructions.",
    tools: CONTEXT.tools ?? [],
    messages: [
      { role: "user", content: "Before.", timestamp: 1 },
      { role: "system", content: "Later instructions.", timestamp: 2 },
      { role: "user", content: "After.", timestamp: 3 },
    ],
  });

  const supported = buildRequestBody(
    { ...MODEL, compat: { supportsMidConvoSystemMessages: true } },
    transcript,
  );
  assert.equal(supported.instructions, "Leading instructions.");
  assert.equal(JSON.stringify(supported).match(/Leading instructions\./g)?.length, 1);
  assert.equal(
    supported.input.filter(
      (item) =>
        roleValidator.check(item) &&
        item.role === "developer" &&
        JSON.stringify(item).includes("Later instructions."),
    ).length,
    1,
  );

  const collapsed = buildRequestBody(
    { ...MODEL, compat: { supportsMidConvoSystemMessages: false } },
    transcript,
  );
  assert.equal(collapsed.instructions, "Leading instructions.\n\nLater instructions.");
  assert.equal(JSON.stringify(collapsed).match(/Leading instructions\./g)?.length, 1);
  assert.equal(
    collapsed.input.some(
      (item) => roleValidator.check(item) && JSON.stringify(item).includes("Later instructions."),
    ),
    false,
  );
});

test("buildRequestBody sends an explicit off reasoning effort when the model supports it", () => {
  const body = buildRequestBody({ ...MODEL, thinkingLevelMap: { off: "none" } }, TRANSCRIPT);
  assert.deepEqual(body.reasoning, { effort: "none" });
});
