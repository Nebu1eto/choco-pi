import * as fs from "node:fs";
import { safeSpawnAsync } from "../../../safe-spawn.ts";
import {
  type AvailabilityCause,
  type ProbeEvidence,
  classifyProbeFailure,
  startHostStallSampler,
} from "./availability-policy.ts";

export interface CandidateSweepResult {
  foundPath: string | null;
  sawTransient: boolean;
  transientCause: AvailabilityCause;
  hostStallMs: number;
  evidence?: ProbeEvidence;
}

export async function probeAvailabilityCandidates(
  candidates: readonly string[],
  probeArgs: readonly string[],
  timeoutMs: number,
): Promise<CandidateSweepResult> {
  let sawTransient = false;
  let transientCause: AvailabilityCause = "probe-timeout";
  let hostStallMs = 0;
  let evidence: ProbeEvidence | undefined;

  for (const candidate of candidates) {
    try {
      if (candidate.includes("\\") || candidate.includes("/")) {
        if (fs.existsSync(candidate)) {
          return {
            foundPath: candidate,
            sawTransient,
            transientCause,
            hostStallMs,
            evidence,
          };
        }
        continue;
      }
      const sampler = startHostStallSampler();
      let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
      let stallMs: number;
      try {
        result = await safeSpawnAsync(candidate, [...probeArgs], {
          timeout: timeoutMs,
        });
      } finally {
        stallMs = sampler.stop();
        hostStallMs += stallMs;
      }
      if (!result.error && result.status === 0) {
        return {
          foundPath: candidate,
          sawTransient,
          transientCause,
          hostStallMs,
          evidence,
        };
      }
      const classified = classifyProbeFailure(result, {
        hostStallMs: stallMs,
        command: candidate,
      });
      evidence = classified.evidence;
      if (classified.outcome === "transient") {
        sawTransient = true;
        transientCause = classified.cause;
      }
    } catch {}
  }

  return { foundPath: null, sawTransient, transientCause, hostStallMs, evidence };
}
