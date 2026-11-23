import { setTimeout } from "node:timers/promises";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { arr, lit, num, obj, str } from "@earendil-works/pi-schema";
import { matches } from "../schema-check.ts";
import {
  AUTO_COMPACTION_POINT_KEY,
  CONTEXT_SOFT_CAP_KEY,
  writeAgentPreference,
  type ContextPreset,
} from "../../../../profile/extensions/lib/agent-preferences.ts";
import { REPORT_STATUS_KEY } from "../../../../profile/extensions/lib/host-bridge/schema.ts";
import { resolvePolicy } from "../../../../profile/extensions/model-context-cap.ts";
import { FAKE_MODEL, sseResponse } from "../fake-sse.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import { replyPrompt } from "./prompts.ts";
import { evidence, type Host, type Scenario } from "./types.ts";

interface Expected {
  readonly window: number;
  readonly point: number;
}
interface Phase {
  readonly name: string;
  readonly softCap: ContextPreset;
  readonly compactionPoint: ContextPreset;
}
const STANDARD: Phase = {
  name: "standard-standard",
  softCap: "standard",
  compactionPoint: "standard",
};
const PHASES: readonly Phase[] = [
  STANDARD,
  { name: "strict-cap", softCap: "strict", compactionPoint: "standard" },
  { name: "strictest-point", softCap: "standard", compactionPoint: "strictest" },
];
const MID_PHASES: readonly Phase[] = [
  STANDARD,
  { name: "permissive-permissive", softCap: "permissive", compactionPoint: "permissive" },
  { name: "unlimited-unlimited", softCap: "unlimited", compactionPoint: "unlimited" },
  { name: "strict-strict", softCap: "strict", compactionPoint: "strict" },
];
const LARGE: ReadonlyMap<string, Expected> = new Map([
  ["standard-standard", { window: 600_000, point: 450_000 }],
  ["strict-cap", { window: 400_000, point: 340_000 }],
  ["strictest-point", { window: 600_000, point: 200_000 }],
]);
const SMALL: ReadonlyMap<string, Expected> = new Map([
  ["standard-standard", { window: 200_000, point: 170_000 }],
  ["strict-cap", { window: 200_000, point: 170_000 }],
  ["strictest-point", { window: 200_000, point: 170_000 }],
]);

const MID: ReadonlyMap<string, Expected> = new Map([
  ["standard-standard", { window: 524_288, point: 445_645 }],
  ["permissive-permissive", { window: 524_288, point: 445_645 }],
  ["unlimited-unlimited", { window: 524_288, point: 445_645 }],
  ["strict-strict", { window: 400_000, point: 300_000 }],
]);

interface Subject {
  readonly native: number;
  readonly phases: readonly Phase[];
  readonly expected: ReadonlyMap<string, Expected>;
}
const KIMI_ID = "hf:moonshotai/Kimi-K3";
const SUBJECTS: ReadonlyMap<string, Subject> = new Map([
  ["anthropic/claude-haiku-5-5", { native: 1_000_000, phases: PHASES, expected: LARGE }],
  ["openai-codex/gpt-6-luna", { native: 1_050_000, phases: PHASES, expected: LARGE }],
  [`synthetic/${KIMI_ID}`, { native: 524_288, phases: MID_PHASES, expected: MID }],
  ["harness-offline/harness-fake", { native: 200_000, phases: PHASES, expected: SMALL }],
  ["harness-offline/haiku-window-mirror", { native: 1_000_000, phases: PHASES, expected: LARGE }],
  ["harness-offline/luna-window-mirror", { native: 1_050_000, phases: PHASES, expected: LARGE }],
  ["harness-offline/kimi-window-mirror", { native: 524_288, phases: MID_PHASES, expected: MID }],
]);
const REGISTRY_SUBJECTS = [
  "anthropic/claude-haiku-5-5",
  "openai-codex/gpt-6-luna",
  `synthetic/${KIMI_ID}`,
] as const;

function mirror(id: string, contextWindow: number): Model<"anthropic-messages"> {
  return { ...FAKE_MODEL, id, name: `Harness window mirror ${id}`, contextWindow };
}
export const OFFLINE_MODELS: ReadonlyMap<string, Model<"anthropic-messages">> = new Map([
  ["haiku-window-mirror", mirror("haiku-window-mirror", 1_000_000)],
  ["luna-window-mirror", mirror("luna-window-mirror", 1_050_000)],
  ["kimi-window-mirror", mirror("kimi-window-mirror", 524_288)],
  ["harness-fake", FAKE_MODEL],
]);

const SETTLE_MS = 1_000;
const COMPACT_WAIT_MS = 5_000;
const RowSchema = obj({ label: str(), value: str() }, { open: true });
const StatusFrameSchema = obj(
  {
    kind: lit("status"),
    sections: arr(obj({ rows: arr(RowSchema) }, { open: true })),
  },
  { open: true },
);
const ContextFrameSchema = obj(
  {
    kind: lit("context"),
    context: obj({ contextWindow: num() }, { open: true }),
  },
  { open: true },
);

