import type { WireBody } from "../../../packages/choco-pi-compaction/src/anthropic/capture.ts";
import type { XaiWireBody } from "../../../packages/choco-pi-compaction/src/xai/capture.ts";
import type { Recorder } from "./artifacts.ts";
import { MarkerBook } from "./host-seed.ts";
import type { RequestBranch } from "./request-branch.ts";

interface ForegroundDispatch {
  readonly sessionId: string;
  readonly index: number;
}
export type ForegroundObserver = (dispatch: ForegroundDispatch) => Promise<void>;
export interface ResponseDispatch {
  readonly sessionId: string;
  readonly index: number;
  readonly summary: boolean;
}
export type ResponseOverride = (dispatch: ResponseDispatch) => Response | undefined;

export interface WireRequest {
  readonly sessionId: string;
  readonly index: number;
  readonly summary: boolean;
  readonly body: WireBody;
  readonly betas: readonly string[];
  readonly checkpointId: string | undefined;
  readonly bodyEvidenceRef: number;
  readonly status: number;
}

export interface XaiWireRequest {
  readonly index: number;
  readonly summary: boolean;
  readonly body: XaiWireBody;
  readonly status: number;
}

export interface XaiLaneRequest {
  readonly model: string;
  readonly instructions: string | undefined;
  readonly inputItems: number;
}

export class HostState {
  disposed = false;
  networkCalls = 0;
  aborts = 0;
  mainSessionId = "";
  foregroundObserver: ForegroundObserver | undefined;
  responseOverride: ResponseOverride | undefined;
  reportedInputTokens: number | undefined;
  readonly requestBranches: RequestBranch[] = [];
  readonly wire: WireRequest[] = [];
  readonly xaiWire: XaiWireRequest[] = [];
  readonly xaiLane: XaiLaneRequest[] = [];
  readonly issuedSignatures = new Set<string>();
  readonly requestCounts = new Map<string, number>();
  readonly summaryCounts = new Map<string, number>();
  readonly book: MarkerBook;
  readonly recorder: Recorder;
  constructor(recorder: Recorder) {
    this.recorder = recorder;
    this.book = new MarkerBook(() => !this.disposed);
  }
  assertCurrent(): void {
    if (this.disposed) throw new Error("Harness owner disposed");
  }
  nextIndex(sessionId: string, summary: boolean): number {
    const counts = summary ? this.summaryCounts : this.requestCounts;
    const index = counts.get(sessionId) ?? 0;
    counts.set(sessionId, index + 1);
    return index;
  }
}
