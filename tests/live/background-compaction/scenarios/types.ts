import type { BackgroundCompactionSettings } from "../../../../packages/choco-pi-compaction/src/background/contract.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CheckEvidence, ObservedCheck } from "../checks.ts";
import type { launch } from "../launch.ts";
import type { SeedToolResults } from "../host-seed.ts";
export type Host = Awaited<ReturnType<typeof launch>>;

export interface Scenario {
  name: string;
  description: string;
  settings: Partial<BackgroundCompactionSettings>;
  seedBytes?: number;
  seedToolResults?: SeedToolResults;
  keepRecentTokens?: number;
  hostCompaction?: boolean;
  anthropicForeground?: boolean;
  xaiForeground?: boolean;
  agentSettings?: Readonly<Record<string, string>>;
  catalog?: boolean;
  offlineModels?: ReadonlyMap<string, Model<Api>>;
  extraOfflineModels?: readonly Model<Api>[];
  providerOwnedTransport?: boolean;
  factories?: readonly ExtensionFactory[];
  checks: readonly ObservedCheck[];
  markers: readonly string[];
  pending?: readonly string[];
  execute(host: Host): Promise<CheckEvidence>;
}

export interface PendingScenario {
  name: string;
  description: string;
  pending: readonly string[];
}

export function evidence(host: Host): CheckEvidence {
  return {
    records: host.recorder.records,
    mode: host.mode,
    networkCalls: host.networkCalls(),
    aborts: host.aborts(),
    notifications: host.notifications,
    knownSecrets: host.protectedSecrets(),
    observations: {},
  };
}