export const compactProbe: ExtensionFactory = (pi) => {
  pi.on("session_before_compact", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    probeSink?.(usage?.tokens ?? null);
  });
};
let probeSink: ((tokens: number | null) => void) | undefined;

function subjectFor(key: string): Subject {
  const subject = SUBJECTS.get(key);
  if (!subject) throw new Error(`No expected figures for ${key}`);
  return subject;
}

function subjectOf(host: Host): Subject {
  return subjectFor(host.model);
}

function expectedFor(subject: Subject, phase: Phase): Expected {
  const expected = subject.expected.get(phase.name);
  if (!expected) throw new Error(`No expected figures for phase ${phase.name}`);
  return expected;
}

interface Frames {
  status: string | undefined;
  context: number | undefined;
  statusRef: number;
  contextRef: number;
}

async function reportFrames(host: Host, phase: Phase): Promise<Frames> {
  const ui = host.session.extensionRunner.getUIContext();
  const original = ui.setStatus;
  const frames: unknown[] = [];
  ui.setStatus = (key, text) => {
    if (key === REPORT_STATUS_KEY && text !== undefined) frames.push(JSON.parse(text));
    return original.call(ui, key, text);
  };
  try {
    await host.session.prompt("/status");
    await host.session.prompt("/context");
  } finally {
    ui.setStatus = original;
  }
  const statusFrame = frames.find((frame) => matches(StatusFrameSchema, frame));
  const contextFrame = frames.find((frame) => matches(ContextFrameSchema, frame));
  const status = matches(StatusFrameSchema, statusFrame)
    ? statusFrame.sections
        .flatMap((section) => section.rows)
        .find((row) => row.label === "Context window")?.value
    : undefined;
  const context = matches(ContextFrameSchema, contextFrame)
    ? contextFrame.context.contextWindow
    : undefined;
  const statusRef = host.recorder.record("status-report", {
    phase: phase.name,
    contextWindowRow: status ?? null,
    frames: frames.length,
  });
  const contextRef = host.recorder.record("context-report", {
    phase: phase.name,
    contextWindow: context ?? null,
  });
  return { status, context, statusRef, contextRef };
}

function statusTokens(value: string | undefined): number | null {
  const match = value === undefined ? null : /^([\d,.\s]+) tokens/u.exec(value);
  return match?.[1] === undefined ? null : Number(match[1].replace(/[^\d]/gu, ""));
}

interface Displayed {
  readonly modelWindow: number | null;
  readonly usageWindow: number | null;
  readonly footerWindow: number | null;
  readonly registry: Record<string, number | null>;
}

function displayed(ctx: ExtensionContext): Displayed {
  const registry: Record<string, number | null> = {};
  for (const key of REGISTRY_SUBJECTS) {
    const slash = key.indexOf("/");
    registry[key] =
      ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1))?.contextWindow ?? null;
  }
  return {
    modelWindow: ctx.model?.contextWindow ?? null,
    usageWindow: ctx.getContextUsage()?.contextWindow ?? null,
    footerWindow: ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? null,
    registry,
  };
}

async function setPresets(host: Host, phase: Phase): Promise<void> {
  await writeAgentPreference(CONTEXT_SOFT_CAP_KEY, phase.softCap, host.agentDir);
  await writeAgentPreference(AUTO_COMPACTION_POINT_KEY, phase.compactionPoint, host.agentDir);
}

function windowObservations(host: Host, phase: Phase, expected: Expected): Promise<Observation[]> {
  return reportFrames(host, phase).then((frames) => {
    const shown = displayed(host.parent().ctx);
    const ref = host.recorder.record("context-window-displayed", {
      phase: phase.name,
      ...shown,
      statusRow: frames.status ?? null,
      contextReport: frames.context ?? null,
    });
    const refs = [ref, frames.statusRef, frames.contextRef];
    return [
      {
        description: `${phase.name}: ctx.model.contextWindow (footer and statusline input)`,
        actual: shown.modelWindow,
        expected: expected.window,
        evidenceRefs: [ref],
      },
      {
        description: `${phase.name}: footer expression ctx.model?.contextWindow ?? getContextUsage()?.contextWindow`,
        actual: shown.footerWindow,
        expected: expected.window,
        evidenceRefs: [ref],
      },
      {
        description: `${phase.name}: Pi getContextUsage().contextWindow`,
        actual: shown.usageWindow,
        expected: expected.window,
        evidenceRefs: [ref],
      },
      {
        description: `${phase.name}: /status "Context window" row`,
        actual: statusTokens(frames.status),
        expected: expected.window,
        evidenceRefs: refs,
      },
      {
        description: `${phase.name}: /context report contextWindow`,
        actual: frames.context ?? null,
        expected: expected.window,
        evidenceRefs: refs,
      },
    ];
  });
}

