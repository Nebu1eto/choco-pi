import type {
  AgentSession,
  BuildSystemPromptOptions,
  CacheWarmingMode,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { CacheWarmingInfo } from "../../session-status.ts";
import { reinterpretHostValue } from "../runtime-values.ts";
import { sessionsRoots } from "../stats/report.ts";

export type ToolInventory = Pick<ExtensionAPI, "getAllTools" | "getActiveTools"> &
  Partial<Pick<ExtensionAPI, "getMcpServers" | "getSettings">>;

const TOOL_INVENTORY_KEY: unique symbol = Symbol.for("choco-pi.status.tool-inventory");
const CACHE_WARMING_SOURCE_KEY: unique symbol = Symbol.for("choco-pi.status.cache-warming-source");

export type CacheWarmingSource = {
  readonly session: Pick<AgentSession, "cacheWarmingStatus">;
  readonly settingsManager: { getCacheWarmingMode(): CacheWarmingMode };
};

export function setCacheWarmingSource(source: CacheWarmingSource): void {
  reinterpretHostValue<{ [CACHE_WARMING_SOURCE_KEY]?: CacheWarmingSource }>(globalThis)[
    CACHE_WARMING_SOURCE_KEY
  ] = source;
}

export function currentCacheWarming(): CacheWarmingInfo | undefined {
  const source = reinterpretHostValue<{
    [CACHE_WARMING_SOURCE_KEY]?: CacheWarmingSource;
  }>(globalThis)[CACHE_WARMING_SOURCE_KEY];
  if (!source) return undefined;
  return {
    mode: source.settingsManager.getCacheWarmingMode(),
    status: source.session.cacheWarmingStatus,
  };
}

export function getToolInventory(): ToolInventory | undefined {
  return reinterpretHostValue<{ [TOOL_INVENTORY_KEY]?: ToolInventory }>(globalThis)[
    TOOL_INVENTORY_KEY
  ];
}

export function setToolInventory(inventory: ToolInventory): void {
  reinterpretHostValue<{ [TOOL_INVENTORY_KEY]?: ToolInventory }>(globalThis)[TOOL_INVENTORY_KEY] =
    inventory;
}

export function statsRoots(): string[] {
  return sessionsRoots(getToolInventory()?.getSettings?.().sessionDir);
}

export function registeredMcpNames(): string[] {
  return (
    getToolInventory()
      ?.getMcpServers?.()
      .filter((server) => server.config.enabled !== false)
      .map((server) => server.name) ?? []
  );
}

export type PromptOptionsSource = { sessionId: string; read: () => BuildSystemPromptOptions };
let latestPromptOptions: PromptOptionsSource | undefined;

export function getLatestPromptOptions(): PromptOptionsSource | undefined {
  return latestPromptOptions;
}

export function setLatestPromptOptions(source: PromptOptionsSource): void {
  latestPromptOptions = source;
}

export function rememberPromptOptions(ctx: ExtensionCommandContext, sessionId: string): void {
  latestPromptOptions = { sessionId, read: () => ctx.getSystemPromptOptions() };
}

const openDialogs = new Set<() => void>();

export function registerDialogClose(close: () => void): () => void {
  openDialogs.add(close);
  return () => openDialogs.delete(close);
}

export function closeOpenDialogs(): void {
  for (const close of openDialogs) close();
}
