import type { Api, Model, RetryPolicy } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AnthropicSupportEntry } from "../anthropic/capability.ts";
import type { CapturingProviderOptions } from "../anthropic/capture.ts";
import type { LaneStream } from "../anthropic/lane-client.ts";
import type { AnthropicCompactionMode } from "../anthropic/mode.ts";
import type {
  AppendRecord,
  BackgroundCompactionSettings,
  ProviderScope,
} from "../background/contract.ts";
import type { SchedulerClock } from "../background/scheduler.ts";
import type { SettingsLocation } from "../background/settings.ts";
import type { TextSummarizer } from "../background/text-backend.ts";
import type { CodexCompactionSnapshot } from "../ownership.ts";
import type { HostCompactionPolicyReader } from "../session-state.ts";

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
  readonly clock?: SchedulerClock;
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
  readonly report: (message: string) => void;
}