let reportedInput = 10;

function boundaryResponse(index: number): Response {
  return sseResponse([
    {
      type: "message_start",
      message: {
        id: `harness-cw-${index}`,
        type: "message",
        role: "assistant",
        model: "harness",
        content: [],
        stop_reason: null,
        usage: { input_tokens: reportedInput, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: `HARNESS-CW-DONE-${index}` },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

async function boundary(host: Host, phase: Phase, expected: Expected): Promise<Observation[]> {
  const requested: (number | null)[] = [];
  probeSink = (tokens) => requested.push(tokens);
  const outcome: Record<string, number> = {};
  try {
    for (const [label, input] of [
      ["at-point", expected.point - 1],
      ["above-point", expected.point],
    ] as const) {
      const before = requested.length;
      reportedInput = input;
      await host.session.prompt(`HARNESS-CW-${phase.name}-${label}`);
      const deadline = performance.now() + (label === "above-point" ? COMPACT_WAIT_MS : SETTLE_MS);
      while (performance.now() < deadline && requested.length === before) await setTimeout(10);
      while (host.session.isCompacting) await setTimeout(10);
      outcome[label] = requested.length - before;
    }
  } finally {
    reportedInput = 10;
    probeSink = undefined;
  }
  const ref = host.recorder.record("compaction-boundary", {
    phase: phase.name,
    point: expected.point,
    requests: outcome,
    requestedAtTokens: requested,
  });
  return [
    {
      description: `${phase.name}: compaction requested only past ${expected.point} tokens`,
      actual: outcome,
      expected: { "at-point": 0, "above-point": 1 },
      evidenceRefs: [ref],
    },
  ];
}

function computedPoint(host: Host, phase: Phase, expected: Expected): Observation[] {
  const model = host.parent().ctx.model;
  const policy = model
    ? resolvePolicy(model, subjectOf(host).native, {
        softCap: phase.softCap,
        compactionPoint: phase.compactionPoint,
        hostReserve: 16_384,
      })
    : {};
  const ref = host.recorder.record("compaction-point-computed", {
    phase: phase.name,
    cap: policy.cap ?? null,
    compactAt: policy.compactAt ?? null,
  });
  return [
    {
      description: `${phase.name}: production resolvePolicy compactAt (computed in-host, not triggered)`,
      actual: policy.compactAt ?? null,
      expected: expected.point,
      evidenceRefs: [ref],
    },
  ];
}

function recordProviderTurn(host: Host): void {
  const last = host.session.messages.findLast((message) => message.role === "assistant");
  if (!last || last.role !== "assistant" || last.api === "anthropic-messages") return;
  host.recorder.record("live-provider-turn", {
    transport: `${last.api} (usage from the assistant message, not the fetch ledger)`,
    stopReason: last.stopReason,
    errorMessage: last.errorMessage ?? null,
    usage: { input: last.usage.input, output: last.usage.output, cacheRead: last.usage.cacheRead },
  });
}

async function run(host: Host): Promise<CheckEvidence> {
  const subject = subjectOf(host);
  const offline = host.mode === "fake";
  if (offline)
    host.setResponseOverride((dispatch) =>
      dispatch.summary ? undefined : boundaryResponse(dispatch.index),
    );
  await host.session.prompt(replyPrompt(host, "HARNESS-CW-TURN", "HARNESS-CW-ACK"));
  if (!offline) recordProviderTurn(host);
  const result = evidence(host);
  const first: Observation[] = [];
  const changed: Observation[] = [];
  const point: Observation[] = [];
  for (const [index, phase] of subject.phases.entries()) {
    if (index > 0) await setPresets(host, phase);
    const expected = expectedFor(subject, phase);
    (index === 0 ? first : changed).push(...(await windowObservations(host, phase, expected)));
    point.push(
      ...(offline ? await boundary(host, phase, expected) : computedPoint(host, phase, expected)),
    );
  }
  result.observations["context-window-displayed"] = first;
  result.observations["context-window-preset-change"] = changed;
  result.observations["compaction-point"] = point;
  return result;
}

export const scenario: Scenario = {
  name: "context-window-presets",
  description:
    "contextSoftCap / autoCompactionPoint presets reach ctx.model, getContextUsage, /status, /context and the catalog registry",
  settings: {},
  agentSettings: { [CONTEXT_SOFT_CAP_KEY]: "standard", [AUTO_COMPACTION_POINT_KEY]: "standard" },
  catalog: true,
  offlineModels: OFFLINE_MODELS,
  providerOwnedTransport: true,
  factories: [compactProbe],
  checks: ["context-window-displayed", "context-window-preset-change", "compaction-point"],
  markers: ["HARNESS-CW-TURN"],
  execute: run,
};
