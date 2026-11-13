import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AnthropicCapabilityGate, AnthropicSupportEntry } from "../anthropic/capability.ts";
import type { CapturingProviderOptions } from "../anthropic/capture.ts";
import type { LaneStream } from "../anthropic/lane-client.ts";
import type { AnthropicCompactionMode, OpaqueHistoryMode } from "../anthropic/mode.ts";
import type {
  AppendRecord,
  BackgroundCompactionSettings,
  ProviderScope,
  TokenCounter,
} from "../background/contract.ts";
import type { SchedulerClock } from "../background/scheduler.ts";
import type { SettingsLocation } from "../background/settings.ts";
import type { LaneRecordInput } from "../background/lane-journal.ts";
import type { TextSummarizer } from "../background/text-backend.ts";
import type { CodexCompactionSnapshot } from "../ownership.ts";
import type { HostCompactionPolicyReader } from "../session-state.ts";
import type { XaiCapturingOptions } from "../xai/capture.ts";
import type { XaiCompactionMode } from "../xai/mode.ts";
import type { AnnouncedRecord, NoticeLevel, NoticePolicy } from "./notices.ts";

/** Test and integration seams. Production registers with none of them. */
export interface BackgroundCompactionOptions {
  /** Settings sidecar lookup; defaults to {@link backgroundSettingsPaths}. */
  readonly settingsPaths?: (location: SettingsLocation) => readonly string[];
  /** Summarizer factory replacing the session-model summarizer (tests only). */
  readonly createTextSummarizer?: (model: Model<Api>) => TextSummarizer | undefined;
  readonly anthropic?: {
    readonly allowList?: readonly AnthropicSupportEntry[];
    readonly fetch?: typeof globalThis.fetch;
    readonly stream?: LaneStream;
    readonly capture?: CapturingProviderOptions;
    /**
     * Compaction mode reader replacing `<agentDir>/settings.json`
     * (`compactionAnthropic`); read at every session start.
     */
    readonly readMode?: (agentDir: string) => Promise<AnthropicCompactionMode>;
  };
  readonly xai?: {
    /** Exact combinations replacing the default xAI policy (tests, synthetic endpoints). */
    readonly allowList?: readonly AnthropicSupportEntry[];
    readonly fetch?: typeof globalThis.fetch;
    readonly capture?: XaiCapturingOptions;
    /** Mode reader replacing `<agentDir>/settings.json` (`compactionXai`); read at every session start. */
    readonly readMode?: (agentDir: string) => Promise<XaiCompactionMode>;
  };
  /**
   * Opaque-history mode reader replacing `<agentDir>/settings.json`
   * (`compactionOpaqueHistory`); read at every session start.
   */
  readonly readOpaqueHistoryMode?: (agentDir: string) => Promise<OpaqueHistoryMode>;
  readonly clock?: SchedulerClock;
  /** Provider prompt counter for admission; unset means the calibrated estimate decides. */
  readonly tokenCounter?: TokenCounter;
}

/** Everything one owner (main session or child) binds its coordinator to. */
export interface OwnerSpec {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly sessionId: string;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly model: Model<Api>;
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly thinkingLevel: ExtensionContext["thinkingLevel"];
  readonly retryPolicy: RetryPolicy | undefined;
  readonly compactionPolicy: HostCompactionPolicyReader | undefined;
  readonly codexCompaction: CodexCompactionSnapshot | undefined;
  readonly settings: Readonly<BackgroundCompactionSettings>;
  readonly scope: ProviderScope;
  readonly appendRecord: AppendRecord;
  readonly appendAnchor: () => string;
  readonly isOwnerCurrent: () => boolean;
  readonly allowAnthropic: boolean;
  readonly allowForeign: boolean;
  /**
   * xAI server-side compaction owns this model's compactions (server-side mode
   * and an admitted model). Background lanes then stay off: a text candidate
   * adopted over an opaque xAI checkpoint would only see its placeholder.
   */
  readonly xaiServerSide?: boolean;
  readonly report: (message: string) => void;
  /** Append one lane journal record for this owner's session (dropped once the owner is not current). */
  readonly journal: (record: LaneRecordInput) => void;
  /** Journal a lane transition and notify per policy (main: latest host ctx; child: the bridge's report). */
  readonly announce: (
    text: string,
    level: NoticeLevel,
    policy: NoticePolicy,
    record: AnnouncedRecord,
  ) => void;
  /** Whether Anthropic server-side compaction was turned off for this owner's session (replay rejection). */
  readonly anthropicDisabled: () => boolean;
  /**
   * The registration's Anthropic capability gate, shared by the foreground
   * path and the background lane so both see one cooldown (D7). Absent only
   * for partial test runtimes; the backend factory then builds its own.
   */
  readonly anthropicGate?: AnthropicCapabilityGate;
}
