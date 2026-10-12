import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CheckEvidence, Observation } from "../checks.ts";
import { WORKTREE } from "../profile.ts";
import { evidence, type Host, type Scenario } from "./types.ts";

export const RESTART_SETTINGS = { enabled: true, text: true, minReductionTokens: 0 };
export const RESTART_PHASES = ["persist", "recover", "reload"] as const;
export type RestartPhase = (typeof RESTART_PHASES)[number];
/** Transport checks each reopened worker evaluates on its own wire. */
export const WORKER_CHECKS = ["post-adoption-transport", "kept-suffix-exact"] as const;
export const PHASE_RECORD = "restart-phase";

/** Real provider usage of one live worker phase (null in fake mode). */
export const PhaseUsageSchema = Type.Union([
  Type.Null(),
  Type.Object(
    {
      requests: Type.Integer(),
      inputTokens: Type.Integer(),
      outputTokens: Type.Integer(),
      unreported: Type.Integer(),
    },
    { additionalProperties: true },
  ),
]);

const PhaseResultSchema = Type.Object({
  phase: Type.Union([Type.Literal("persist"), Type.Literal("recover"), Type.Literal("reload")]),
  sessionFile: Type.String(),
  candidateIds: Type.Array(Type.String()),
  coordinatorState: Type.String(),
  coordinatorReason: Type.Union([Type.String(), Type.Null()]),
  summaryDispatches: Type.Integer(),
  checkpointCandidateIds: Type.Array(Type.String()),
  checks: Type.Object({
    "post-adoption-transport": Type.String(),
    "kept-suffix-exact": Type.String(),
  }),
  usage: PhaseUsageSchema,
});
export type PhaseResult = Static<typeof PhaseResultSchema>;

const WORKER = fileURLToPath(new URL("./restart-recovery-worker.ts", import.meta.url));

interface PhaseRun {
  readonly result: PhaseResult;
  readonly signal: string | null;
  readonly ref: number;
}

interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
}

interface PhaseDirs {
  readonly runtime: string;
  readonly scratch: string;
  readonly out: string;
}

function spawnWorker(args: readonly string[]): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      cwd: WORKTREE,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderrTail: stderr }));
  });
}

function workerArgs(host: Host, dirs: PhaseDirs, phase: RestartPhase, sessionFile?: string) {
  const args = ["--phase", phase, "--runtime", dirs.runtime, "--scratch", dirs.scratch];
  args.push("--out", dirs.out, ...(sessionFile ? ["--session", sessionFile] : []));
  if (host.live)
    args.push("--live", host.live.model, "--source-agent-dir", host.live.sourceAgentDir);
  return args;
}

async function runPhase(
  host: Host,
  dirs: PhaseDirs,
  phase: RestartPhase,
  sessionFile?: string,
): Promise<PhaseRun> {
  const exit = await spawnWorker(workerArgs(host, dirs, phase, sessionFile));
  if (!host.isCurrent()) throw new Error("Owner disposed during restart phase");
  const text = await readFile(join(dirs.out, `${phase}.json`), "utf8").catch(() => undefined);
  if (text === undefined) {
    host.recorder.record("restart-phase-failed", { phase, ...exit });
    throw new Error(`Restart phase ${phase} wrote no result (exit ${String(exit.code)})`);
  }
  const result = Value.Parse(PhaseResultSchema, JSON.parse(text));
  const ref = host.recorder.record(PHASE_RECORD, {
    ...result,
    exitCode: exit.code,
    signal: exit.signal,
  });
  return { result, signal: exit.signal, ref };
}

function recoveryObservations(p1: PhaseRun, p2: PhaseRun, p3: PhaseRun): Observation[] {
  return [
    {
      description: "First process crashed after persisting one candidate and no checkpoint",
      actual: {
        signal: p1.signal,
        candidates: p1.result.candidateIds.length,
        checkpoints: p1.result.checkpointCandidateIds.length,
      },
      expected: { signal: "SIGKILL", candidates: 1, checkpoints: 0 },
      evidenceRefs: [p1.ref],
    },
    {
      description: "Fresh process restores the persisted candidate as ready",
      actual: p2.result.coordinatorState,
      expected: "ready",
      evidenceRefs: [p2.ref],
    },
    {
      description: "Recovered candidate is the one adopted after reopen",
      actual: p2.result.checkpointCandidateIds,
      expected: p1.result.candidateIds.slice(0, 1),
      evidenceRefs: [p1.ref, p2.ref],
    },
    {
      description: "No summarizer request after either reopen (no paid restart)",
      actual: [p2.result.summaryDispatches, p3.result.summaryDispatches],
      expected: [0, 0],
      evidenceRefs: [p2.ref, p3.ref],
    },
    {
      description: "Reload after the post-adoption crash keeps exactly the one checkpoint",
      actual: p3.result.checkpointCandidateIds,
      expected: p1.result.candidateIds.slice(0, 1),
      evidenceRefs: [p1.ref, p2.ref, p3.ref],
    },
  ];
}

function workerCheckObservations(
  p2: PhaseRun,
  p3: PhaseRun,
  check: (typeof WORKER_CHECKS)[number],
): Observation[] {
  return [
    {
      description: `Worker ${check} verdicts after recover and reload`,
      actual: [p2.result.checks[check], p3.result.checks[check]],
      expected: ["pass", "pass"],
      evidenceRefs: [p2.ref, p3.ref],
    },
  ];
}

async function runRestart(host: Host): Promise<CheckEvidence> {
  if (!host.artifactDir) throw new Error("restart-recovery needs an artifact directory (--out)");
  const dirs = {
    runtime: join(host.root, "restart-runtime"),
    scratch: join(host.root, "restart-scratch"),
    out: join(host.artifactDir, "workers"),
  };
  const p1 = await runPhase(host, dirs, "persist");
  const p2 = await runPhase(host, dirs, "recover", p1.result.sessionFile);
  const p3 = await runPhase(host, dirs, "reload", p1.result.sessionFile);
  const result = evidence(host);
  result.observations["durable-across-reopen"] = recoveryObservations(p1, p2, p3);
  for (const check of WORKER_CHECKS)
    result.observations[check] = workerCheckObservations(p2, p3, check);
  return result;
}

export const scenario: Scenario = {
  name: "restart-recovery",
  description: "Fresh-process candidate recovery and committed checkpoint reload (text)",
  settings: RESTART_SETTINGS,
  checks: ["kept-suffix-exact", "post-adoption-transport", "durable-across-reopen"],
  markers: ["HARNESS-RESTART-PERSIST-GO", "HARNESS-RESTART-REOPEN", "HARNESS-RESTART-RELOAD"],
  execute: runRestart,
};
