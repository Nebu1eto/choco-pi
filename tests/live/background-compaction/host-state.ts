import type { WireBody } from "../../../.pi/packages/choco-pi-compaction/src/anthropic/capture.ts";
import type { Recorder } from "./artifacts.ts";
import { MarkerBook } from "./host-seed.ts";
import type { RequestBranch } from "./request-branch.ts";

interface ForegroundDispatch {
  readonly sessionId: string;
  readonly index: number;
}
/** Awaited inside the actual fake transport before a foreground response is returned. */
export type ForegroundObserver = (dispatch: ForegroundDispatch) => Promise<void>;
export interface ResponseDispatch {
  readonly sessionId: string;
  readonly index: number;
  readonly summary: boolean;
}
/** Consulted by the offline fake server before the default scripted response. */
export type ResponseOverride = (dispatch: ResponseDispatch) => Response | undefined;

/**
 * Memory-only parsed copy of one actual serialized request. It can hold
 * signatures, so it is never recorded; scenarios record derived booleans only.
 */
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

/** Mutable per-launch harness state shared by the launcher modules. */
export class HostState {
  disposed = false;
  networkCalls = 0;
  aborts = 0;
  mainSessionId = "";
  foregroundObserver: ForegroundObserver | undefined;
  responseOverride: ResponseOverride | undefined;
  readonly requestBranches: RequestBranch[] = [];
  readonly wire: WireRequest[] = [];
  /** Signatures the fake server issued; any other signature is a tamper (400). */
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
  /** Returns the next 0-based index for the session's request lane. */
  nextIndex(sessionId: string, summary: boolean): number {
    const counts = summary ? this.summaryCounts : this.requestCounts;
    const index = counts.get(sessionId) ?? 0;
    counts.set(sessionId, index + 1);
    return index;
  }
}
