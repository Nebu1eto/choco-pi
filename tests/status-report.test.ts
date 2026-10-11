import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import type {
  BuildSystemPromptOptions,
  ExtensionCommandContext,
  RegisteredMcpServer,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import statusCommands, {
  buildStatusReport,
  openStatusTab,
  registerReportAutoPublish,
  REPORT_DEBOUNCE_MS,
  USAGE_REPORT_INTERVAL_MS,
  type ReportAutoPublishOptions,
} from "../.pi/extensions/status-commands.ts";
import { buildContextReport } from "../.pi/extensions/lib/context-report.ts";
import { usageReportFrame } from "../.pi/extensions/lib/usage-report.ts";
import type { ProviderUsageReport } from "../.pi/extensions/provider-usage.ts";
import {
  ReportFrameSchema,
  type ReportFrame,
} from "../.pi/extensions/lib/host-bridge/report-schema.ts";
import { REPORT_STATUS_KEY } from "../.pi/extensions/lib/host-bridge/schema.ts";
import { ProfileMarkerSchema } from "../.pi/extensions/lib/profile-marker.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const TOOLS = [
  { name: "read", description: "Read a file", parameters: {}, sourceInfo: { source: "builtin" } },
  ...["mcp__alpha__read", "mcp__alpha__search", "mcp__beta__list"].map((name) => ({
    name,
    description: "Built-in MCP server tool",
    parameters: {},
    sourceInfo: { source: "builtin", path: "builtin:mcp" },
  })),
];

const PROMPT_OPTIONS = {
  cwd: process.cwd(),
  contextFiles: [{ path: "AGENTS.md", content: "project policy" }],
  skills: [],
};

type UiCall = { method: "setStatus" | "notify"; key?: string; text: string | undefined };

function fixture(mode: "rpc" | "tui" = "rpc") {
  const calls: UiCall[] = [];
  const ctx = {
    cwd: process.cwd(),
    mode,
    model: { provider: "test", id: "test-model", contextWindow: 200_000 },
    sessionManager: {
      getEntries: () => [],
      getSessionName: () => undefined,
      getSessionId: () => "session-report",
      getSessionFile: () => undefined,
      getHeader: () => null,
      buildContextEntries: () => [],
    },
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    modelRegistry: {
      find: () => undefined,
      // No provider is connected, so /usage never reaches the network.
      getProviderAuthStatus: () => ({ configured: false }),
      getApiKeyForProvider: async () => undefined,
    },
    getSystemPrompt: () => "system prompt",
    getSystemPromptOptions: () => PROMPT_OPTIONS,
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setStatus: (key: string, text: string | undefined) => {
        calls.push({ method: "setStatus", key, text });
      },
      notify: (text: string) => {
        calls.push({ method: "notify", text });
      },
    },
  };
  return { ctx: reinterpretHostValue<ExtensionCommandContext>(ctx), calls };
}

const MCP_SERVERS: RegisteredMcpServer[] = [
  {
    name: "beta",
    config: { command: "beta-server", enabled: false },
    extensionPath: "builtin:mcp",
  },
  { name: "gamma", config: { command: "gamma-server" }, extensionPath: "builtin:mcp" },
];

const inventory = {
  getAllTools: () => reinterpretHostValue<ToolInfo[]>(TOOLS),
  getActiveTools: () => ["read"],
  getMcpServers: () => MCP_SERVERS,
};

function parseFrame(text: string | undefined): ReportFrame {
  const parsed: unknown = JSON.parse(text ?? "null");
  assert.ok(Value.Check(ReportFrameSchema, parsed), "frame matches the documented schema");
  return parsed;
}

