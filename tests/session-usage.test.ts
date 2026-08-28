import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import statusCommands from "../.pi/extensions/status-commands.ts";
import {
  computeCacheWaste,
  formatSessionInfo,
  formatTokens,
  subagentTranscriptDirs,
  summarizeMainUsage,
  summarizeSubagentUsage,
  totalTokens,
  type CacheWaste,
  type MainUsage,
  type SubagentUsage,
} from "../.pi/extensions/lib/session-usage.ts";
import {
  isFunction,
  reinterpretHostValue,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";

type UsageInput = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costInput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costTotal?: number;
};

function usage(values: UsageInput) {
  const input = values.input ?? 0;
  const output = values.output ?? 0;
  const cacheRead = values.cacheRead ?? 0;
  const cacheWrite = values.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: values.costInput ?? 0,
      output: 0,
      cacheRead: values.costCacheRead ?? 0,
      cacheWrite: values.costCacheWrite ?? 0,
      total: values.costTotal ?? 0,
    },
  };
}

let nextEntryId = 0;

function assistantEntry(
  provider: string,
  model: string,
  values: UsageInput,
  extra: { responseModel?: string; toolCalls?: number } = {},
): SessionEntry {
  const toolCalls = Array.from({ length: extra.toolCalls ?? 0 }, () => ({ type: "toolCall" }));
  // SAFETY: the fixture supplies every message member the summarizers read.
  return reinterpretHostValue<SessionEntry>({
    type: "message",
    id: `e${(nextEntryId += 1)}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      provider,
      model,
      responseModel: extra.responseModel,
      content: toolCalls,
      usage: usage(values),
      timestamp: nextEntryId,
    },
  });
}

function simpleEntry(type: string, extra: Record<string, RuntimeValue> = {}): SessionEntry {
  // SAFETY: the fixture supplies every entry member the summarizers read.
  return reinterpretHostValue<SessionEntry>({
    type,
    id: `e${(nextEntryId += 1)}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

test("formatTokens matches Pi's compact scale at every boundary", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(10_000), "10k");
  assert.equal(formatTokens(177_237), "177k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(10_000_000), "10M");
  assert.equal(formatTokens(75_145_837), "75M");
});

test("summarizeMainUsage counts messages and attributes cost per response model", () => {
  const entries: SessionEntry[] = [
    simpleEntry("message", { message: { role: "user", content: [] } }),
    assistantEntry(
      "anthropic",
      "claude-fable-5",
      { input: 100, output: 20, costTotal: 1.5 },
      {
        toolCalls: 2,
      },
    ),
    simpleEntry("message", {
      message: { role: "toolResult", usage: usage({ input: 7, costTotal: 0.25 }) },
    }),
    simpleEntry("message", { message: { role: "toolResult" } }),
    // OpenRouter's `auto` resolves to a concrete model; the resolved one is billed.
    assistantEntry(
      "openrouter",
      "auto",
      { input: 50, output: 10, costTotal: 0.75 },
      {
        responseModel: "gpt-5.6-sol",
      },
    ),
    simpleEntry("compaction", { usage: usage({ input: 3, costTotal: 0.1 }) }),
  ];

  const summary = summarizeMainUsage(entries);
  assert.deepEqual(summary.counts, {
    total: 5,
    user: 1,
    assistant: 2,
    toolCalls: 2,
    toolResults: 2,
  });
  assert.equal(summary.totals.cost.toFixed(2), "2.60");
  assert.deepEqual(
    summary.breakdown.map((entry) => entry.key),
    ["anthropic/claude-fable-5", "openrouter/gpt-5.6-sol", "Tools/summaries"],
  );
  const other = summary.breakdown.find((entry) => entry.key === "Tools/summaries");
  assert.equal(other?.tokens, 10, "tool and compaction usage share one bucket");
});

test("computeCacheWaste bills material full and partial cache collapse", () => {
  const prices = { find: () => ({ cost: { cacheRead: 0.3 } }) };
  const entries: SessionEntry[] = [
    assistantEntry("anthropic", "claude-fable-5", { cacheWrite: 150_000 }),
    // 60,000 tokens of the reusable prompt were billed at $3/M instead of read at $0.30/M.
    assistantEntry("anthropic", "claude-fable-5", {
      input: 60_000,
      costInput: 0.18,
      cacheRead: 90_000,
      costCacheRead: 0.027,
    }),
    // The next turn loses the cache entirely.
    assistantEntry("anthropic", "claude-fable-5", {
      input: 150_000,
      costInput: 0.45,
      cacheRead: 0,
    }),
  ];

  const waste = computeCacheWaste(entries, prices);
  assert.equal(waste.missCount, 2);
  assert.equal(waste.missedTokens, 210_000);
  assert.equal(waste.missedCost.toFixed(3), "0.567");
});

test("computeCacheWaste ignores absolute and proportional breakpoint noise", () => {
  const prices = { find: () => ({ cost: { cacheRead: 0.3 } }) };
  const previous = assistantEntry("anthropic", "claude-fable-5", { cacheWrite: 147_224 });
  const stablePrefix = computeCacheWaste(
    [
      previous,
      assistantEntry("anthropic", "claude-fable-5", {
        input: 4_403,
        cacheRead: 146_176,
      }),
    ],
    prices,
  );
  assert.deepEqual(stablePrefix, { missedTokens: 0, missedCost: 0, missCount: 0 });

  const noisy = computeCacheWaste(
    [
      assistantEntry("anthropic", "claude-fable-5", { cacheWrite: 20_000 }),
      assistantEntry("anthropic", "claude-fable-5", { cacheRead: 19_500, input: 500 }),
    ],
    prices,
  );
  assert.deepEqual(noisy, { missedTokens: 0, missedCost: 0, missCount: 0 });
});

test("computeCacheWaste does not count a cold-start prompt", () => {
  const waste = computeCacheWaste(
    [assistantEntry("anthropic", "claude-fable-5", { input: 150_000, costInput: 0.45 })],
    { find: () => ({ cost: { cacheRead: 0.3 } }) },
  );
  assert.deepEqual(waste, { missedTokens: 0, missedCost: 0, missCount: 0 });
});

test("computeCacheWaste restarts after compaction and branch summaries", () => {
  for (const resetType of ["compaction", "branch_summary"]) {
    const entries: SessionEntry[] = [
      assistantEntry("anthropic", "claude-fable-5", { cacheWrite: 150_000 }),
      simpleEntry(resetType),
      assistantEntry("anthropic", "claude-fable-5", { input: 150_000, costInput: 0.45 }),
    ];
    const waste = computeCacheWaste(entries, { find: () => undefined });
    assert.equal(waste.missCount, 0, `post-${resetType} prompt is new content`);
  }
});

test("computeCacheWaste charges a material miss across a model switch", () => {
  const waste = computeCacheWaste(
    [
      assistantEntry("anthropic", "claude-fable-5", { cacheWrite: 100_000 }),
      assistantEntry("openai-codex", "gpt-5.6-sol", { input: 100_000, costInput: 0.2 }),
    ],
    { find: () => ({ cost: { cacheRead: 0.5 } }) },
  );
  assert.equal(waste.missCount, 1);
  assert.equal(waste.missedTokens, 100_000);
  assert.equal(waste.missedCost.toFixed(3), "0.150");
});

test("summarizeSubagentUsage totals every agent transcript under one root session", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-subagent-usage-"));
  const originalTmp = process.env["TMPDIR"];
  process.env["TMPDIR"] = root;
  context.after(async () => {
    if (originalTmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = originalTmp;
    await rm(root, { recursive: true, force: true });
  });

  const sessionId = "01a02297-90eb-765c-a0e4-bb28e8162b40";
  const base = path.join(root, `choco-pi-subagents-${process.getuid?.() ?? 0}`);
  // A nested agent files under its own config root but the same root session id.
  const orchestrator = path.join(base, "Users-me-project", sessionId, "tasks");
  const nested = path.join(base, "Users-me-project-wt-1", sessionId, "tasks");
  const otherSession = path.join(base, "Users-me-project", "another-session", "tasks");
  await mkdir(orchestrator, { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(otherSession, { recursive: true });

  const line = (message: RuntimeValue): string => JSON.stringify({ isSidechain: true, message });
  await writeFile(
    path.join(orchestrator, "aaaa.output"),
    [
      line({ role: "user", content: "go" }),
      line({
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: usage({ input: 100, output: 50, cacheRead: 900, costTotal: 2 }),
      }),
      line({ role: "toolResult", content: "…" }),
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(nested, "bbbb.output"),
    `${line({
      role: "assistant",
      provider: "anthropic",
      model: "claude-fable-5",
      usage: usage({ input: 10, output: 5, costTotal: 0.5 }),
    })}\n`,
  );
  await writeFile(
    path.join(otherSession, "cccc.output"),
    `${line({
      role: "assistant",
      provider: "anthropic",
      model: "claude-fable-5",
      usage: usage({ input: 999, costTotal: 99 }),
    })}\n`,
  );

  assert.equal(subagentTranscriptDirs(sessionId).length, 2);
  const summary = summarizeSubagentUsage(sessionId);
  assert.equal(summary.agents, 2, "a transcript with no usage must not count as an agent");
  assert.equal(summary.totals.cost, 2.5);
  assert.equal(totalTokens(summary.totals), 1065);
  assert.deepEqual(
    summary.breakdown.map((entry) => entry.key),
    ["openai-codex/gpt-5.6-sol", "anthropic/claude-fable-5"],
  );

  assert.deepEqual(subagentTranscriptDirs("../escape"), [], "a session id is never a path");
});

const NO_SUBAGENTS: SubagentUsage = {
  agents: 0,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  breakdown: [],
  directories: [],
};

const NO_WASTE: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };

const MAIN: MainUsage = {
  counts: { total: 504, user: 30, assistant: 243, toolCalls: 231, toolResults: 231 },
  totals: {
    input: 172_327,
    output: 495_445,
    cacheRead: 65_882_725,
    cacheWrite: 6_686_525,
    cost: 226.109,
  },
  breakdown: [
    { key: "anthropic/claude-fable-5", cost: 224.121, tokens: 73_059_785 },
    { key: "Tools/summaries", cost: 1.988, tokens: 177_237 },
  ],
};

test("formatSessionInfo renders a concise, unstyled session summary", () => {
  const sessionFile = path.join(homedir(), ".pi", "agent", "sessions", "main.jsonl");
  const body = formatSessionInfo({
    sessionName: undefined,
    sessionFile,
    cwd: "/workspace/project",
    sessionId: "01a02297",
    main: MAIN,
    cacheWaste: { missedTokens: 5_662_340, missedCost: 107.584, missCount: 37 },
    subagents: NO_SUBAGENTS,
    subagentsRunning: false,
  });

  assert.equal(body.split("\n")[0], "Session Info");
  assert.match(body, /^File {8}~\/\.pi\/agent\/sessions\/main\.jsonl \(missing\)$/m);
  assert.ok(!body.includes(sessionFile), "the full absolute session path is not shown");
  assert.match(body, /^Messages {4}504 total · 30 user · 243 assistant · 231 tool calls$/m);
  assert.match(body, /^Tokens {6}72\.7M in · 90\.6% cached · 495\.4k out$/m);
  assert.match(body, /^Cost {8}\$226\.11 total$/m);
  assert.match(body, /^  main {2}claude-fable-5 {2}\$224\.12 · 73\.1M tok$/m);
  assert.match(body, /^  cache re-billed {2}\$107\.58 · 5\.7M tok · 37 misses$/m);
  assert.ok(!body.includes("\u001b"), "plain output contains no ANSI escapes");
});

test("formatSessionInfo separates the main agent from its sub-agents in the total", () => {
  const body = formatSessionInfo({
    sessionName: "novaid",
    sessionFile: undefined,
    sessionId: "01a02297",
    main: MAIN,
    cacheWaste: NO_WASTE,
    subagents: {
      agents: 35,
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 212_000_000, cost: 198.965 },
      breakdown: [
        { key: "openai-codex/gpt-5.6-sol", cost: 127.669, tokens: 178_000_000 },
        { key: "anthropic/claude-fable-5", cost: 68.094, tokens: 30_000_000 },
      ],
      directories: ["/tmp/tasks"],
    },
    subagentsRunning: true,
  });

  assert.match(body, /^Name {8}novaid$/m);
  assert.match(body, /^File {8}In-memory$/m);
  assert.match(body, /^Cost {8}\$425\.07 total$/m, "the total must include every sub-agent");
  assert.match(body, /^  main {2}claude-fable-5 {2}\$224\.12 · 73\.1M tok$/m);
  assert.match(body, /^  sub \(35 agents; transcripts\) {2}\$198\.97 · 212\.0M tok$/m);
  assert.match(body, /^ {6}gpt-5\.6-sol {2}\$127\.67 · 178\.0M tok$/m);
  assert.match(body, /transcripts, not from a live meter/);
  assert.match(body, /current turn is counted only once that turn ends/);
});

test("formatSessionInfo assigns semantic roles to money and cache-hit thresholds", () => {
  const colors: string[] = [];
  const style = {
    fg: (color: string, text: string) => {
      colors.push(`${color}:${text}`);
      return text;
    },
    bold: (text: string) => text,
  };
  const render = (cacheRead: number, input: number) => {
    colors.length = 0;
    formatSessionInfo(
      {
        sessionName: undefined,
        sessionFile: undefined,
        sessionId: "01a02297",
        main: { ...MAIN, totals: { ...MAIN.totals, cacheRead, cacheWrite: 0, input } },
        cacheWaste: NO_WASTE,
        subagents: NO_SUBAGENTS,
        subagentsRunning: false,
      },
      style,
    );
    return [...colors];
  };

  const good = render(900, 100);
  assert.ok(good.includes("success:90.0%"));
  assert.ok(good.includes("warning:$226.11"));
  assert.ok(good.includes("accent:Session Info"));
  assert.ok(good.includes("accent:claude-fable-5"));
  assert.ok(render(500, 500).includes("warning:50.0%"));
  assert.ok(render(100, 900).includes("error:10.0%"));
});

test("Pi still exposes the /session handler this extension retires", () => {
  assert.ok(
    isFunction(
      Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "handleSessionCommand")?.value,
    ),
    "interactive mode must keep handleSessionCommand for the /session redirect to apply",
  );
});

type SessionCommandPrototype = {
  handleSessionCommand: () => void;
  __chocoPiSessionCommandApplied?: boolean;
};

test("the extension points Pi's built-in /session at /status", (t) => {
  const prototype = reinterpretHostValue<SessionCommandPrototype>(InteractiveMode.prototype);
  const original = prototype.handleSessionCommand;
  t.after(() => {
    prototype.handleSessionCommand = original;
    prototype.__chocoPiSessionCommandApplied = undefined;
  });

  const commands = new Set<string>();
  statusCommands(
    reinterpretHostValue<ExtensionAPI>({
      on: () => {},
      registerCommand: (name: string) => commands.add(name),
      getThinkingLevel: () => "medium",
    }),
  );

  assert.ok(commands.has("status"), "/status must stay registered");
  assert.ok(!commands.has("session"), "a built-in name cannot be taken by an extension command");
  assert.notEqual(prototype.handleSessionCommand, original);

  const prompts: string[] = [];
  prototype.handleSessionCommand.call({
    session: { prompt: async (text: string) => void prompts.push(text) },
  });
  assert.deepEqual(prompts, ["/status"]);
});
