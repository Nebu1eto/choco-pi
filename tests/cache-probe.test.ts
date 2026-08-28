import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import cacheProbe from "../.pi/extensions/cache-probe.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  cachePayloadMetadata,
  createRequestLinker,
  cacheableSegments,
  canonicalJson,
  changedSystemRegions,
  diffCacheableSegments,
  providerPrefixMetricsFromPayload,
  prefixAttribution,
  systemRegionHashes,
  systemText,
} from "../.pi/extensions/cache-probe.ts";

test("canonicalJson is stable across object key order", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: true, a: null }], a: "value" }),
    canonicalJson({ a: "value", b: [2, { a: null, z: true }] }),
  );
});

test("Anthropic cacheableSegments stops at the last explicit cache breakpoint", () => {
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

test("Anthropic breakpoints bound system, tools, and messages as one ordered prefix", () => {
  const snapshot = cacheableSegments(
    {
      provider: "anthropic",
      system: [
        { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
        { type: "text", text: "not cached" },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "latest" }],
    },
    "anthropic",
  );

  assert.deepEqual(
    snapshot.segments.map((segment) => segment.kind),
    ["system"],
  );
});

test("diffCacheableSegments identifies tool changes and segment growth", () => {
  const previous = cacheableSegments(
    {
      system: "system",
      tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
    },
    "openai",
  );
  const changedTools = cacheableSegments(
    {
      system: "system",
      tools: [{ name: "grep", description: "Search", input_schema: { type: "object" } }],
    },
    "openai",
  );
  const grownMessages = cacheableSegments(
    {
      system: "system",
      tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "cached", cache_control: {} }] }],
    },
    "openai",
  );

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
    ["system", "tools", "message"],
  );
});

test("OpenAI Responses fingerprints the complete append-only input history", () => {
  const before = cacheableSegments(
    {
      provider: "openai",
      instructions: "system",
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    },
    "openai",
  );
  const after = cacheableSegments(
    {
      provider: "openai",
      instructions: "system",
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    },
    "openai",
  );

  assert.deepEqual(
    before.segments.map((segment) => segment.kind),
    ["system", "message", "message"],
  );
  assert.deepEqual(diffCacheableSegments(before.segments, after.segments), {
    firstDivergence: 3,
    divergedKind: "message",
    segmentsAdded: 1,
    segmentsRemoved: 0,
  });
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
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.kind),
    ["tools", "system", "message", "system"],
  );
});

test("OpenAI Chat fingerprints all history and nested tool definitions", () => {
  const payload = {
    provider: "openai",
    messages: [
      { role: "system", content: "system" },
      { role: "developer", content: [{ type: "text", text: "developer" }] },
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { query: { type: "string", enum: ["a", "b"] } },
          },
        },
      },
    ],
  };
  const snapshot = cacheableSegments(payload, "openai");

  assert.deepEqual(
    snapshot.segments.map((segment) => segment.kind),
    ["tools", "system", "system", "message", "message"],
  );
  assert.deepEqual(snapshot.toolNames, ["lookup"]);

  const changedNestedTool = cacheableSegments(
    {
      ...payload,
      tools: [{ ...payload.tools[0], function: { ...payload.tools[0].function, strict: true } }],
    },
    "openai",
  );
  assert.equal(
    diffCacheableSegments(snapshot.segments, changedNestedTool.segments).divergedKind,
    "tools",
  );
});

test("prefix attribution distinguishes initial, model, system, tool, and message changes", () => {
  const basePayload = {
    provider: "openai",
    model: "gpt-5",
    instructions: SYSTEM,
    tools: [{ name: "read", parameters: { type: "object" } }],
    input: [{ role: "user", content: "hello" }],
  };
  const base = cacheableSegments(basePayload, "openai");
  const regions = systemRegionHashes(SYSTEM);
  assert.deepEqual(
    prefixAttribution({
      previous: undefined,
      current: base.segments,
      previousRegions: undefined,
      currentRegions: regions,
      previousModel: undefined,
      currentModel: "gpt-5",
    }),
    {
      firstDivergence: null,
      divergedKind: null,
      segmentsAdded: 0,
      segmentsRemoved: 0,
      state: "initial",
      systemRegions: [],
      modelChanged: false,
    },
  );

  const changedSystemText = SYSTEM.replace("Be concise.", "Be precise.");
  const changedSystem = cacheableSegments(
    { ...basePayload, instructions: changedSystemText },
    "openai",
  );
  const systemChange = prefixAttribution({
    previous: base.segments,
    current: changedSystem.segments,
    previousRegions: regions,
    currentRegions: systemRegionHashes(changedSystemText),
    previousModel: "gpt-5",
    currentModel: "gpt-5",
  });
  assert.equal(systemChange.state, "restart");
  assert.equal(systemChange.divergedKind, "system");
  assert.deepEqual(systemChange.systemRegions, ["writing-policy"]);

  const changedTools = cacheableSegments(
    { ...basePayload, tools: [{ name: "search", parameters: { type: "object" } }] },
    "openai",
  );
  assert.equal(
    prefixAttribution({
      previous: base.segments,
      current: changedTools.segments,
      previousRegions: regions,
      currentRegions: regions,
      previousModel: "gpt-5",
      currentModel: "gpt-5",
    }).divergedKind,
    "tools",
  );

  const changedMessage = cacheableSegments(
    { ...basePayload, input: [{ role: "user", content: "changed" }] },
    "openai",
  );
  assert.equal(
    prefixAttribution({
      previous: base.segments,
      current: changedMessage.segments,
      previousRegions: regions,
      currentRegions: regions,
      previousModel: "gpt-5",
      currentModel: "gpt-5",
    }).divergedKind,
    "message",
  );

  const modelRestart = prefixAttribution({
    previous: undefined,
    current: base.segments,
    previousRegions: undefined,
    currentRegions: regions,
    previousModel: "gpt-5",
    currentModel: "gpt-6",
  });
  assert.equal(modelRestart.state, "restart");
  assert.equal(modelRestart.modelChanged, true);
});