test("buildStatusReport yields a schema-valid frame with session and environment rows", () => {
  const { ctx } = fixture();
  const frame = buildStatusReport(ctx, "high", "2 configured (see /mcp)");
  assert.ok(Value.Check(ReportFrameSchema, frame));
  assert.equal(frame.kind, "status");
  assert.equal(frame.title, "Status");
  assert.equal(frame.sessionId, "session-report");
  assert.ok(Number.isFinite(Date.parse(frame.at)));
  assert.equal(frame.context, undefined);
  assert.deepEqual(
    frame.sections.map((section) => section.title),
    ["Session Info", "Environment"],
  );
  const session = new Map(frame.sections[0].rows.map((row) => [row.label, row]));
  assert.equal(session.get("ID")?.value, "session-report");
  assert.equal(session.get("File")?.value, "In-memory");
  const environment = new Map(frame.sections[1].rows.map((row) => [row.label, row]));
  assert.equal(environment.get("Reasoning effort")?.value, "high");
  assert.equal(environment.get("MCP servers")?.value, "2 configured (see /mcp)");
  assert.equal(environment.get("Daybreak")?.value, "not initialized");
  assert.equal(environment.get("Fast mode")?.value, "not initialized");
  assert.equal(environment.get("Context files")?.value, "1 loaded");
  assert.match(environment.get("Context files")?.hint ?? "", /^AGENTS\.md\b/);
  assert.ok(!environment.has("Session ID"), "identity rows appear once, in Session Info");
  assert.ok(
    frame.sections.every((section) => section.rows.every((row) => !row.value.includes("\n"))),
    "values are single-line headlines; inventories move to hints",
  );
});

test("buildContextReport yields a schema-valid frame whose typed block matches the tab", () => {
  const { ctx } = fixture();
  const frame = buildContextReport(inventory, ctx, PROMPT_OPTIONS, undefined);
  assert.ok(Value.Check(ReportFrameSchema, frame));
  assert.equal(frame.kind, "context");
  assert.equal(frame.title, "Context Usage");
  const context = frame.context;
  assert.ok(context);
  assert.equal(context.model, "test/test-model");
  assert.equal(context.contextWindow, 200_000);
  assert.equal(context.measuredTokens, 50_000);
  assert.equal(
    context.estimatedTokens,
    context.categories.reduce((sum, category) => sum + category.tokens, 0),
  );
  assert.deepEqual(
    context.categories.map((category) => category.label),
    [
      "System prompt",
      "System tools",
      "MCP tools",
      "Custom agents",
      "Context files",
      "Skills",
      "Messages",
    ],
  );
  assert.equal(context.categories.find((c) => c.label === "Messages")?.estimated, false);
  assert.deepEqual(context.tools, { active: 1, deferred: 3 });
  assert.deepEqual(
    context.mcp.servers.map((server) => [server.name, server.tools, server.state]),
    [
      ["alpha", 2, undefined],
      ["beta", 1, "disabled"],
      ["gamma", 0, "registered"],
    ],
  );
  assert.equal(context.contextFiles.count, 1);
  assert.equal(context.skills.count, 0);
});

test("context reports carry no measurement before the model has answered", () => {
  const { ctx } = fixture();
  const unmeasured = reinterpretHostValue<ExtensionCommandContext>({
    ...ctx,
    sessionManager: ctx.sessionManager,
    getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
  });
  const frame = buildContextReport(inventory, unmeasured, PROMPT_OPTIONS, undefined);
  assert.ok(Value.Check(ReportFrameSchema, frame));
  assert.equal(frame.context?.measuredTokens, null);
  assert.ok(frame.context?.categories.every((category) => category.estimated));
});

test("rpc /status and /context publish the report before the plain-text notice", async () => {
  statusCommands(
    reinterpretHostValue<Parameters<typeof statusCommands>[0]>({
      on: () => undefined,
      registerCommand: () => undefined,
      getThinkingLevel: () => "medium",
      ...inventory,
    }),
  );
  for (const tab of ["status", "context"] as const) {
    const { ctx, calls } = fixture("rpc");
    await openStatusTab(ctx, "medium", tab);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["setStatus", "notify"],
      `${tab}: report first, text fallback second`,
    );
    assert.equal(calls[0].key, REPORT_STATUS_KEY);
    assert.equal(parseFrame(calls[0].text).kind, tab);
    assert.ok(!(calls[1].text ?? "").includes("\u001b"), "the fallback stays plain text");
  }
});

