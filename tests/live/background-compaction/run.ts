import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { join } from "node:path";
import { Value } from "typebox/value";
import { Type } from "typebox";
import { writeArtifact, InputSchema, type EvidenceRecord } from "./artifacts.ts";
import { evaluateChecks, HARNESS_CHECKS, type Verdict } from "./checks.ts";
import { requireLiveRun } from "./budget.ts";
import { launch, WORKTREE } from "./launch.ts";
import { sourceAgentDir } from "./live-source.ts";
import { scenario as anthropicNative } from "./scenarios/anthropic-native-adoption.ts";
import {
  automaticScenario as anthropicForegroundAuto,
  scenario as anthropicForeground,
} from "./scenarios/anthropic-foreground-compaction.ts";
import { scenario as childSession } from "./scenarios/child-session-adoption.ts";
import { scenario as contextWindowPresets } from "./scenarios/context-window-presets.ts";
import { scenario as arbitration } from "./scenarios/host-compaction-arbitration.ts";
import { scenario as idleInput } from "./scenarios/idle-input-adoption.ts";
import { scenario as manualBackground } from "./scenarios/manual-background-compaction.ts";
import { PENDING_SCENARIOS } from "./scenarios/pending.ts";
import {
  PHASE_RECORD,
  PhaseUsageSchema,
  scenario as restart,
} from "./scenarios/restart-recovery.ts";
import { scenario as textBoundary } from "./scenarios/text-boundary-adoption.ts";
import type { Host, PendingScenario, Scenario } from "./scenarios/types.ts";

const SCENARIOS: readonly Scenario[] = [
  textBoundary,
  anthropicNative,
  idleInput,
  restart,
  arbitration,
  manualBackground,
  childSession,
  anthropicForeground,
  anthropicForegroundAuto,
  contextWindowPresets,
];
const FOREGROUND_TOOL_CYCLES = 6;
const EXIT_CODES = { pass: 0, fail: 1, pending: 2 } as const;
type Status = keyof typeof EXIT_CODES;

const PhaseRecordSchema = Type.Object({ usage: PhaseUsageSchema }, { additionalProperties: true });

/** Restart workers are separate processes with their own ledgers. */
function workerUsage(records: readonly EvidenceRecord[]) {
  return records.flatMap((record) =>
    record.kind === PHASE_RECORD && Value.Check(PhaseRecordSchema, record.data) && record.data.usage
      ? [record.data.usage]
      : [],
  );
}

async function usageReport(host: Host) {
  const own = await host.usage();
  if (!own) return null;
  const workers = workerUsage(host.recorder.records);
  const all = [own, ...workers];
  const sum = (pick: (item: (typeof all)[number]) => number) =>
    all.reduce((total, item) => total + pick(item), 0);
  return {
    model: host.model,
    requests: sum((item) => item.requests),
    inputTokens: sum((item) => item.inputTokens),
    outputTokens: sum((item) => item.outputTokens),
    unreported: sum((item) => item.unreported),
    launcher: own,
    workers,
  };
}

function statusOf(verdicts: readonly Verdict[], scenario: Scenario): Status {
  if (verdicts.some((verdict) => verdict.status === "fail")) return "fail";
  return scenario.pending?.length ? "pending" : "pass";
}

async function revision() {
  const git = promisify(execFile);
  const { stdout: head } = await git("git", ["rev-parse", "HEAD"], { cwd: WORKTREE });
  const { stdout: dirty } = await git("git", ["status", "--porcelain"], { cwd: WORKTREE });
  return { revision: head.trim(), dirty: dirty.length > 0 };
}

async function reportPending(scenario: PendingScenario, out: string): Promise<void> {
  await writeArtifact(out, "manifest.json", {
    ...(await revision()),
    scenario: scenario.name,
    status: "pending",
    pending: [...scenario.pending],
  });
  process.stdout.write(`${scenario.name}: pending (${scenario.pending.join("; ")})\n`);
  process.exitCode = EXIT_CODES.pending;
}