test("cache metadata hashes and bounds cache keys and validates retention without raw values", () => {
  const secret = "secret-cache-key";
  const metadata = cachePayloadMetadata({
    prompt_cache_key: secret,
    prompt_cache_retention: "24h",
    input: [{ role: "user", content: "raw prompt" }],
    credentials: "never-record-this",
  });
  assert.equal(metadata.promptCacheKeyPresent, true);
  assert.match(metadata.promptCacheKeyHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(metadata.promptCacheKeyTruncated, false);
  assert.equal(metadata.promptCacheRetention, "24h");
  assert.equal(metadata.promptCacheRetentionValid, true);
  assert.doesNotMatch(JSON.stringify(metadata), /secret-cache-key|raw prompt|never-record-this/);

  const invalid = cachePayloadMetadata({ prompt_cache_retention: "credential-like-value" });
  assert.deepEqual(invalid, {
    promptCacheKeyPresent: false,
    promptCacheRetentionPresent: true,
    promptCacheRetentionValid: false,
  });

  const longKey = "x".repeat(1_024);
  const cappedA = cachePayloadMetadata({ prompt_cache_key: `${longKey}A` });
  const cappedB = cachePayloadMetadata({ prompt_cache_key: `${longKey}B` });
  assert.equal(cappedA.promptCacheKeyHash, cappedB.promptCacheKeyHash);
  assert.equal(cappedA.promptCacheKeyTruncated, true);
});

test("request linker is deterministic and refuses ambiguous overlap linkage", () => {
  const linker = createRequestLinker();
  assert.deepEqual(linker.begin("a"), { requestId: 1, overlap: false });
  assert.deepEqual(linker.begin("b"), { requestId: 2, overlap: false });
  assert.deepEqual(linker.finish("a"), { requestId: 1, note: null });
  assert.deepEqual(linker.finish("missing"), { note: "unmatched-assistant-message" });

  assert.deepEqual(linker.begin("b"), { requestId: 3, overlap: true });
  assert.deepEqual(linker.finish("b"), { note: "overlapping-requests-unlinked" });
  assert.deepEqual(linker.finish("b"), { note: "overlapping-requests-unlinked" });
});

test("cache-less assistant events do not consume observable usage linkage", () => {
  const home = mkdtempSync(path.join(tmpdir(), "cache-probe-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    type TestProviderEvent = {
      payload: {
        provider: string;
        model: string;
        instructions: string;
        input: never[];
      };
    };
    type TestMessageEvent = {
      message: {
        role: string;
        provider: string;
        model: string;
        usage: { cacheRead?: number };
      };
    };
    type TestContext = {
      model: { provider: string; id: string };
      sessionManager: { getSessionId: () => string };
    };
    type HostHandler = (event: TestProviderEvent | TestMessageEvent, ctx: TestContext) => void;
    const handlers = new Map<string, HostHandler>();
    cacheProbe(
      reinterpretHostValue<Parameters<typeof cacheProbe>[0]>({
        on(name: string, handler: HostHandler) {
          handlers.set(name, handler);
        },
      }),
    );
    const ctx = {
      model: { provider: "openai", id: "gpt-5" },
      sessionManager: { getSessionId: () => "linkage-stream" },
    };
    handlers.get("before_provider_request")?.(
      { payload: { provider: "openai", model: "gpt-5", instructions: "system", input: [] } },
      ctx,
    );
    handlers.get("message_end")?.(
      { message: { role: "assistant", provider: "openai", model: "gpt-5", usage: {} } },
      ctx,
    );
    handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5",
          usage: { cacheRead: 7 },
        },
      },
      ctx,
    );

    const day = new Date().toISOString().slice(0, 10);
    const records = readFileSync(
      path.join(home, ".pi", "agent", "cache-probe", `${day}.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => reinterpretHostValue<{ type: string; requestId?: number }>(JSON.parse(line)));
    const usageRecords = records.filter((record) => record.type === "usage");
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0]?.requestId, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
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