const USAGE_AT = new Date("2026-10-11T09:00:00.000Z");

const USAGE_FIXTURE: ProviderUsageReport = {
  observedAt: USAGE_AT,
  providers: [
    {
      ok: true,
      usage: {
        name: "Claude",
        plan: "Max (5x)",
        windows: [
          {
            label: "5h",
            percent: 42,
            qualifier: "used",
            eventAt: new Date("2026-10-11T11:00:00.000Z"),
            eventLabel: "resets",
            windowSeconds: 5 * 3600,
          },
        ],
      },
    },
    {
      ok: true,
      usage: {
        name: "Synthetic",
        cached: { at: new Date("2026-10-11T08:30:00.000Z"), reason: "HTTP 429" },
        windows: [
          {
            label: "Weekly credits",
            percent: 12.5,
            qualifier: "used",
            detail: "$21.00 remaining",
            precision: 2,
            pace: { health: "under", label: "refill keeping up" },
          },
        ],
      },
    },
    { ok: false, name: "ChatGPT", error: "HTTP 401" },
  ],
};

test("usageReportFrame yields a schema-valid frame with a typed block and generic sections", () => {
  const frame = usageReportFrame("session-report", USAGE_FIXTURE, USAGE_AT);
  assert.ok(Value.Check(ReportFrameSchema, frame));
  assert.equal(frame.kind, "usage");
  assert.equal(frame.title, "Usage");
  assert.equal(frame.context, undefined);
  const usage = frame.usage;
  assert.ok(usage);
  assert.equal(usage.observedAt, USAGE_AT.toISOString());
  assert.deepEqual(usage.providers, [
    {
      name: "Claude",
      plan: "Max (5x)",
      windows: [
        {
          label: "5h",
          percent: 42,
          qualifier: "used",
          resetsAt: "2026-10-11T11:00:00.000Z",
          resetLabel: "resets",
          windowSeconds: 18_000,
        },
      ],
    },
    {
      name: "Synthetic",
      cached: { at: "2026-10-11T08:30:00.000Z", reason: "HTTP 429" },
      windows: [
        {
          label: "Weekly credits",
          percent: 12.5,
          qualifier: "used",
          detail: "$21.00 remaining",
          pace: { health: "under", label: "refill keeping up" },
        },
      ],
    },
    { name: "ChatGPT", status: "unavailable (HTTP 401)", windows: [] },
  ]);
  assert.deepEqual(
    frame.sections.map((section) => [section.title, section.rows.map((row) => row.label)]),
    [
      ["Claude", ["Plan", "5h"]],
      ["Synthetic", ["Snapshot", "Weekly credits"]],
      ["ChatGPT", ["Status"]],
    ],
  );
  const claude = frame.sections[0].rows[1];
  assert.equal(claude.value, "42% used");
  assert.equal(claude.hint, "resets in 2h · 60% of window elapsed");
  assert.equal(frame.sections[1].rows[1].value, "12.5% used");
  assert.match(frame.sections[1].rows[0].value, /^cached .+ · HTTP 429$/);
  assert.doesNotMatch(JSON.stringify(frame), /account|token|Bearer|cookie/i);
});

test("rpc /usage and /quota publish the usage report before the plain-text notice", async () => {
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  statusCommands(
    reinterpretHostValue<Parameters<typeof statusCommands>[0]>({
      on: () => undefined,
      registerCommand: (
        name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        commands.set(name, command.handler);
      },
      getThinkingLevel: () => "medium",
      ...inventory,
    }),
  );
  for (const name of ["usage", "quota"]) {
    const handler = commands.get(name);
    assert.ok(handler, `/${name} is registered`);
    const { ctx, calls } = fixture("rpc");
    await handler("", ctx);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["setStatus", "notify"],
      `/${name}: report first, text fallback second`,
    );
    assert.equal(calls[0].key, REPORT_STATUS_KEY);
    const frame = parseFrame(calls[0].text);
    assert.equal(frame.kind, "usage");
    assert.equal(frame.sessionId, "session-report");
    assert.deepEqual(
      frame.usage?.providers.map((provider) => [provider.name, provider.status]),
      [
        ["Claude", "not connected"],
        ["ChatGPT", "not connected"],
        ["Synthetic", "not connected"],
      ],
      "a user-invoked report is sent even without quota windows",
    );
    assert.match(calls[1].text ?? "", /^Claude — not connected/);
  }
});

