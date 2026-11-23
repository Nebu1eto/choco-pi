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

export interface BackgroundCompactionOptions {
  readonly settingsPaths?: (location: SettingsLocation) => readonly string[];
  readonly createTextSummarizer?: (model: Model<Api>) => TextSummarizer | undefined;
  readonly anthropic?: {
    readonly allowList?: readonly AnthropicSupportEntry[];
    readonly fetch?: typeof globalThis.fetch;
    readonly stream?: LaneStream;
    readonly capture?: CapturingProviderOptions;
    readonly readMode?: (agentDir: string) => Promise<AnthropicCompactionMode>;
  };
  readonly xai?: {
    readonly allowList?: readonly AnthropicSupportEntry[];
    readonly fetch?: typeof globalThis.fetch;
    readonly capture?: XaiCapturingOptions;
    readonly readMode?: (agentDir: string) => Promise<XaiCompactionMode>;
  };
  readonly readOpaqueHistoryMode?: (agentDir: string) => Promise<OpaqueHistoryMode>;
  readonly clock?: SchedulerClock;
  readonly tokenCounter?: TokenCounter;
}

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
  readonly xaiServerSide?: boolean;
  readonly report: (message: string) => void;
  readonly journal: (record: LaneRecordInput) => void;
  readonly announce: (
    text: string,
    level: NoticeLevel,
    policy: NoticePolicy,
    record: AnnouncedRecord,
  ) => void;
  readonly anthropicDisabled: () => boolean;
  readonly anthropicGate?: AnthropicCapabilityGate;
}
