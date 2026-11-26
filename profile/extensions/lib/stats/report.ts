import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionInfoStyle } from "../session-usage.ts";
import {
  aggregateStats,
  bucketUnitOf,
  dedupeRecords,
  filterEvents,
  filterRecords,
  type Period,
  type PriceLookup,
  type Scope,
  type StatsReport,
} from "./aggregate.ts";
import { baseModelId } from "./fast.ts";
import type { CompactionEvent, LaneEvent } from "./compaction.ts";
import {
  formatStats,
  STATS_DEFAULT_WIDTH,
  type StatsScanSummary,
  type StatsSection,
} from "./format.ts";
import type { ModelNameLookup } from "./names.ts";
import type { CallRecord } from "./records.ts";
import { scanSessions, type ScanCache, type ScanResult } from "./scan.ts";

export type StatsView = {
  period: Period;
  scope: Scope;
  expanded: boolean;
  section?: StatsSection;
};

export function statsVariant(view: Pick<StatsView, "period" | "scope" | "section">): string {
  return `${view.period}:${view.scope}:${view.section ?? ""}`;
}

export const STATS_CACHE_TTL_MS = 5 * 60_000;

type ScanData = {
  records: CallRecord[];
  compactions: CompactionEvent[];
  laneEvents: LaneEvent[];
  scan: StatsScanSummary;
};

export type StatsSnapshot = {
  report: StatsReport;
  scan: StatsScanSummary;
  period: Period;
  scope: Scope;
  now: number;
};

type ScanEntry = {
  startedAt: number;
  now: number;
  data: Promise<ScanData>;
  views: Map<string, Promise<StatsSnapshot>>;
  ready: Map<string, StatsSnapshot>;
};

export type StatsCache = {
  ttlMs: number;
  clock: () => number;
  scan: (roots: readonly string[]) => Promise<ScanResult>;
  entries: Map<string, ScanEntry>;
};

const processScanCache: ScanCache = new Map();

export function createStatsCache(
  options: {
    ttlMs?: number;
    clock?: () => number;
    scan?: (roots: readonly string[]) => Promise<ScanResult>;
  } = {},
): StatsCache {
  return {
    ttlMs: options.ttlMs ?? STATS_CACHE_TTL_MS,
    clock: options.clock ?? (() => Date.now()),
    scan: options.scan ?? ((roots) => scanSessions(roots, processScanCache)),
    entries: new Map(),
  };
}

const processStatsCache = createStatsCache();

export type StatsDataOptions = {
  cwd: string;
  projectDirs?: readonly string[];
  period: Period;
  scope: Scope;
  priceLookup?: PriceLookup;
  now?: number;
  roots: readonly string[];
  cache?: StatsCache;
};

export type StatsBodyOptions = Omit<StatsDataOptions, "period" | "scope"> & {
  view: StatsView;
  modelNames?: ModelNameLookup;
  style?: SessionInfoStyle;
};

export function sessionsRoots(
  sessionDirSetting: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [resolve(getAgentDir(), "sessions")];
  const fromEnv = env["PI_CODING_AGENT_SESSION_DIR"];
  const configured = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : sessionDirSetting;
  if (configured === undefined || configured.length === 0) return roots;
  const normalized = SettingsManager.inMemory({ sessionDir: configured }).getSessionDir();
  if (normalized === undefined || normalized.length === 0) return roots;
  const dir = resolve(normalized);
  if (!roots.includes(dir)) roots.push(dir);
  return roots;
}

const runFile = promisify(execFile);

export async function projectDirsOf(cwd: string): Promise<string[]> {
  const dirs = new Set([cwd]);
  try {
    const { stdout } = await runFile("git", ["worktree", "list", "--porcelain"], {
      cwd,
      timeout: 3000,
    });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) dirs.add(line.slice("worktree ".length));
    }
  } catch {}
  return [...dirs];
}

function rootsKey(roots: readonly string[]): string {
  return roots.join("\0");
}

function viewKey(options: StatsDataOptions): string {
  const dirs =
    options.scope === "project" ? (options.projectDirs?.join("\0") ?? `cwd:${options.cwd}`) : "";
  return `${options.period}:${options.scope}:${dirs}`;
}

function liveEntry(cache: StatsCache, key: string): ScanEntry | undefined {
  const entry = cache.entries.get(key);
  if (entry === undefined) return undefined;
  if (cache.clock() - entry.startedAt < cache.ttlMs) return entry;
  cache.entries.delete(key);
  return undefined;
}

async function readScan(cache: StatsCache, roots: readonly string[]): Promise<ScanData> {
  const scanned = await cache.scan(roots);
  const all = dedupeRecords(scanned.sessions.flatMap((session) => session.records));
  return {
    records: all.records,
    compactions: scanned.sessions.flatMap((session) => session.compactions),
    laneEvents: scanned.sessions.flatMap((session) => session.laneEvents),
    scan: {
      sessions: scanned.sessions.length,
      files: scanned.files,
      calls: all.records.length,
      duplicates: all.duplicates,
    },
  };
}

