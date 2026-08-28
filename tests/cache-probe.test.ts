import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheableSegments,
  canonicalJson,
  changedSystemRegions,
  diffCacheableSegments,
  providerPrefixMetricsFromPayload,
  systemRegionHashes,
  systemText,
} from "../.pi/extensions/cache-probe.ts";

test("canonicalJson is stable across object key order", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: true, a: null }], a: "value" }),
    canonicalJson({ a: "value", b: [2, { a: null, z: true }] }),
  );
});

test("cacheableSegments includes messages only through the last cache breakpoint", () => {
  const snapshot = cacheableSegments({
    system: [{ type: "text", text: "system" }],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: [{ type: "text", text: "cached history" }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  });

  assert.deepEqual(
    snapshot.segments.map((segment) => segment.kind),
    ["system", "tools", "message"],
  );
  assert.deepEqual(snapshot.toolNames, ["read"]);
});

test("diffCacheableSegments identifies tool changes and segment growth", () => {
  const previous = cacheableSegments({
    system: "system",
    tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
  });
  const changedTools = cacheableSegments({
    system: "system",
    tools: [{ name: "grep", description: "Search", input_schema: { type: "object" } }],
  });
  const grownMessages = cacheableSegments({
    system: "system",
    tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "cached", cache_control: {} }] }],
  });

  assert.deepEqual(diffCacheableSegments(previous.segments, changedTools.segments), {
    firstDivergence: 1,
    divergedKind: "tools",
    segmentsAdded: 0,
    segmentsRemoved: 0,
  });
  assert.deepEqual(diffCacheableSegments(previous.segments, grownMessages.segments), {
    firstDivergence: 2,
    divergedKind: "message",
    segmentsAdded: 1,
    segmentsRemoved: 0,
  });
});

const SYSTEM = [
  "<runtime_environment>",
  'Current model: "anthropic/claude-opus-5"',
  "</runtime_environment>",
  "Base rules and project context files.",
  "<choco_pi_writing_policy>",
  "Be concise.",
  "</choco_pi_writing_policy>",
].join("\n");

test("systemText reads the prompt from a string or a block array", () => {
  assert.equal(systemText({ system: "plain" }), "plain");
  assert.equal(
    systemText({
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
    "first\nsecond",
  );
  assert.equal(systemText({}), "");
  assert.equal(systemText({ instructions: "codex instructions" }), "codex instructions");
});

test("Codex Responses instructions and tools contribute provider prefix metrics", () => {
  const payload = {
    instructions: "x".repeat(40),
    tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    input: [{ role: "user", content: "hello" }],
  };

  const metrics = providerPrefixMetricsFromPayload(payload);
  const snapshot = cacheableSegments(payload);

  assert.equal(metrics.systemTokens, 10);
  assert.equal(metrics.toolCount, 1);
  assert.ok(metrics.toolsTokens > 0);
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.kind),
    ["system", "tools"],
  );
});

test("OpenAI Chat system messages and nested tools contribute provider prefix metrics", () => {
  const systemPrompt = "x".repeat(40);
  const functionDefinition = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  };
  const payload = {
    messages: [
      { role: "developer", content: systemPrompt },
      { role: "user", content: "hello" },
      { role: "system", tools: [{ type: "function", function: functionDefinition }] },
    ],
    tools: [{ type: "function", function: functionDefinition }],
  };

  const metrics = providerPrefixMetricsFromPayload(payload);
  const flatMetrics = providerPrefixMetricsFromPayload({
    tools: [functionDefinition],
  });
  const snapshot = cacheableSegments(payload);

  assert.equal(systemText(payload), systemPrompt);
  assert.equal(metrics.systemTokens, 10);
  assert.equal(metrics.toolCount, 1);
  assert.equal(metrics.toolsTokens, flatMetrics.toolsTokens);
  assert.deepEqual(snapshot.toolNames, ["read"]);
});

test("a system change names the region that moved, not just the block", () => {
  const before = systemRegionHashes(SYSTEM);

  // The model name lives inside the runtime block, so only that region moves.
  const switched = systemRegionHashes(SYSTEM.replace("claude-opus-5", "claude-fable-5"));
  assert.deepEqual(changedSystemRegions(before, switched), ["runtime-environment"]);

  // An edited policy file moves only its own block.
  const policy = systemRegionHashes(SYSTEM.replace("Be concise.", "Be extremely concise."));
  assert.deepEqual(changedSystemRegions(before, policy), ["writing-policy"]);

  // Anything no marker claims — Pi's prompt, context files — lands in base.
  const context = systemRegionHashes(`${SYSTEM}\nAn added AGENTS.md section.`);
  assert.deepEqual(changedSystemRegions(before, context), ["base"]);

  assert.deepEqual(changedSystemRegions(before, systemRegionHashes(SYSTEM)), []);
  assert.deepEqual(changedSystemRegions(undefined, before), [], "the first turn has no baseline");
});

test("a dropped region is reported rather than silently ignored", () => {
  const before = systemRegionHashes(SYSTEM);
  const withoutPolicy = systemRegionHashes(
    SYSTEM.slice(0, SYSTEM.indexOf("<choco_pi_writing_policy>")),
  );
  // The remainder is untouched, so only the dropped block is named.
  assert.deepEqual(changedSystemRegions(before, withoutPolicy), ["writing-policy"]);
});
