import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionInfoStyle } from "../session-usage.ts";
import {
  aggregateStats,
  dedupeRecords,
  filterEvents,
  filterRecords,
  type Period,
  type PriceLookup,
  type Scope,
} from "./aggregate.ts";
import { formatStats, STATS_DEFAULT_WIDTH } from "./format.ts";
import type { ModelNameLookup } from "./names.ts";
import { scanSessions, type ScanCache } from "./scan.ts";

/** The view state the dialog keeps for the Statistics tab. */
export type StatsView = { period: Period; scope: Scope; expanded: boolean };

/** Serialises the view for the tab controller's cache key. */
export function statsVariant(view: Pick<StatsView, "period" | "scope">): string {
  return `${view.period}:${view.scope}`;
}

export type StatsBodyOptions = {
  /** Current directory; "this project" also keeps the git worktrees sharing its repository. */
  cwd: string;
  /** Overrides the git lookup of sibling worktrees (tests). */
  projectDirs?: readonly string[];
  view: StatsView;
  priceLookup?: PriceLookup;
  /** Display names for models; defaults to formatted ids. */
  modelNames?: ModelNameLookup;
  style?: SessionInfoStyle;
  now?: number;
  /** Session roots; defaults to Pi's `~/.pi/agent/sessions` plus a configured session directory. */
  roots?: readonly string[];
  cache?: ScanCache;
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

const processCache: ScanCache = new Map();
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

/**
 * Scan the session logs and render the Statistics tab. The scan cache lives
 * for the process, so reopening the tab re-reads only files that changed.
 */
/**
 * A body that lays itself out for the columns it is given. The scan and the
 * aggregation run once; only the text layout is per width.
 */
export type StatsLayout = (width: number) => string;

export async function statsLayout(options: StatsBodyOptions): Promise<StatsLayout> {
  const now = options.now ?? Date.now();
  const cache = options.cache ?? processCache;
  const scanned = await scanSessions(options.roots ?? defaultSessionsRoots(), cache);
  const all = dedupeRecords(scanned.sessions.flatMap((session) => session.records));
  const projectDirs =
    options.projectDirs ??
    (options.view.scope === "project" ? await projectDirsOf(options.cwd) : [options.cwd]);
  const filtered = filterRecords(all.records, {
    period: options.view.period,
    scope: options.view.scope,
    projectDirs,
    now,
  });
  const eventFilter = {
    period: options.view.period,
    scope: options.view.scope,
    projectDirs,
    now,
  };
  const report = aggregateStats(filtered, {
    priceLookup: options.priceLookup,
    compactions: filterEvents(
      scanned.sessions.flatMap((session) => session.compactions),
      eventFilter,
    ),
    laneEvents: filterEvents(
      scanned.sessions.flatMap((session) => session.laneEvents),
      eventFilter,
    ),
  });
  const scan = {
    sessions: scanned.sessions.length,
    files: scanned.files,
    calls: all.records.length,
    duplicates: all.duplicates,
  };
  const byWidth = new Map<number, string>();
  return (width) => {
    const cached = byWidth.get(width);
    if (cached !== undefined) return cached;
    const body = formatStats(report, {
      period: options.view.period,
      scope: options.view.scope,
      expanded: options.view.expanded,
      style: options.style,
      now,
      scan,
      width,
      modelNames: options.modelNames,
    });
    byWidth.set(width, body);
    return body;
  };
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
