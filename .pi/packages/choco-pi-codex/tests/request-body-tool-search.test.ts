/**
 * Pi's built-in `tool_search` on the openai-codex provider.
 *
 * Decision: the built-in is declared to the provider as an ordinary function
 * tool in the initial (cached) tool list, exactly like the custom tool it
 * replaced. Tools it loads mid-session never join the top-level `tools` field:
 * on a model with additional-tools or native tool-search support they are
 * anchored in the transcript (`additional_tools`, or a client
 * `tool_search_call`/`tool_search_output` pair with `defer_loading`), so the
 * request prefix stays byte-identical across the load.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeContext,
  type Model,
  type SystemMessage,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";

const TOOL_SEARCH: Tool = {
  name: "tool_search",
  description: "# Tool discovery",
  parameters: Type.Object({ query: Type.String() }),
};
const READ: Tool = {
  name: "read",
  description: "Read a file",
  parameters: Type.Object({ path: Type.String() }),
};
const LOADED: Tool = {
  name: "mcp__radius__list_issues",
  description: "List Radius issues",
  parameters: Type.Object({}),
};

function model(compat: Record<string, boolean>): Model<"openai-codex-responses"> {
  return {
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
    compat: { supportsMidConvoSystemMessages: true, ...compat },
  };
}

function transcript(withLoad: boolean): TranscriptContext {
  // What Pi records when tool_search activates a match: an additive system message.
  const load: SystemMessage = { role: "system", content: "", toolsAdded: [LOADED], timestamp: 2 };
  return normalizeContext({
    systemPrompt: "Instructions.",
    tools: [READ, TOOL_SEARCH],
    messages: [
      { role: "user", content: "Find the issues tool.", timestamp: 1 },
      ...(withLoad ? [load] : []),
    ],
  });
}

function topLevelToolNames(body: ReturnType<typeof buildRequestBody>): string[] {
  return (JSON.stringify(body.tools ?? []).match(/"name":"[^"]+"/g) ?? []).map((entry) =>
    entry.slice(8, -1),
  );
}

for (const [label, compat, anchor] of [
  ["additional tools", { supportsAdditionalTools: true }, /"type":"additional_tools"/],
  ["native tool search", { supportsToolSearch: true }, /"type":"tool_search_output"/],
] as const) {
  test(`${label}: tool_search is declared and its loads keep the prefix`, () => {
    const before = buildRequestBody(model(compat), transcript(false), { sessionId: "s" });
    const after = buildRequestBody(model(compat), transcript(true), { sessionId: "s" });

    assert.deepEqual(topLevelToolNames(before), ["read", "tool_search"]);
    assert.deepEqual(JSON.stringify(after.tools), JSON.stringify(before.tools));
    assert.equal(after.instructions, before.instructions);
    const input = JSON.stringify(after.input);
    assert.match(input, anchor);
    assert.match(input, /mcp__radius__list_issues/);
  });
}

test("without anchored additions the loaded tool joins the current tool list", () => {
  const body = buildRequestBody(model({}), transcript(true), { sessionId: "s" });
  assert.deepEqual(topLevelToolNames(body), ["read", "tool_search", "mcp__radius__list_issues"]);
});