async function computeSnapshot(
  data: ScanData,
  options: StatsDataOptions,
  now: number,
): Promise<StatsSnapshot> {
  const projectDirs =
    options.projectDirs ??
    (options.scope === "project" ? await projectDirsOf(options.cwd) : [options.cwd]);
  const filter = { period: options.period, scope: options.scope, projectDirs, now };
  const report = aggregateStats(filterRecords(data.records, filter), {
    priceLookup: options.priceLookup,
    compactions: filterEvents(data.compactions, filter),
    laneEvents: filterEvents(data.laneEvents, filter),
    unit: bucketUnitOf(options.period),
  });
  return { report, scan: data.scan, period: options.period, scope: options.scope, now };
}

export function peekStatsSnapshot(options: StatsDataOptions): StatsSnapshot | undefined {
  const cache = options.cache ?? processStatsCache;
  const entry = liveEntry(cache, rootsKey(options.roots));
  return entry?.ready.get(viewKey(options));
}

export function loadStatsSnapshot(options: StatsDataOptions): Promise<StatsSnapshot> {
  const cache = options.cache ?? processStatsCache;
  const roots = options.roots;
  const key = rootsKey(roots);
  let entry = liveEntry(cache, key);
  if (entry === undefined) {
    const created: ScanEntry = {
      startedAt: cache.clock(),
      now: options.now ?? Date.now(),
      data: readScan(cache, roots),
      views: new Map(),
      ready: new Map(),
    };
    cache.entries.set(key, created);
    void created.data.catch(() => {
      if (cache.entries.get(key) === created) cache.entries.delete(key);
    });
    entry = created;
  }
  const scan = entry;
  const id = viewKey(options);
  const existing = scan.views.get(id);
  if (existing !== undefined) return existing;
  const view = scan.data.then(async (data) => {
    const snapshot = await computeSnapshot(data, options, scan.now);
    scan.ready.set(id, snapshot);
    return snapshot;
  });
  scan.views.set(id, view);
  void view.catch(() => {
    if (scan.views.get(id) === view) scan.views.delete(id);
  });
  return view;
}

export type StatsLayout = (width: number) => string;

export type StatsLayoutOptions = {
  expanded: boolean;
  section?: StatsSection;
  modelNames?: ModelNameLookup;
  style?: SessionInfoStyle;
};

export function layoutStats(snapshot: StatsSnapshot, options: StatsLayoutOptions): StatsLayout {
  const byWidth = new Map<number, string>();
  return (width) => {
    const cached = byWidth.get(width);
    if (cached !== undefined) return cached;
    const body = formatStats(snapshot.report, {
      period: snapshot.period,
      scope: snapshot.scope,
      expanded: options.expanded,
      section: options.section,
      style: options.style,
      now: snapshot.now,
      scan: snapshot.scan,
      width,
      modelNames: options.modelNames,
    });
    byWidth.set(width, body);
    return body;
  };
}

export async function statsLayout(options: StatsBodyOptions): Promise<StatsLayout> {
  const snapshot = await loadStatsSnapshot({
    ...options,
    period: options.view.period,
    scope: options.view.scope,
  });
  return layoutStats(snapshot, {
    expanded: options.view.expanded,
    section: options.view.section,
    style: options.style,
    modelNames: options.modelNames,
  });
}

export async function statsBody(options: StatsBodyOptions): Promise<string> {
  return (await statsLayout(options))(STATS_DEFAULT_WIDTH);
}

export type StatsModelRegistry = {
  find(
    provider: string,
    modelId: string,
  ):
    | {
        name: string;
        cost: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          tiers?: readonly {
            inputTokensAbove: number;
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
          }[];
        };
      }
    | undefined;
};

function findRegistryModel(registry: StatsModelRegistry, provider: string, model: string) {
  const direct = registry.find(provider, model);
  if (direct !== undefined || provider !== "synthetic") return direct;
  const base = baseModelId(model);
  if (base !== model) {
    const stripped = registry.find(provider, base);
    if (stripped !== undefined) return stripped;
  }
  if (!base.includes(":")) return registry.find(provider, `hf:${base}`);
  return undefined;
}

export function registryModelNames(registry: StatsModelRegistry): ModelNameLookup {
  return (provider, model) => {
    const name = findRegistryModel(registry, provider, model)?.name;
    return name === undefined || name.length === 0 ? undefined : name;
  };
}

export function registryPriceLookup(registry: StatsModelRegistry): PriceLookup {
  return (provider, model) => {
    const found = findRegistryModel(registry, provider, model);
    if (!found) return undefined;
    const { input, output, cacheRead, cacheWrite, tiers } = found.cost;
    if (input + output + cacheRead + cacheWrite <= 0) return undefined;
    return tiers === undefined
      ? { input, output, cacheRead, cacheWrite }
      : { input, output, cacheRead, cacheWrite, tiers: tiers.map((tier) => ({ ...tier })) };
  };
}
