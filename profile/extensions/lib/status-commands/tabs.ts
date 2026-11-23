import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isString, type RuntimeValue } from "../runtime-values.ts";
import { STATS_SECTION_ROWS } from "../stats/format.ts";

export type StatusTabId = "status" | "context" | "usage" | "preferences" | "stats";
export type TextTabId = "status" | "context" | "usage" | "stats";

export const STATUS_TABS: ReadonlyArray<{ id: StatusTabId; title: string }> = [
  { id: "status", title: "Status" },
  { id: "context", title: "Context" },
  { id: "usage", title: "Usage" },
  { id: "preferences", title: "Preferences" },
  { id: "stats", title: "Statistics" },
];

export const TAB_PADDING = 2;
export const TEXT_PADDING = 1;

export function statusTabAt(row: string, x: number): StatusTabId | undefined {
  const text = stripVTControlCharacters(row);
  for (const tab of STATUS_TABS) {
    const title = stripVTControlCharacters(tab.title);
    const at = text.indexOf(title);
    if (title.length === 0 || at < 0) continue;
    const start = visibleWidth(text.slice(0, at));
    if (x >= start - TAB_PADDING && x < start + visibleWidth(title) + TAB_PADDING) return tab.id;
  }
  return undefined;
}

export const USAGE_REFRESH_MS = 3 * 60_000;

const AUTO_REFRESH_TABS: ReadonlySet<TextTabId> = new Set<TextTabId>(["usage"]);

const EXPANDABLE_TABS: ReadonlySet<StatusTabId> = new Set<StatusTabId>([
  "status",
  "context",
  "stats",
]);

export function isExpandableTab(id: StatusTabId): boolean {
  return EXPANDABLE_TABS.has(id);
}

export const STATS_VIEWPORT_ROWS = STATS_SECTION_ROWS;
const STATS_CHROME_ROWS = 10;
const STATS_MIN_VIEWPORT_ROWS = 5;

export function statsViewportRows(terminalRows: number, chromeRows = 2): number {
  return Math.max(
    STATS_MIN_VIEWPORT_ROWS,
    Math.min(
      STATS_VIEWPORT_ROWS,
      Math.floor(terminalRows) - STATS_CHROME_ROWS - Math.max(0, chromeRows - 2),
    ),
  );
}

export function clampScrollTop(top: number, total: number, height: number): number {
  return Math.max(0, Math.min(top, total - height));
}

export type TabController = {
  activate: (id: TextTabId, expanded?: boolean, variant?: string) => void;
  invalidate: () => void;
  dispose: () => void;
};

export type TabBody = string | ((width: number) => string);
export type TabLoad = TabBody | Promise<TabBody> | { body: string; refresh: Promise<() => string> };

export function renderTabBody(body: TabBody, width: number): string {
  return isString(body) ? body : body(width);
}

export function createTabController(options: {
  load: (id: TextTabId, expanded: boolean, variant: string) => TabLoad;
  paint: (body: TabBody, view: { preserveScroll: boolean }) => void;
  loading: () => string;
  failure: (id: TextTabId, message: string) => string;
  intervalMs?: number;
}): TabController {
  const cache = new Map<string, TabBody>();
  const intervalMs = options.intervalMs ?? USAGE_REFRESH_MS;
  let active: TextTabId | undefined;
  let activeExpanded = false;
  let activeVariant = "";
  let token = 0;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const viewKey = (id: TextTabId, expanded: boolean, variant: string): string =>
    `${id}:${expanded ? "all" : ""}:${variant}`;
  const query = (id: TextTabId, expanded: boolean, variant: string, background: boolean): void => {
    const current = ++token;
    const currentGeneration = generation;
    const owns = (): boolean =>
      current === token &&
      active === id &&
      activeExpanded === expanded &&
      activeVariant === variant;
    const accept = (body: TabBody, preserveScroll = background): void => {
      if (currentGeneration !== generation) return;
      cache.set(viewKey(id, expanded, variant), body);
      if (owns()) options.paint(body, { preserveScroll });
    };
    const fail = (error: RuntimeValue): void => {
      if (!owns()) return;
      if (cache.has(viewKey(id, expanded, variant))) return;
      const message = error instanceof Error ? error.message : String(error);
      options.paint(options.failure(id, message), {
        preserveScroll: background,
      });
    };
    try {
      const body = options.load(id, expanded, variant);
      if (isString(body)) accept(body);
      else if ("body" in body) {
        accept(body.body);
        void body.refresh
          .then((render) => {
            if (currentGeneration !== generation || !owns()) return;
            accept(render(), true);
          })
          .catch(fail);
      } else if ("then" in body) void body.then(accept).catch(fail);
      else accept(body);
    } catch (error) {
      fail(error);
    }
  };
  const restartTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = setInterval(() => {
      if (active !== undefined && AUTO_REFRESH_TABS.has(active))
        query(active, activeExpanded, activeVariant, true);
    }, intervalMs);
    timer.unref?.();
  };
  return {
    activate: (id: TextTabId, expanded = false, variant = "") => {
      active = id;
      activeExpanded = expanded;
      activeVariant = variant;
      options.paint(cache.get(viewKey(id, expanded, variant)) ?? options.loading(), {
        preserveScroll: false,
      });
      restartTimer();
      query(id, expanded, variant, false);
    },
    invalidate: () => {
      cache.clear();
      generation++;
      token++;
      if (active === undefined) return;
      options.paint(options.loading(), { preserveScroll: true });
      query(active, activeExpanded, activeVariant, true);
    },
    dispose: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      generation++;
      token++;
    },
  };
}