type HookPayload = Readonly<Record<string, RuntimeValue>>;
type Handler = (event: HookPayload, ctx: ExtensionCommandContext) => void;

const NO_USAGE: ProviderUsageReport = {
  observedAt: USAGE_AT,
  providers: [{ ok: false, name: "Claude", error: "HTTP 500" }],
};

function publisherHarness(
  host: string | undefined,
  extra: Pick<ReportAutoPublishOptions, "readUsage" | "now"> = {},
) {
  const handlers = new Map<string, Handler[]>();
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  const warnings: string[] = [];
  const api = reinterpretHostValue<Parameters<typeof registerReportAutoPublish>[0]>({
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    ...inventory,
  });
  registerReportAutoPublish(api, {
    host,
    readUsage: async () => NO_USAGE,
    ...extra,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    warn: (message) => warnings.push(message),
  });
  const emit = (event: string, payload: HookPayload, ctx: ExtensionCommandContext): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  const flush = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback();
  };
  return { emit, flush, timers, warnings };
}

const BEFORE_AGENT_START = {
  type: "before_agent_start",
  prompt: "hi",
  systemPrompt: "system prompt",
  systemPromptOptions: reinterpretHostValue<BuildSystemPromptOptions>(PROMPT_OPTIONS),
};

test("auto-publish sends one debounced context report per burst under an rpc bridge host", () => {
  const harness = publisherHarness("waku");
  const { ctx, calls } = fixture("rpc");
  harness.emit("session_start", { reason: "startup" }, ctx);
  harness.emit("before_agent_start", BEFORE_AGENT_START, ctx);
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.emit("model_select", { type: "model_select" }, ctx);
  assert.ok(harness.timers.every((timer) => timer.ms >= 500));
  assert.ok(REPORT_DEBOUNCE_MS >= 500);
  harness.flush();
  assert.equal(calls.length, 1, "the burst coalesces into one frame");
  assert.equal(calls[0].key, REPORT_STATUS_KEY);
  assert.equal(parseFrame(calls[0].text).kind, "context");
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  assert.equal(calls.length, 1, "unchanged figures are not re-sent");
  assert.deepEqual(harness.warnings, []);
});

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("auto-publish sends a usage report on the first turn end, then at most every 10 minutes", async () => {
  let clock = 1_000_000;
  let queries = 0;
  let next: ProviderUsageReport = USAGE_FIXTURE;
  const harness = publisherHarness("waku", {
    now: () => clock,
    readUsage: async () => {
      queries += 1;
      return next;
    },
  });
  const { ctx, calls } = fixture("rpc");
  const kinds = (): string[] => calls.map((call) => parseFrame(call.text).kind);
  harness.emit("session_start", { reason: "startup" }, ctx);
  harness.emit("model_select", { type: "model_select" }, ctx);
  harness.flush();
  await settle();
  assert.equal(queries, 0, "only a turn end queries the providers");
  harness.emit("before_agent_start", BEFORE_AGENT_START, ctx);
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  await settle();
  assert.equal(queries, 1);
  assert.deepEqual(kinds(), ["context", "usage"], "usage follows the context report");

  clock += USAGE_REPORT_INTERVAL_MS - 1;
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  await settle();
  assert.equal(queries, 1, "no query inside the interval");

  clock += 1;
  next = NO_USAGE;
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  await settle();
  assert.equal(queries, 2, "the interval elapsed");
  assert.deepEqual(kinds(), ["context", "usage"], "a query without windows publishes nothing");

  clock += 60_000;
  next = USAGE_FIXTURE;
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  await settle();
  assert.equal(queries, 2, "a failed query still waits out the interval");

  harness.emit("session_start", { reason: "new" }, ctx);
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  await settle();
  assert.equal(queries, 3, "a new session gets its first-turn report");
  assert.deepEqual(kinds(), ["context", "usage", "context", "usage"]);
  assert.deepEqual(harness.warnings, []);
});

