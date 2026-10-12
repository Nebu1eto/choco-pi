/**
 * One fresh-process phase of the restart-recovery scenario. Spawned by
 * scenarios/restart-recovery.ts; writes `<out>/<phase>.json` plus redacted
 * events, then exits (SIGKILL where the phase simulates a crash).
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isCandidateRecord } from "../../../../.pi/packages/choco-pi-compaction/src/background/contract.ts";
import { InputSchema, writeArtifact } from "../artifacts.ts";
import { evaluateChecks } from "../checks.ts";
import { launch } from "../launch.ts";
import { replyPrompt, stepsPrompt } from "./prompts.ts";
import {
  RESTART_PHASES,
  RESTART_SETTINGS,
  WORKER_CHECKS,
  type PhaseResult,
  type RestartPhase,
} from "./restart-recovery.ts";
import { textAdoptionEvidence } from "./text-adoption-checks.ts";
import type { Host } from "./types.ts";
import { prepare } from "./workload.ts";

const LineSchema = Type.Object(
  { type: Type.String(), data: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);
const CheckpointDetailsSchema = Type.Object(
  { candidateId: Type.String() },
  { additionalProperties: true },
);
const StatusSchema = Type.Object(
  { state: Type.String(), reason: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
  { additionalProperties: true },
);
const SummaryDispatchSchema = Type.Object(
  { summary: Type.Literal(true) },
  { additionalProperties: true },
);
const REOPEN_MARKERS = {
  recover: "HARNESS-RESTART-REOPEN",
  reload: "HARNESS-RESTART-RELOAD",
} as const;

/** Candidate IDs found in the protected session file on disk (the crash-durable state). */
async function persistedCandidateIds(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const value: unknown = JSON.parse(line);
      if (!Value.Check(LineSchema, value) || value.type !== "custom") return [];
      return isCandidateRecord(value.data) ? [value.data.candidateId] : [];
    });
}

function checkpointCandidateIds(host: Host): string[] {
  return host.manager.getBranch().flatMap((entry) => {
    if (entry.type !== "compaction") return [];
    const details: unknown = entry.details;
    return Value.Check(CheckpointDetailsSchema, details) ? [details.candidateId] : [];
  });
}

function summaryDispatches(host: Host): number {
  return host.recorder.records.filter(
    (record) =>
      record.kind === "provider-dispatch" && Value.Check(SummaryDispatchSchema, record.data),
  ).length;
}

interface CoordinatorSnapshot {
  readonly state: string;
  readonly reason: string | null;
}

function statusOf(host: Host): CoordinatorSnapshot {
  const status: unknown = host.mainCoordinator()?.status();
  if (!Value.Check(StatusSchema, status)) return { state: "missing-coordinator", reason: null };
  return { state: status.state, reason: status.reason ?? null };
}

async function result(
  host: Host,
  phase: RestartPhase,
  coordinator: CoordinatorSnapshot,
): Promise<PhaseResult> {
  const file = host.sessionFile();
  if (!file) throw new Error("Session file not persisted");
  const verdicts = evaluateChecks(textAdoptionEvidence(host), WORKER_CHECKS);
  const status = (check: string) => verdicts.find((item) => item.check === check)?.status ?? "";
  return {
    phase,
    sessionFile: file,
    candidateIds: await persistedCandidateIds(file),
    coordinatorState: coordinator.state,
    coordinatorReason: coordinator.reason,
    summaryDispatches: summaryDispatches(host),
    checkpointCandidateIds: checkpointCandidateIds(host),
    checks: {
      "post-adoption-transport": status("post-adoption-transport"),
      "kept-suffix-exact": status("kept-suffix-exact"),
    },
    usage: (await host.usage()) ?? null,
  };
}

async function finish(host: Host, out: string, phase: RestartPhase, data: PhaseResult) {
  await writeArtifact(out, `${phase}-events.json`, Value.Parse(InputSchema, host.recorder.records));
  await writeArtifact(out, `${phase}.json`, data);
}

/** First process: prepare during the active turn, then crash before the boundary adoption. */
async function persist(host: Host, out: string): Promise<never> {
  const sessionId = host.manager.getSessionId();
  host.setForegroundObserver(async (dispatch) => {
    if (dispatch.sessionId !== sessionId || dispatch.index !== 1) return;
    await prepare(host);
    await finish(host, out, "persist", await result(host, "persist", statusOf(host)));
    process.kill(process.pid, "SIGKILL");
  });
  // Live: the kill lands before request 1 is forwarded, so later steps are never sent.
  await host.session.prompt(
    stepsPrompt(host, "HARNESS-RESTART-PERSIST-GO", 4, "HARNESS-RESTART-ACK"),
  );
  throw new Error("Phase persist did not reach the kill point");
}

/** Later processes: reopen, record recovery state, run one prompt. */
async function reopen(host: Host, out: string, phase: "recover" | "reload"): Promise<void> {
  const reopened = statusOf(host);
  const marker = REOPEN_MARKERS[phase];
  await host.session.prompt(replyPrompt(host, marker, `${marker}-ACK`));
  await finish(host, out, phase, await result(host, phase, reopened));
  // Crash after adoption too, so the reload phase reads only durable state.
  if (phase === "recover") process.kill(process.pid, "SIGKILL");
}

const { values } = parseArgs({
  options: {
    phase: { type: "string" },
    runtime: { type: "string" },
    scratch: { type: "string" },
    session: { type: "string" },
    out: { type: "string" },
    live: { type: "string" },
    "source-agent-dir": { type: "string" },
  },
  strict: true,
});
const phase = RESTART_PHASES.find((item) => item === values.phase);
if (!phase || !values.runtime || !values.scratch || !values.out)
  throw new Error("Usage: --phase persist|recover|reload --runtime D --scratch D --out D");
if (phase !== "persist" && !values.session) throw new Error("Reopen phases need --session");
const sourceAgentDir = values["source-agent-dir"];
if (values.live !== undefined && sourceAgentDir === undefined)
  throw new Error("Live phases need --source-agent-dir");
const host = await launch({
  scratchRoot: values.scratch,
  failureOut: values.out,
  scenario: "restart-recovery",
  profile: "worktree",
  settings: RESTART_SETTINGS,
  seedBytes: 20000,
  seedNamespace: "RESTART",
  cycles: phase === "persist" ? 6 : 2,
  runtimeRoot: values.runtime,
  resumeSessionFile: phase === "persist" ? undefined : values.session,
  preserveRuntime: true,
  live:
    values.live === undefined || sourceAgentDir === undefined
      ? undefined
      : { model: values.live, sourceAgentDir },
});
try {
  if (phase === "persist") await persist(host, values.out);
  else await reopen(host, values.out, phase);
} finally {
  await host.cleanup();
}
