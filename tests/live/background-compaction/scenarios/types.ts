import type { BackgroundCompactionSettings } from "../../../../.pi/packages/choco-pi-compaction/src/background/contract.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CheckEvidence, ObservedCheck } from "../checks.ts";
import type { launch } from "../launch.ts";
import type { SeedToolResults } from "../host-seed.ts";
export type Host = Awaited<ReturnType<typeof launch>>;

/** A scenario the offline (or approved live) harness drives end to end. */
export interface Scenario {
  name: string;
  description: string;
  settings: Partial<BackgroundCompactionSettings>;
  seedBytes?: number;
  /** Seeded step-tool exchanges with large results, after the padded prefix. */
  seedToolResults?: SeedToolResults;
  /** Host compaction keepRecentTokens; production derives the snapshot cut from it. */
  keepRecentTokens?: number;
  /** Enable Pi's own compaction for this scenario (host overflow recovery). */
  hostCompaction?: boolean;
  /** Serve the Anthropic model with background compaction off (foreground server-side path). */
  anthropicForeground?: boolean;
  /**
   * Serve an offline xAI Grok mirror (openai-responses) over the production xAI
   * capturing stream, with a scripted `/responses/compact` lane on global
   * fetch; background compaction off. Offline only.
   */
  xaiForeground?: boolean;
  /** Extra keys merged into the isolated agent settings.json. */
  agentSettings?: Readonly<Record<string, string>>;
  /** Seed every live catalog mirror and apply the worktree models.json overrides. */
  catalog?: boolean;
  /**
   * Offline subjects selectable with --offline-model (first is the default):
   * anthropic-messages models, or xai openai-responses models for an
   * `xaiForeground` scenario.
   */
  offlineModels?: ReadonlyMap<string, Model<Api>>;
  /** Offline xaiForeground: more xai models the provider serves (switch targets). */
  extraOfflineModels?: readonly Model<Api>[];
  /** Live: allow a model served by its own provider transport (Codex WebSocket). */
  providerOwnedTransport?: boolean;
  /** Extra in-host extension factories (probes) loaded after the harness tail. */
  factories?: readonly ExtensionFactory[];
  checks: readonly ObservedCheck[];
  /** Unique texts mapping branch entries to wire payloads (recorded in the manifest). */
  markers: readonly string[];
  /** Parts of the scenario this harness cannot drive yet; the run ends "pending" if any. */
  pending?: readonly string[];
  execute(host: Host): Promise<CheckEvidence>;
}

/** A scenario with no driver yet; running it reports why and exits "pending". */
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