test("auto-publish drops a usage report that resolves after a session switch", async () => {
  let release: (report: ProviderUsageReport) => void = () => undefined;
  const harness = publisherHarness("waku", {
    now: () => 0,
    readUsage: () =>
      new Promise<ProviderUsageReport>((resolve) => {
        release = resolve;
      }),
  });
  const { ctx, calls } = fixture("rpc");
  harness.emit("session_start", { reason: "startup" }, ctx);
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.flush();
  harness.emit("session_shutdown", {}, ctx);
  release(USAGE_FIXTURE);
  await settle();
  assert.deepEqual(
    calls.filter((call) => parseFrame(call.text).kind === "usage"),
    [],
  );
});

test("auto-publish stays off in tui mode and without CHOCO_PI_HOST", () => {
  for (const [host, mode] of [
    ["waku", "tui"],
    [undefined, "rpc"],
  ] as const) {
    const harness = publisherHarness(host);
    const { ctx, calls } = fixture(mode);
    harness.emit("session_start", { reason: "startup" }, ctx);
    harness.emit("before_agent_start", BEFORE_AGENT_START, ctx);
    harness.emit("turn_end", { type: "turn_end" }, ctx);
    harness.emit("model_select", { type: "model_select" }, ctx);
    assert.equal(harness.timers.length, 0, `${mode}/${host ?? "unset"}: nothing scheduled`);
    harness.flush();
    assert.deepEqual(calls, []);
  }
});

test("auto-publish drops a report scheduled before shutdown or a session switch", () => {
  const harness = publisherHarness("waku");
  const { ctx, calls } = fixture("rpc");
  harness.emit("session_start", { reason: "startup" }, ctx);
  harness.emit("before_agent_start", BEFORE_AGENT_START, ctx);
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  const pending = harness.timers.splice(0);
  harness.emit("session_shutdown", {}, ctx);
  for (const timer of pending) timer.callback();
  assert.deepEqual(calls, []);
});

test("auto-publish contains a stale context instead of throwing from its timer", () => {
  const harness = publisherHarness("waku");
  const { ctx, calls } = fixture("rpc");
  harness.emit("session_start", { reason: "startup" }, ctx);
  harness.emit("before_agent_start", BEFORE_AGENT_START, ctx);
  const stale = reinterpretHostValue<ExtensionCommandContext>({
    mode: "rpc",
    get sessionManager(): never {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  });
  harness.emit("turn_end", { type: "turn_end" }, ctx);
  harness.emit("turn_end", { type: "turn_end" }, stale);
  assert.doesNotThrow(() => harness.flush());
  assert.equal(calls.length, 1, "the pending report for the live context still goes out");
  assert.deepEqual(harness.warnings, []);
});

test("profile markers written before structured reports still validate", () => {
  const legacy = {
    schema: 1,
    name: "choco-pi",
    checkout: "/choco-pi",
    revision: null,
    installedAt: new Date(0).toISOString(),
    pi: { version: null, launcher: null },
    hostBridge: {
      schema: 1,
      entryPrefix: "choco-pi:host-bridge",
      statusKey: "choco-pi.host-bridge",
    },
  };
  assert.ok(Value.Check(ProfileMarkerSchema, legacy));
  assert.ok(
    Value.Check(ProfileMarkerSchema, {
      ...legacy,
      hostBridge: { ...legacy.hostBridge, reportStatusKey: REPORT_STATUS_KEY },
    }),
  );
});
