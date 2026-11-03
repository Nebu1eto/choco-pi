import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { join } from "node:path";
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

/**
 * The view state the dialog keeps for the Statistics tab. Without a section
 * the body shows every section in order (hosts without a terminal).
 */
export type StatsView = {
  period: Period;
  scope: Scope;
  expanded: boolean;
  section?: StatsSection;
};

/** Serialises the view for the tab controller's cache key. */
export function statsVariant(view: Pick<StatsView, "period" | "scope" | "section">): string {
  return `${view.period}:${view.scope}:${view.section ?? ""}`;
}

/** How long scanned logs, and every view computed from them, are reused. */
export const STATS_CACHE_TTL_MS = 5 * 60_000;

/** The logs of one scan, deduplicated once and shared by every period and scope. */
type ScanData = {
  records: CallRecord[];
  compactions: CompactionEvent[];
  laneEvents: LaneEvent[];
  scan: StatsScanSummary;
};

/** One period and scope computed from a scan: what a layout needs besides the view. */
export type StatsSnapshot = {
  report: StatsReport;
  scan: StatsScanSummary;
  period: Period;
  scope: Scope;
  /** When the logs were scanned; every period of the scan ends here. */
  now: number;
};

type ScanEntry = {
  /** Cache clock reading when the scan started; the TTL runs from here. */
  startedAt: number;
  now: number;
  data: Promise<ScanData>;
  views: Map<string, Promise<StatsSnapshot>>;
  /** Settled views, for synchronous reuse. */
  ready: Map<string, StatsSnapshot>;
};

/**
 * Scans and computed views, reused for STATS_CACHE_TTL_MS. A scan is shared
 * by every period and scope; each view is computed once per scan. Everything
 * from one scan expires with it, so all views on screen come from the same
 * snapshot of the logs.
 */
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
    // Read through Date at call time, so the process cache follows a replaced clock.
    clock: options.clock ?? (() => Date.now()),
    // The per-file cache lives for the process, so a rescan re-reads only files that changed.
    scan: options.scan ?? ((roots) => scanSessions(roots, processScanCache)),
    entries: new Map(),
  };
}

const processStatsCache = createStatsCache();

export type StatsDataOptions = {
  /** Current directory; "this project" also keeps the git worktrees sharing its repository. */
  cwd: string;
  /** Overrides the git lookup of sibling worktrees (tests). */
  projectDirs?: readonly string[];
  period: Period;
  scope: Scope;
  priceLookup?: PriceLookup;
  /** End of every period for a new scan; a scan still in the cache keeps its own. */
  now?: number;
  /** Session roots; defaults to Pi's `~/.pi/agent/sessions` plus a configured session directory. */
  roots?: readonly string[];
  cache?: StatsCache;
};

export type StatsBodyOptions = Omit<StatsDataOptions, "period" | "scope"> & {
  view: StatsView;
  /** Display names for models; defaults to formatted ids. */
  modelNames?: ModelNameLookup;
  style?: SessionInfoStyle;
};

/**
 * Where Pi writes session files: `<agent dir>/sessions/<project>/` (CA/config.js
 * `getSessionsDir`, not exported) and, when set, the `PI_CODING_AGENT_SESSION_DIR`
 * directory that replaces it.
 */
export function defaultSessionsRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [join(getAgentDir(), "sessions")];
  const configured = env["PI_CODING_AGENT_SESSION_DIR"];
  if (configured !== undefined && configured.length > 0) roots.push(configured);
  return roots;
}

const runFile = promisify(execFile);

/**
 * The current directory plus every worktree of its git repository, which Pi
 * records as separate session cwds. Outside git, or if git fails, just the cwd.
 */
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
  } catch {
    // Not a repository or git unavailable: the cwd alone is the project.
  }
  return [...dirs];
}

function rootsKey(roots: readonly string[]): string {
  return roots.join("\0");
}

/** A view's key within a scan; "this project" depends on the directory it was opened from. */
function viewKey(options: StatsDataOptions): string {
  const dirs =
    options.scope === "project" ? (options.projectDirs?.join("\0") ?? `cwd:${options.cwd}`) : "";
  return `${options.period}:${options.scope}:${dirs}`;
}

/** The scan of these roots while its TTL runs; an expired one is dropped. */
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

/** The view already computed from a live scan, without waiting; undefined when it must be loaded. */
export function peekStatsSnapshot(options: StatsDataOptions): StatsSnapshot | undefined {
  const cache = options.cache ?? processStatsCache;
  const entry = liveEntry(cache, rootsKey(options.roots ?? defaultSessionsRoots()));
  return entry?.ready.get(viewKey(options));
}

/**
 * The period and scope computed from the session logs. A scan younger than
 * the cache's TTL is reused, whatever period or scope it was first read for,
 * and a view it already computed is returned as is; concurrent loads share
 * one scan and one computation. A failed scan or view is not cached.
 */
export function loadStatsSnapshot(options: StatsDataOptions): Promise<StatsSnapshot> {
  const cache = options.cache ?? processStatsCache;
  const roots = options.roots ?? defaultSessionsRoots();
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

/**
 * A body that lays itself out for the columns it is given. The scan and the
 * aggregation run once; only the text layout is per width.
 */
export type StatsLayout = (width: number) => string;

/** How a snapshot is laid out: the parts of the view that need no new data. */
export type StatsLayoutOptions = {
  expanded: boolean;
  section?: StatsSection;
  /** Display names for models; defaults to formatted ids. */
  modelNames?: ModelNameLookup;
  style?: SessionInfoStyle;
};

/** Lays a computed snapshot out; expanding or changing section never reads the logs again. */
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

/** Load (or reuse) the snapshot for a view, then lay it out. */
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

/** The body at the default width, for hosts without a terminal. */
export async function statsBody(options: StatsBodyOptions): Promise<string> {
  return (await statsLayout(options))(STATS_DEFAULT_WIDTH);
}

/** The subset of Pi's model registry the Statistics tab reads. */
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

/** Display names from Pi's model registry; undefined for models it no longer lists. */
export function registryModelNames(registry: StatsModelRegistry): ModelNameLookup {
  return (provider, model) => {
    const name = registry.find(provider, model)?.name;
    return name === undefined || name.length === 0 ? undefined : name;
  };
}

/** A price lookup over Pi's model registry; a model without a listed price yields undefined. */
export function registryPriceLookup(registry: StatsModelRegistry): PriceLookup {
  return (provider, model) => {
    const found = registry.find(provider, model);
    if (!found) return undefined;
    const { input, output, cacheRead, cacheWrite, tiers } = found.cost;
    if (input + output + cacheRead + cacheWrite <= 0) return undefined;
    return tiers === undefined
      ? { input, output, cacheRead, cacheWrite }
      : { input, output, cacheRead, cacheWrite, tiers: tiers.map((tier) => ({ ...tier })) };
  };
}