async function runScenario(scenario: Scenario, host: Host, out: string): Promise<void> {
  const observed = await scenario.execute(host);
  // Counters are read at verdict time so late subcases (negatives) are included.
  const evidence = { ...observed, networkCalls: host.networkCalls(), aborts: host.aborts() };
  const verdicts = evaluateChecks(evidence, [...scenario.checks, ...HARNESS_CHECKS]);
  const status = statusOf(verdicts, scenario);
  const usage = await usageReport(host);
  await writeArtifact(out, "events.json", Value.Parse(InputSchema, host.recorder.records));
  await writeArtifact(out, "verdicts.json", Value.Parse(InputSchema, verdicts));
  if (usage) await writeArtifact(out, "usage.json", Value.Parse(InputSchema, usage));
  await writeArtifact(out, "manifest.json", {
    ...(await revision()),
    scenario: scenario.name,
    mode: host.mode,
    model: host.model,
    status,
    usage: usage && {
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      unreported: usage.unreported,
    },
    pending: [...(scenario.pending ?? [])],
    markers: [...scenario.markers],
    protectedRuntimeRemovedAfterRun: true,
  });
  process.stdout.write(`${scenario.name}: ${status}; artifacts ${out}\n`);
  process.exitCode = EXIT_CODES[status];
}

async function recordFailure(host: Host, out: string, message: string): Promise<void> {
  const usage = await usageReport(host).catch(() => null);
  await writeArtifact(out, "failure.json", {
    error: message,
    usage: usage === null ? null : Value.Parse(InputSchema, usage),
    records: Value.Parse(InputSchema, host.recorder.records),
  });
}

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    out: { type: "string" },
    live: { type: "string" },
    "offline-model": { type: "string" },
  },
  strict: true,
});
const names = [...SCENARIOS, ...PENDING_SCENARIOS].map((item) => item.name);
const scratch = join("/tmp/choco-pi", process.env.PI_SESSION_ID ?? "background-compaction", "e2e");
const pending = PENDING_SCENARIOS.find((item) => item.name === values.scenario);
const scenario = SCENARIOS.find((item) => item.name === values.scenario);

/** The offline subject a scenario offers; refuses a name it does not declare. */
function offlineModelFor(item: Scenario, requested: string | undefined) {
  if (requested === undefined) return item.offlineModels?.values().next().value;
  const model = item.offlineModels?.get(requested);
  if (!model) throw new Error(`${item.name} offers no offline model ${requested}`);
  return model;
}

if (pending) await reportPending(pending, values.out ?? join(scratch, pending.name));
else if (!scenario) throw new Error(`Use --scenario with one of: ${names.join(", ")}`);
else {
  // Resolved before the launcher scopes PI_CODING_AGENT_DIR; refuses unapproved runs up front.
  const live =
    values.live === undefined
      ? undefined
      : { model: values.live, sourceAgentDir: sourceAgentDir() };
  if (live) requireLiveRun(scenario.name, live.model);
  if (live && values["offline-model"] !== undefined)
    throw new Error("--offline-model applies to offline runs only");
  const offlineModel = live ? undefined : offlineModelFor(scenario, values["offline-model"]);
  const out =
    values.out ?? (live ? join(scratch, "live", scenario.name) : join(scratch, scenario.name));
  const host = await launch({
    scratchRoot: scratch,
    failureOut: out,
    scenario: scenario.name,
    profile: "worktree",
    settings: scenario.settings,
    seedBytes: scenario.seedBytes,
    seedNamespace: scenario.name.toUpperCase(),
    keepRecentTokens: scenario.keepRecentTokens,
    hostCompaction: scenario.hostCompaction,
    anthropicForeground: scenario.anthropicForeground,
    agentSettings: scenario.agentSettings,
    catalog: scenario.catalog,
    offlineModel,
    providerOwnedTransport: scenario.providerOwnedTransport,
    factories: scenario.factories,
    cycles: FOREGROUND_TOOL_CYCLES,
    live,
  });
  try {
    await runScenario(scenario, host, out);
  } catch (error) {
    await recordFailure(host, out, error instanceof Error ? error.message : "Unexpected failure");
    throw error;
  } finally {
    await host.cleanup();
  }
}
