import type { CheckEvidence } from "../checks.ts";
import { stepsPrompt } from "./prompts.ts";
import { textAdoptionEvidence } from "./text-adoption-checks.ts";
import type { Host, Scenario } from "./types.ts";
import { prepare } from "./workload.ts";

const GO = "HARNESS-TEXT-BOUNDARY-GO";

/** Prepares while the second foreground request is in flight; adoption lands at the next boundary. */
async function runActiveAdoption(host: Host): Promise<CheckEvidence> {
  const sessionId = host.manager.getSessionId();
  let activeRef: number | undefined;
  host.setForegroundObserver(async (dispatch) => {
    if (dispatch.sessionId !== sessionId || dispatch.index !== 1) return;
    activeRef = host.recorder.record("active-preparation", {
      state: "active-foreground",
      isStreaming: host.session.isStreaming,
      ...dispatch,
    });
    await prepare(host);
    if (!host.isCurrent()) throw new Error("Owner disposed during active preparation");
  });
  try {
    // Live: four tool cycles give requests 0-4; adoption lands before request 2.
    await host.session.prompt(stepsPrompt(host, GO, 4, "HARNESS-TEXT-BOUNDARY-ACK"));
  } finally {
    if (host.isCurrent()) host.setForegroundObserver(undefined);
  }
  if (!host.isCurrent()) throw new Error("Owner disposed before active verdict");
  return textAdoptionEvidence(host, activeRef);
}

export const scenario: Scenario = {
  name: "text-boundary-adoption",
  description: "Text candidate prepared during an active turn, adopted at the next boundary",
  settings: {
    enabled: true,
    text: true,
    prepareAt: 0.01,
    hysteresis: 0.005,
    minReductionTokens: 0,
  },
  seedBytes: 20000,
  checks: [
    "kept-suffix-exact",
    "single-checkpoint",
    "text-summary-prefix-only",
    "post-adoption-transport",
    "consumers-notified-once",
  ],
  markers: [GO],
  execute: runActiveAdoption,
};
