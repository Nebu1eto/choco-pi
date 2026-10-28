import { stripVTControlCharacters } from "node:util";
import { Value } from "typebox/value";
import { isString, reinterpretHostValue, type RuntimeValue } from "./lib/runtime-values.ts";
import {
  InteractiveMode,
  type AgentSession,
  type BuildSystemPromptOptions,
  type CacheWarmingMode,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  AGENT_OUTCOME_PREFIX,
  getPreferencesProvider,
  readAgentPreferences,
  type PreferencesExtraSection,
  type PreferencesPanelHandle,
  type PreferencesProvider,
} from "./lib/agent-preferences.ts";
import {
  agentPreferencesCompletions,
  buildAgentPreferencesSection,
  resolveAgentPreferencesArgs,
  runAgentPreferencesOutcome,
} from "./lib/agent-preferences-dialog.ts";
import {
  buildCodexPreferencesSections,
  CODEX_OUTCOME_PREFIX,
  getCodexPreferencesProvider,
} from "./lib/codex-preferences.ts";
import { buildSubagentPreferencesSections } from "./lib/subagent-preferences.ts";
import { buildAdvisorPreferencesSections } from "./lib/advisor-preferences.ts";
import { buildBackgroundCompactionPreferencesSections } from "./lib/background-compaction-preferences.ts";
import { PREFERENCES_HIDDEN_ROWS, PREFERENCES_LAYOUT } from "./lib/preferences-layout.ts";
import {
  buildNativeSettingsSections,
  createHostCommandContext,
  hostThinkingLevel,
  installNativeSettingsBridge,
  openNativeSettingsMenu,
  type NativeSettingsHost,
  type NativeSettingsFocus,
} from "./lib/native-settings.ts";
import {
  computeCacheWaste,
  formatSessionInfo,
  sessionInfoRows,
  summarizeMainUsage,
  summarizeSubagentUsage,
  type SessionInfoInput,
  type SessionInfoStyle,
} from "./lib/session-usage.ts";
import { buildContextReport, renderContext } from "./lib/context-report.ts";
import {
  DEFAULT_PERIOD,
  DEFAULT_SCOPE,
  nextPeriod,
  toggleScope,
  type StatsSelection,
} from "./lib/stats/aggregate.ts";
import {
  registryModelNames,
  registryPriceLookup,
  statsBody,
  statsLayout,
  statsVariant,
} from "./lib/stats/report.ts";
import { hasRunningSubagents } from "./lib/subagent-manager.ts";
import {
  condenseStatusRows,
  formatCacheWarming,
  formatStatus,
  statusHeading,
  summarizeStatusRows,
  summarizeMcpServers,
  type CacheWarmingInfo,
  type StatusRow,
} from "./session-status.ts";
import {
  formatUsageReport,
  readProviderUsages,
  resetCodexUsage,
  usageReport,
  type ProviderUsageReport,
} from "./provider-usage.ts";
import { hasUsageWindows, usageReportFrame } from "./lib/usage-report.ts";
import { CodexResetError } from "./lib/codex-resets.ts";
import { isStaleContextError, rethrowUnlessStaleContext } from "./lib/lifecycle.ts";
import { daybreakStatusValue, getDaybreakBridge } from "./lib/daybreak-state.ts";
import { getFastModeBridge, isOpenAISubscriptionSignIn } from "./lib/fast-mode-state.ts";
import { hostFramesEnabled } from "./lib/host-bridge/bridge.ts";
import { createProcessSources } from "./lib/host-bridge/sources.ts";
import { REPORT_STATUS_KEY } from "./lib/host-bridge/schema.ts";
import {
  REPORT_SCHEMA_VERSION,
  ReportFrameSchema,
  type ReportFrame,
  type ReportRow,
} from "./lib/host-bridge/report-schema.ts";

export type StatusTabId = "status" | "context" | "usage" | "preferences" | "stats";
export type TextTabId = "status" | "context" | "usage" | "stats";

export const STATUS_TABS: ReadonlyArray<{ id: StatusTabId; title: string }> = [
  { id: "status", title: "Status" },
  { id: "context", title: "Context" },
  { id: "usage", title: "Usage" },
  { id: "preferences", title: "Preferences" },
  { id: "stats", title: "Statistics" },
];

/** How often an open Usage tab re-queries the providers. */
export const USAGE_REFRESH_MS = 3 * 60_000;

/** Tabs whose body comes from a remote provider and therefore goes stale while the view stays open. */
const AUTO_REFRESH_TABS: ReadonlySet<TextTabId> = new Set<TextTabId>(["usage"]);

/**
 * Tabs that hold back their inventories until Ctrl+O asks for them. All
 * default to the one-line-per-fact view; the Usage tab has no long form, and
 * the Statistics tab expands its breakdown rows and footnotes.
 */
const EXPANDABLE_TABS: ReadonlySet<StatusTabId> = new Set<StatusTabId>([
  "status",
  "context",
  "stats",
]);

export function isExpandableTab(id: StatusTabId): boolean {
  return EXPANDABLE_TABS.has(id);
}

/** Most body rows the Statistics tab shows at once; longer bodies scroll inside it. */
export const STATS_VIEWPORT_ROWS = 30;
/** Rows kept free for the dialog's padding, tab header, key hint, and Pi's footer. */
const STATS_CHROME_ROWS = 10;
const STATS_MIN_VIEWPORT_ROWS = 5;

/** The Statistics body window's height for a terminal of `terminalRows` rows. */
export function statsViewportRows(terminalRows: number): number {
  return Math.max(
    STATS_MIN_VIEWPORT_ROWS,
    Math.min(STATS_VIEWPORT_ROWS, Math.floor(terminalRows) - STATS_CHROME_ROWS),
  );
}

/** The first visible row of a `height`-row window over `total` rows, kept in range. */
export function clampScrollTop(top: number, total: number, height: number): number {
  return Math.max(0, Math.min(top, total - height));
}

type ToolInventory = Pick<ExtensionAPI, "getAllTools" | "getActiveTools"> &
  Partial<Pick<ExtensionAPI, "getMcpServers" | "getSettings">>;

const TOOL_INVENTORY_KEY: unique symbol = Symbol.for("choco-pi.status.tool-inventory");
const CACHE_WARMING_SOURCE_KEY: unique symbol = Symbol.for("choco-pi.status.cache-warming-source");

/** The live InteractiveMode instance; both members are getters that follow session switches. */
type CacheWarmingSource = {
  readonly session: Pick<AgentSession, "cacheWarmingStatus">;
  readonly settingsManager: { getCacheWarmingMode(): CacheWarmingMode };
};

function setCacheWarmingSource(source: CacheWarmingSource): void {
  reinterpretHostValue<{ [CACHE_WARMING_SOURCE_KEY]?: CacheWarmingSource }>(globalThis)[
    CACHE_WARMING_SOURCE_KEY
  ] = source;
}

function currentCacheWarming(): CacheWarmingInfo | undefined {
  const source = reinterpretHostValue<{ [CACHE_WARMING_SOURCE_KEY]?: CacheWarmingSource }>(
    globalThis,
  )[CACHE_WARMING_SOURCE_KEY];
  if (!source) return undefined;
  return {
    mode: source.settingsManager.getCacheWarmingMode(),
    status: source.session.cacheWarmingStatus,
  };
}

function getToolInventory(): ToolInventory | undefined {
  return reinterpretHostValue<{ [TOOL_INVENTORY_KEY]?: ToolInventory }>(globalThis)[
    TOOL_INVENTORY_KEY
  ];
}

function setToolInventory(inventory: ToolInventory): void {
  reinterpretHostValue<{ [TOOL_INVENTORY_KEY]?: ToolInventory }>(globalThis)[TOOL_INVENTORY_KEY] =
    inventory;
}

export type TabController = {
  /**
   * Switch to a tab in one of its two views, repaint the last body, and re-query it.
   * `variant` names a tab-local view (the Statistics period and scope) that is cached apart.
   */
  activate: (id: TextTabId, expanded?: boolean, variant?: string) => void;
  /** Drop theme-dependent bodies and refresh the visible tab without losing its scroll position. */
  invalidate: () => void;
  /** Stop the refresh timer. */
  dispose: () => void;
};

/**
 * Keeps the visible tab body current: every activation re-queries the tab, and
 * an auto-refreshing tab is re-queried again every `intervalMs` while it stays
 * open. A cached body is painted immediately so a refetch never blanks the view,
 * and a failed background refresh keeps the last good body instead of replacing it.
 *
 * A tab's concise and expanded bodies are cached separately, so toggling the
 * view paints the other one immediately instead of blanking on every keypress.
 */
/**
 * A tab body: a string laid out once, or a function that lays itself out for
 * the columns the dialog has (the Statistics tab, whose tables adapt).
 */
export type TabBody = string | ((width: number) => string);

type TabLoad = TabBody | Promise<TabBody> | { body: string; refresh: Promise<() => string> };

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
    /** True while this query still owns the visible view. */
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
      options.paint(options.failure(id, message), { preserveScroll: background });
    };
    try {
      const body = options.load(id, expanded, variant);
      if (isString(body)) accept(body);
      else if ("body" in body) {
        accept(body.body);
        void body.refresh
          .then((render) => {
            // Check ownership before the deferred renderer touches context or theme.
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

/**
 * Rows the Session Info block already states. `/status` absorbed Pi's `/session`
 * command, so identity is reported once at the top instead of twice.
 */
const SESSION_INFO_ROWS: ReadonlySet<string> = new Set([
  "Session name",
  "Session ID",
  "Session file",
]);

/** The figures behind the Session Info block, shared by the text tab and the host report. */
function sessionInfoInput(ctx: ExtensionCommandContext): SessionInfoInput {
  const entries = ctx.sessionManager.getEntries();
  const sessionId = ctx.sessionManager.getSessionId();
  return {
    sessionName: ctx.sessionManager.getSessionName(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    sessionId,
    main: summarizeMainUsage(entries),
    cacheWaste: computeCacheWaste(entries, ctx.modelRegistry),
    subagents: summarizeSubagentUsage(sessionId),
    subagentsRunning: hasRunningSubagents(),
    cacheWarming: (() => {
      const warming = currentCacheWarming();
      const decision = warming?.status?.decision;
      const summary = formatCacheWarming(warming);
      return decision?.economicsAvailable
        ? { summary, missCost: decision.missCost, warmCost: decision.warmCost }
        : { summary };
    })(),
  };
}

/** Fast mode as `/fast status` words it, or "not initialized" before the session registers it. */
function fastStatusValue(ctx: ExtensionCommandContext, sessionId: string): string {
  const decision = getFastModeBridge().get(sessionId)?.decide(ctx.model, ctx.modelRegistry);
  if (!decision) return "not initialized";
  if (!decision.requested) return "off";
  if (decision.reason !== undefined) return `on (saved; ${decision.reason})`;
  return decision.supported ? "on" : "on (saved; inactive for this model)";
}

/** The Environment rows in their expanded form, shared by the text tab and the host report. */
function environmentRows(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  mcpLabel: string,
): StatusRow[] {
  const sessionId = ctx.sessionManager.getSessionId();
  const all = summarizeStatusRows(ctx, thinkingLevel, mcpLabel).filter(
    (row) => !SESSION_INFO_ROWS.has(row.label),
  );
  all.push(
    {
      label: "Daybreak",
      value: daybreakStatusValue(
        getDaybreakBridge().get(sessionId)?.getState(),
        isOpenAISubscriptionSignIn(ctx.model, ctx.modelRegistry),
      ),
    },
    { label: "Fast mode", value: fastStatusValue(ctx, sessionId) },
  );
  return all;
}

/**
 * The Status tab: the retired `/session` block first, then the environment rows.
 *
 * The session block leads because it answers what the session cost, which is
 * what someone opening `/status` mid-run is usually after; the environment rows
 * below it change only when the configuration does.
 *
 * Concise mode keeps every environment row on one line and drops the session
 * footnotes; expanded mode adds the skill, agent, and context-file inventories
 * those row counts stand for.
 */
export function statusBody(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  style?: SessionInfoStyle,
  expanded = false,
  mcpLabel = "checking configuration (see /mcp)",
): string {
  const info = formatSessionInfo(sessionInfoInput(ctx), style, expanded);
  const all = environmentRows(ctx, thinkingLevel, mcpLabel);
  const rows = expanded ? all : condenseStatusRows(all);
  return `${info}\n\n${statusHeading(style)}\n\n${formatStatus(rows, style)}`;
}

/** A multi-line status value becomes its headline plus the dedented inventory as a hint. */
function reportRow(row: StatusRow): ReportRow {
  const [value = "", ...rest] = row.value.split("\n");
  const hint = rest
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return hint.length > 0 ? { label: row.label, value, hint } : { label: row.label, value };
}

/**
 * The structured `/status` report for RPC hosts: the Session Info figures and
 * every Environment row, including Daybreak, Fast mode, and reasoning effort.
 */
export function buildStatusReport(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  mcpLabel = "checking configuration (see /mcp)",
  at: Date = new Date(),
): ReportFrame {
  return {
    schema: REPORT_SCHEMA_VERSION,
    kind: "status",
    at: at.toISOString(),
    sessionId: ctx.sessionManager.getSessionId(),
    title: "Status",
    sections: [
      { title: "Session Info", rows: sessionInfoRows(sessionInfoInput(ctx)) },
      { title: "Environment", rows: environmentRows(ctx, thinkingLevel, mcpLabel).map(reportRow) },
    ],
  };
}

/** Sends one report frame; refuses a frame the documented schema would reject. */
function publishReport(ui: Pick<ExtensionContext["ui"], "setStatus">, frame: ReportFrame): void {
  const kind = frame.kind;
  if (!Value.Check(ReportFrameSchema, frame)) {
    throw new Error(`status-commands produced an invalid ${kind} report frame`);
  }
  ui.setStatus(REPORT_STATUS_KEY, JSON.stringify(frame));
}

/**
 * The latest system-prompt options seen for a session. Event contexts carry
 * none, so automatic reports read the options of the most recent command
 * context or `before_agent_start` event of the same session.
 */
let latestPromptOptions: { sessionId: string; read: () => BuildSystemPromptOptions } | undefined;

function rememberPromptOptions(ctx: ExtensionCommandContext, sessionId: string): void {
  latestPromptOptions = { sessionId, read: () => ctx.getSystemPromptOptions() };
}

/**
 * Publishes the structured report, then the plain-text fallback. A report
 * failure never suppresses the text: it is raised after the notice, except a
 * stale context, which ends the command silently.
 */
function reportThenNotify(
  ctx: ExtensionCommandContext,
  build: (() => ReportFrame) | undefined,
  body: string,
): void {
  let failure: { error: RuntimeValue } | undefined;
  if (build) {
    try {
      publishReport(ctx.ui, build());
    } catch (error) {
      if (isStaleContextError(error)) return;
      failure = { error };
    }
  }
  // Hosts without a terminal render notices as plain text; escape codes
  // would show up verbatim.
  ctx.ui.notify(stripVTControlCharacters(body), "info");
  if (failure) rethrowUnlessStaleContext(failure.error);
}

/** Trailing debounce for automatic context reports. */
export const REPORT_DEBOUNCE_MS = 500;

/**
 * Shortest gap between two automatic usage reports. Each one queries every
 * connected provider, so it is sent on the first turn end of a session and
 * then at most this often, never on every turn.
 */
export const USAGE_REPORT_INTERVAL_MS = 10 * 60_000;

type ReportApi = Pick<ExtensionAPI, "on" | "getAllTools" | "getActiveTools"> &
  Partial<Pick<ExtensionAPI, "getMcpServers">>;

export interface ReportAutoPublishOptions {
  /** `CHOCO_PI_HOST`; reports are automatic only where host-bridge progress frames are. */
  host: string | undefined;
  /** True when this extension instance was loaded for a subagent child session. */
  inChildLoad?: boolean;
  isChildSession?: (sessionId: string) => boolean;
  /** Schedules `callback` once and returns its canceller. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** Queries the providers for an automatic usage report; defaults to the live read. */
  readUsage?: (ctx: ExtensionContext) => Promise<ProviderUsageReport>;
  /** Clock for the usage-report interval, in epoch ms. */
  now?: () => number;
  warn?: (message: string) => void;
}

function defaultTimer(callback: () => void, ms: number): () => void {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return () => clearTimeout(handle);
}

/**
 * Publishes a context report on `session_start`, after each `turn_end`, and on
 * `model_select`, debounced, only in rpc mode under a bridge-enabled host. A
 * report needs the session's system-prompt options, so none is sent until a
 * command or `before_agent_start` has supplied them for the current session.
 *
 * A usage report follows the context report of the session's first
 * `turn_end`, then of a later one only once USAGE_REPORT_INTERVAL_MS has
 * passed since the last usage query. A query in which no provider reported a
 * quota window publishes nothing.
 */
export function registerReportAutoPublish(pi: ReportApi, options: ReportAutoPublishOptions): void {
  if (options.inChildLoad === true) return;
  const setTimer = options.setTimer ?? defaultTimer;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const readUsage = options.readUsage ?? readProviderUsages;
  const now = options.now ?? Date.now;
  let generation = 0;
  let cancel: (() => void) | undefined;
  let lastKey: string | undefined;
  /** A turn ended while the usage interval allowed a query; the next timer sends one. */
  let usageDue = false;
  let lastUsageQuery: number | undefined;
  /** Generation whose usage query is still running, so one session never overlaps two. */
  let usageInFlight: number | undefined;

  const usageAllowed = (): boolean =>
    usageInFlight !== generation &&
    (lastUsageQuery === undefined || now() - lastUsageQuery >= USAGE_REPORT_INTERVAL_MS);

  const enabledSession = (ctx: ExtensionContext): string | undefined => {
    if (!hostFramesEnabled(ctx.mode, options.host)) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    return options.isChildSession?.(sessionId) === true ? undefined : sessionId;
  };

  const publish = (ctx: ExtensionContext, sessionId: string, scheduled: number): void => {
    if (scheduled !== generation) return;
    try {
      if (ctx.sessionManager.getSessionId() !== sessionId) return;
      const source = latestPromptOptions;
      if (source?.sessionId !== sessionId) return;
      const frame = buildContextReport(pi, ctx, source.read());
      // Re-sending identical figures only moves the timestamp.
      const key = JSON.stringify({ ...frame, at: "" });
      if (key === lastKey) return;
      publishReport(ctx.ui, frame);
      lastKey = key;
    } catch (error) {
      // A timer callback has no caller to receive an error: report, never throw.
      if (isStaleContextError(error)) return;
      warn(
        `[status-commands] automatic context report failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const publishUsage = async (
    ctx: ExtensionContext,
    sessionId: string,
    scheduled: number,
  ): Promise<void> => {
    if (scheduled !== generation || !usageAllowed()) return;
    usageInFlight = scheduled;
    lastUsageQuery = now();
    try {
      if (ctx.sessionManager.getSessionId() !== sessionId) return;
      const report = await readUsage(ctx);
      if (scheduled !== generation) return;
      if (ctx.sessionManager.getSessionId() !== sessionId) return;
      if (!hasUsageWindows(report)) return;
      publishReport(ctx.ui, usageReportFrame(sessionId, report));
    } catch (error) {
      if (isStaleContextError(error)) return;
      warn(
        `[status-commands] automatic usage report failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (usageInFlight === scheduled) usageInFlight = undefined;
    }
  };

  const schedule = (ctx: ExtensionContext, turnEnd = false): void => {
    let sessionId: string | undefined;
    try {
      sessionId = enabledSession(ctx);
    } catch (error) {
      rethrowUnlessStaleContext(error);
      return;
    }
    if (sessionId === undefined) return;
    if (turnEnd && usageAllowed()) usageDue = true;
    cancel?.();
    const scheduled = generation;
    const target = sessionId;
    cancel = setTimer(() => {
      cancel = undefined;
      publish(ctx, target, scheduled);
      if (!usageDue || scheduled !== generation) return;
      usageDue = false;
      void publishUsage(ctx, target, scheduled);
    }, REPORT_DEBOUNCE_MS);
  };

  const reset = (): void => {
    generation += 1;
    cancel?.();
    cancel = undefined;
    lastKey = undefined;
    usageDue = false;
    lastUsageQuery = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    reset();
    schedule(ctx);
  });
  pi.on("session_shutdown", reset);
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const sessionId = enabledSession(ctx);
      if (sessionId === undefined) return;
      const promptOptions = event.systemPromptOptions;
      latestPromptOptions = { sessionId, read: () => promptOptions };
    } catch (error) {
      rethrowUnlessStaleContext(error);
    }
  });
  pi.on("turn_end", (_event, ctx) => schedule(ctx, true));
  pi.on("model_select", (_event, ctx) => schedule(ctx));
}

/** The Context tab body, or a notice when no extension API was captured. */
function contextBody(ctx: ExtensionCommandContext, expanded: boolean, styled: boolean): string {
  const inventory = getToolInventory();
  if (!inventory) return "The context report is unavailable in this session.";
  const body = renderContext(inventory, ctx, expanded, styled);
  if (!styled) return body;
  const heading = ctx.ui.theme.bold(ctx.ui.theme.fg("accent", "Context Usage"));
  return body.replace(/^Context Usage/, () => heading);
}

/** The Statistics view encoded in a tab variant, or the defaults when it carries none. */
function statsViewOf(variant: string): StatsSelection {
  const [period, scope] = variant.split(":");
  return {
    period: period === "7d" || period === "all" || period === "30d" ? period : DEFAULT_PERIOD,
    scope: scope === "project" ? scope : DEFAULT_SCOPE,
  };
}

export function tabBody(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  id: TextTabId,
  styled: boolean,
  expanded = false,
  variant = "",
): string | Promise<string> {
  const style = styled ? ctx.ui.theme : undefined;
  if (id === "stats") {
    const view = statsViewOf(variant);
    return statsBody({
      cwd: ctx.cwd,
      view: { period: view.period, scope: view.scope, expanded },
      priceLookup: registryPriceLookup(ctx.modelRegistry),
      modelNames: registryModelNames(ctx.modelRegistry),
      style,
    });
  }
  if (id === "usage") {
    return usageReport(ctx, style);
  }
  if (id === "context") return contextBody(ctx, expanded, styled);
  return statusBody(ctx, thinkingLevel, style, expanded);
}

function registeredMcpNames(): string[] {
  return (
    getToolInventory()
      ?.getMcpServers?.()
      .filter((server) => server.config.enabled !== false)
      .map((server) => server.name) ?? []
  );
}

/** MCP I/O refreshes only after the controller verifies this load still owns its view. */
function loadTabBody(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  id: TextTabId,
  expanded: boolean,
  variant: string,
): TabLoad {
  if (id === "stats") {
    const view = statsViewOf(variant);
    return statsLayout({
      cwd: ctx.cwd,
      view: { period: view.period, scope: view.scope, expanded },
      priceLookup: registryPriceLookup(ctx.modelRegistry),
      modelNames: registryModelNames(ctx.modelRegistry),
      style: ctx.ui.theme,
    });
  }
  if (id !== "status") return tabBody(ctx, thinkingLevel, id, true, expanded, variant);
  const cwd = ctx.cwd;
  const names = registeredMcpNames();
  const style = ctx.ui.theme;
  return {
    body: statusBody(ctx, thinkingLevel, style, expanded),
    refresh: summarizeMcpServers(cwd, names).then(
      (label) => () => statusBody(ctx, thinkingLevel, style, expanded, label),
    ),
  };
}

type PreferencesFocus = { section?: string; focusId?: string; openSubmenu?: boolean };

const openDialogs = new Set<() => void>();

function registerDialogClose(close: () => void): () => void {
  openDialogs.add(close);
  return () => openDialogs.delete(close);
}

function closeOpenDialogs(): void {
  for (const close of openDialogs) close();
}

const PREFERENCES_USAGE =
  "Usage: /preferences [editor|messages|statusline|viewport-indicators] [enable|disable|toggle], /preferences [messages|user-messages|working-line|statusline|agent], /preferences [language <name>|style <name>|daybreak on|off], or /preferences format <template>";

/**
 * Every row source the Preferences tab hosts on top of the panel's own
 * choco-ui sections. PREFERENCES_LAYOUT places their rows by id, so the order
 * here only decides which source owns an id two sources might both build.
 */
function buildPreferencesExtraSections(ctx: ExtensionCommandContext): PreferencesExtraSection[] {
  return [
    ...buildNativeSettingsSections(),
    ...buildCodexPreferencesSections(ctx),
    ...buildSubagentPreferencesSections(ctx),
    ...buildAdvisorPreferencesSections(ctx),
    ...buildBackgroundCompactionPreferencesSections(ctx),
    buildAgentPreferencesSection(ctx),
  ];
}

/** Non-TUI surface for /preferences: a text summary of the agent preferences. */
function preferencesSummary(ctx: ExtensionCommandContext): void {
  try {
    const preferences = readAgentPreferences();
    ctx.ui.notify(
      [
        `Agent language: ${preferences.language ?? "match user"}`,
        `Agent style: ${preferences.style ?? "default"}`,
        `On usage limit: ${preferences.onUsageLimit}`,
        `Daybreak default: ${preferences.daybreak ? "on" : "off"}`,
        "Run /preferences in the interactive TUI to change preferences.",
      ].join("\n"),
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not read agent preferences: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

/**
 * One pass of the Status/Usage/Preferences/Statistics dialog. Resolves `undefined` when
 * the dialog is done; any other string is a panel outcome the caller runs
 * before reopening the dialog on the Preferences tab.
 */
async function showTabOnce(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialFocus: PreferencesFocus,
  initialExpanded: boolean,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    if (initial === "preferences") {
      preferencesSummary(ctx);
      return undefined;
    }
    if (initial === "status") {
      const cwd = ctx.cwd;
      const names = registeredMcpNames();
      const owner = ctx.sessionManager;
      const currentSessionId = owner.getSessionId.bind(owner);
      const sessionId = currentSessionId();
      const label = await summarizeMcpServers(cwd, names);
      if (currentSessionId() !== sessionId) return undefined;
      rememberPromptOptions(ctx, sessionId);
      const body = statusBody(ctx, thinkingLevel, undefined, initialExpanded, label);
      reportThenNotify(ctx, () => buildStatusReport(ctx, thinkingLevel, label), body);
      return undefined;
    }
    if (initial === "stats") {
      const owner = ctx.sessionManager;
      const currentSessionId = owner.getSessionId.bind(owner);
      const sessionId = currentSessionId();
      const view = statsViewOf("");
      const body = await statsBody({
        cwd: ctx.cwd,
        view: { period: view.period, scope: view.scope, expanded: initialExpanded },
        priceLookup: registryPriceLookup(ctx.modelRegistry),
        modelNames: registryModelNames(ctx.modelRegistry),
      });
      if (currentSessionId() !== sessionId) return undefined;
      ctx.ui.notify(body, "info");
      return undefined;
    }
    if (initial === "context") {
      rememberPromptOptions(ctx, ctx.sessionManager.getSessionId());
      const inventory = getToolInventory();
      const body = contextBody(ctx, initialExpanded, false);
      reportThenNotify(
        ctx,
        inventory
          ? () => buildContextReport(inventory, ctx, ctx.getSystemPromptOptions())
          : undefined,
        body,
      );
      return undefined;
    }
    // Usage: one provider query feeds both the report and the text notice.
    const owner = ctx.sessionManager;
    const currentSessionId = owner.getSessionId.bind(owner);
    const sessionId = currentSessionId();
    const report = await readProviderUsages(ctx);
    if (currentSessionId() !== sessionId) return undefined;
    reportThenNotify(ctx, () => usageReportFrame(sessionId, report), formatUsageReport(report));
    return undefined;
  }
  const provider = getPreferencesProvider();
  if (initial === "preferences" && !provider) {
    ctx.ui.notify("The choco-pi-ui package is not loaded; Preferences is unavailable.", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let active = initial;
    let expanded = initialExpanded;
    let statsView: StatsSelection = {
      period: DEFAULT_PERIOD,
      scope: DEFAULT_SCOPE,
    };
    const variantOf = (id: TextTabId): string => (id === "stats" ? statsVariant(statsView) : "");
    let panel: PreferencesPanelHandle | undefined;
    let rememberedSection: string | undefined = initialFocus.section;
    let rememberedFocusId: string | undefined = initialFocus.focusId;
    let rememberedOpenSubmenu = initialFocus.openSubmenu === true;

    const headerText = new Text("", 0, 0);
    const bodyText = new Text("", 0, 0);
    const hintText = new Text("", 0, 0);
    // Text.setText drops its render cache, so only call it on a change.
    const shownText = new Map<Text, string>();
    const setText = (target: Text, value: string): void => {
      if (shownText.get(target) === value) return;
      shownText.set(target, value);
      target.setText(value);
    };
    /** The body painted last; a function body is laid out again for every render width. */
    let painted: TabBody = "";
    let paintedWidth = -1;
    /**
     * The Statistics body scrolls inside a fixed-height window so the tab
     * header and key hint stay on screen; other tabs render whole.
     */
    let statsTop = 0;
    let statsWindow: { top: number; height: number; total: number } | undefined;
    const statsHeight = (): number => statsViewportRows(tui.terminal.rows);
    const windowed = (lines: string[]): string[] => {
      statsWindow = undefined;
      if (active !== "stats") return lines;
      const height = statsHeight();
      if (lines.length <= height) return lines;
      statsTop = clampScrollTop(statsTop, lines.length, height);
      statsWindow = { top: statsTop, height, total: lines.length };
      return lines.slice(statsTop, statsTop + height);
    };
    const scrollStats = (delta: number): void => {
      const window = statsWindow;
      if (!window) return;
      statsTop = clampScrollTop(statsTop + delta, window.total, window.height);
      tui.requestRender();
    };
    const bodyView: Component = {
      render: (width) => {
        if (!isString(painted) && width !== paintedWidth) {
          paintedWidth = width;
          bodyText.setText(painted(width));
        }
        const body = windowed(bodyText.render(width));
        // The header and hint are read after the body so the hint can name the window.
        setText(headerText, header());
        setText(hintText, textHint());
        const blank = " ".repeat(width);
        return [...headerText.render(width), blank, ...body, blank, ...hintText.render(width)];
      },
      invalidate: () => {
        headerText.invalidate();
        bodyText.invalidate();
        hintText.invalidate();
      },
    };
    const component = new Box(1, 1, (value) => theme.fg("border", value));
    component.addChild(bodyView);
    const scrollView = new ScrollView(component, {
      primary: true,
      scrollbar: "auto",
      scrollbarTrackStyle: (value) => theme.fg("dim", value),
      scrollbarThumbStyle: (value) => theme.fg("text", value),
    });

    const header = (): string =>
      STATUS_TABS.map((tab) => {
        const label = `  ${tab.title}  `;
        return tab.id === active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
      }).join(theme.fg("dim", "·"));
    const digitHint = STATUS_TABS.map((_tab, index) => index + 1).join("/");
    const textHint = (): string => {
      const parts = ["Tab switches tabs", "↑/↓ scrolls", `${digitHint} jumps`];
      if (active === "stats" && statsWindow) {
        const { top, height, total } = statsWindow;
        parts[1] = `↑/↓ scrolls (${top + 1}–${top + height}/${total})`;
      }
      // The reset flow reads the legacy openai-codex login, not openai sign-in.
      if (active === "usage") parts.push("r uses a saved ChatGPT reset (openai-codex login)");
      if (active === "stats") parts.push("r cycles period", "p toggles scope");
      if (isExpandableTab(active)) parts.push(expanded ? "Ctrl+O collapses" : "Ctrl+O expands");
      parts.push("Enter/Esc closes");
      return theme.fg("dim", parts.join(" · "));
    };
    // An open submenu holds Tab and the digits, so the hint must not promise them.
    const panelHint = (): string => {
      let hint = `Tab switches tabs · ${digitHint} jumps · Esc closes`;
      if (panel?.hasOpenSubmenu?.()) hint = "Esc goes back";
      else if (panel?.hasActiveSearch?.())
        hint = "Type to filter · Enter/Space changes · Esc stops search";
      return theme.fg("dim", hint);
    };

    const paint = (body: TabBody, view: { preserveScroll: boolean }): void => {
      painted = body;
      paintedWidth = -1;
      if (isString(body)) bodyText.setText(body);
      if (!view.preserveScroll) {
        scrollView.scrollToStart();
        statsTop = 0;
      }
      tui.requestRender();
    };

    const controller = createTabController({
      load: (id, view, variant) => loadTabBody(ctx, thinkingLevel, id, view, variant),
      paint,
      loading: () => theme.fg("dim", "Loading…"),
      failure: (id, message) => theme.fg("error", `Failed to load the ${id} tab: ${message}`),
    });

    let finished = false;
    let unregisterClose = (): void => {};
    const finish = (outcome?: string): void => {
      if (finished) return;
      finished = true;
      unregisterClose();
      panel?.dispose();
      panel = undefined;
      controller.dispose();
      done(outcome);
    };
    unregisterClose = registerDialogClose(() => finish());

    const closePanel = (): void => {
      if (!panel) return;
      rememberedSection = panel.getActiveSection();
      rememberedFocusId = undefined;
      rememberedOpenSubmenu = false;
      panel.dispose();
      panel = undefined;
    };

    const openPanel = (): void => {
      if (panel || !provider) return;
      const panelOptions: Parameters<PreferencesProvider["createPanel"]>[0] = {
        ctx,
        tui,
        theme,
        extraSections: buildPreferencesExtraSections(ctx),
        layout: PREFERENCES_LAYOUT,
        hiddenRows: PREFERENCES_HIDDEN_ROWS,
        onOutcome: (outcome) => {
          finish(outcome === "close" ? undefined : outcome);
        },
      };
      if (rememberedSection !== undefined) panelOptions.initialSection = rememberedSection;
      if (rememberedFocusId !== undefined) panelOptions.initialFocusId = rememberedFocusId;
      if (rememberedOpenSubmenu) panelOptions.openInitialSubmenu = true;
      rememberedOpenSubmenu = false;
      panel = provider.createPanel(panelOptions);
      rememberedFocusId = undefined;
    };

    const activate = (id: StatusTabId): void => {
      if (active === id) return;
      if (active === "preferences") closePanel();
      active = id;
      if (id === "preferences") openPanel();
      else controller.activate(id, expanded, variantOf(id));
      tui.requestRender();
    };

    /** r / p on the Statistics tab: re-query the tab in its new period or scope. */
    const changeStatsView = (next: StatsSelection): void => {
      statsView = next;
      controller.activate("stats", expanded, variantOf("stats"));
      tui.requestRender();
    };

    /** Ctrl+O on a text tab; the view choice is shared by every tab that has one. */
    const toggleExpanded = (): void => {
      if (!isExpandableTab(active) || active === "preferences") return;
      expanded = !expanded;
      controller.activate(active, expanded, variantOf(active));
      tui.requestRender();
    };

    const switchTab = (delta: -1 | 1): void => {
      const index = STATUS_TABS.findIndex((tab) => tab.id === active);
      const next = STATUS_TABS[(index + delta + STATUS_TABS.length) % STATUS_TABS.length];
      activate(next.id);
    };

    /** True when the key is a digit naming one of the tabs. */
    const tabDigit = (data: string): number | undefined => {
      const index = Number(data) - 1;
      return data.length === 1 && Number.isInteger(index) && STATUS_TABS[index] !== undefined
        ? index
        : undefined;
    };

    const jumpToTab = (index: number): void => {
      const tab = STATUS_TABS[index];
      if (tab) activate(tab.id);
    };

    if (initial === "preferences") openPanel();
    else controller.activate(initial, expanded, variantOf(initial));

    return {
      render: (width: number) => {
        if (active === "preferences") {
          const rows = [truncateToWidth(header(), width), ""];
          if (panel) rows.push(...panel.render(width));
          else
            rows.push(
              truncateToWidth(
                theme.fg(
                  "dim",
                  "The choco-pi-ui package is not loaded; Preferences is unavailable.",
                ),
                width,
              ),
            );
          rows.push("", truncateToWidth(panelHint(), width));
          return rows;
        }
        return scrollView.render(width);
      },
      invalidate: () => {
        controller.invalidate();
        scrollView.invalidate();
        panel?.invalidate();
      },
      dispose: () => {
        panel?.dispose();
        controller.dispose();
      },
      handleInput: (data: string) => {
        if (finished) return;
        if (active === "usage" && data === "r") {
          finish("usage:reset-codex");
          return;
        }
        if (active === "stats" && data === "r") {
          changeStatsView({ ...statsView, period: nextPeriod(statsView.period) });
          return;
        }
        if (active === "stats" && data === "p") {
          changeStatsView({ ...statsView, scope: toggleScope(statsView.scope) });
          return;
        }
        // A panel submenu, such as the model picker, needs every key it can
        // get: no tab switching or digit jumps while one is open. The same is
        // true of the panel's search field.
        if (active === "preferences" && (panel?.hasOpenSubmenu?.() || panel?.hasActiveSearch?.())) {
          panel.handleInput(data);
          return;
        }
        const digit = tabDigit(data);
        if (digit !== undefined) {
          jumpToTab(digit);
          return;
        }
        // Tab owns tab switching everywhere, so the panel keeps ←/→ for its
        // own sections and never sees these two keys.
        if (matchesKey(data, "tab")) {
          switchTab(1);
          return;
        }
        if (matchesKey(data, "shift+tab")) {
          switchTab(-1);
          return;
        }
        if (matchesKey(data, "ctrl+o")) {
          toggleExpanded();
          return;
        }
        if (active === "preferences") {
          if (panel) {
            panel.handleInput(data);
            return;
          }
          if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
            finish(undefined);
          }
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          finish(undefined);
        } else if (active === "stats") {
          const page = Math.max(1, (statsWindow?.height ?? 1) - 1);
          if (matchesKey(data, "up")) scrollStats(-1);
          else if (matchesKey(data, "down")) scrollStats(1);
          else if (matchesKey(data, "pageUp")) scrollStats(-page);
          else if (matchesKey(data, "pageDown")) scrollStats(page);
          else if (matchesKey(data, "home")) scrollStats(-Infinity);
          else if (matchesKey(data, "end")) scrollStats(Infinity);
        } else if (matchesKey(data, "up")) {
          scrollView.scrollBy(-1);
          tui.requestRender();
        } else if (matchesKey(data, "down")) {
          scrollView.scrollBy(1);
          tui.requestRender();
        } else if (matchesKey(data, "pageUp")) {
          scrollView.scrollBy(-Math.max(1, scrollView.viewportHeight - 1));
          tui.requestRender();
        } else if (matchesKey(data, "pageDown")) {
          scrollView.scrollBy(Math.max(1, scrollView.viewportHeight - 1));
          tui.requestRender();
        }
      },
    };
  });
}

async function showTab(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  initial: StatusTabId,
  initialFocus: PreferencesFocus = {},
  initialExpanded = false,
): Promise<void> {
  let focus = initialFocus;
  let startTab = initial;
  let current = true;
  const unregister = registerDialogClose(() => {
    current = false;
  });
  try {
    for (;;) {
      const outcome = await showTabOnce(ctx, thinkingLevel, startTab, focus, initialExpanded);
      if (!current) return;
      focus = {};
      if (outcome === undefined) return;
      if (outcome === "usage:reset-codex") {
        try {
          const message = await resetCodexUsage(ctx, () => current);
          if (!current) return;
          if (message) ctx.ui.notify(message, "info");
        } catch (error) {
          if (!current) return;
          if (error instanceof CodexResetError) ctx.ui.notify(error.message, "error");
          else {
            rethrowUnlessStaleContext(error);
            return;
          }
        }
        startTab = "usage";
        continue;
      }
      startTab = "preferences";
      if (outcome.startsWith(AGENT_OUTCOME_PREFIX)) {
        focus = await runAgentPreferencesOutcome(outcome, ctx);
        if (!current) return;
        continue;
      }
      if (outcome.startsWith(CODEX_OUTCOME_PREFIX)) {
        const codex = getCodexPreferencesProvider();
        if (!codex) return;
        const handled = await codex.runOutcome(outcome, ctx);
        if (!current) return;
        if (handled === undefined) return;
        focus = handled;
        continue;
      }
      const provider = getPreferencesProvider();
      if (!provider) return;
      const handled = await provider.runOutcome(outcome, ctx);
      if (!current) return;
      if (handled === undefined) return;
      focus = handled;
    }
  } finally {
    unregister();
  }
}

export default function statusCommands(pi: ExtensionAPI): void {
  const sources = createProcessSources();
  // The inventory slot is process-global and holds this load's whole `pi`. A
  // subagent child would leave the main session's reports reading a runtime
  // that is disposed when the child ends, and pin it until the next load.
  if (!sources.inChildLoad()) setToolInventory(pi);
  registerReportAutoPublish(pi, {
    host: process.env.CHOCO_PI_HOST,
    inChildLoad: sources.inChildLoad(),
    isChildSession: (sessionId) => sources.isChildSession(sessionId),
  });
  pi.on("session_start", closeOpenDialogs);
  pi.on("session_shutdown", closeOpenDialogs);
  pi.registerCommand("status", {
    description:
      "Show session info, cost, model, context, MCP, and environment (Status/Context/Usage/Statistics tabs)",
    handler: async (_args, ctx) => showTab(ctx, pi.getThinkingLevel(), "status"),
  });
  overrideSessionCommand();
  const usageCommand = {
    description:
      "Show connected Claude, ChatGPT, and Synthetic usage (Status/Context/Usage/Statistics tabs)",
    handler: async (_args: string, ctx: ExtensionCommandContext) =>
      showTab(ctx, pi.getThinkingLevel(), "usage"),
  };
  pi.registerCommand("usage", usageCommand);
  pi.registerCommand("quota", usageCommand);

  const preferencesCommand = {
    description: "Adjust choco-ui and agent preferences (Preferences tab of /status)",
    getArgumentCompletions: (prefix: string) => {
      const agent = agentPreferencesCompletions(prefix);
      if (agent.length > 0) return agent;
      const fromPanel = getPreferencesProvider()?.completions(prefix);
      return Array.isArray(fromPanel) && fromPanel.length > 0 ? fromPanel : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const text = isString(args) ? args : "";
      if (ctx.mode !== "tui") {
        preferencesSummary(ctx);
        return;
      }
      let focus: PreferencesFocus = {};
      const agentResolution = resolveAgentPreferencesArgs(text, ctx);
      if (agentResolution) {
        if (!agentResolution.open) return;
        if (agentResolution.section !== undefined) focus.section = agentResolution.section;
        if (agentResolution.focusId !== undefined) focus.focusId = agentResolution.focusId;
      } else {
        const provider = getPreferencesProvider();
        if (!provider) {
          ctx.ui.notify(
            text.trim()
              ? PREFERENCES_USAGE
              : "The choco-pi-ui package is not loaded; Preferences is unavailable.",
            "warning",
          );
          return;
        }
        const resolved = await provider.resolveArgs(text, ctx);
        if (resolved === undefined) {
          ctx.ui.notify(PREFERENCES_USAGE, "warning");
          return;
        }
        if (!resolved.open) return;
        if (resolved.section !== undefined) focus.section = resolved.section;
        if (resolved.focusId !== undefined) focus.focusId = resolved.focusId;
      }
      await showTab(ctx, pi.getThinkingLevel(), "preferences", focus);
    },
  };
  pi.registerCommand("preferences", preferencesCommand);
  pi.registerCommand("pref", preferencesCommand);

  // Pi dispatches `/settings` itself, before extension commands, so the only way
  // to make it open this dialog is to take over the menu it would have shown.
  // The opener is process-global and outlives this load, so it reads everything
  // from the live host and never touches this load's `pi`.
  installNativeSettingsBridge(
    (host: NativeSettingsHost, focus?: NativeSettingsFocus) => {
      const hostCtx = createHostCommandContext(host);
      const thinkingLevel = hostThinkingLevel(host);
      // Without the panel package the dialog has no Preferences tab to show, so
      // `/settings` keeps opening Pi's own menu instead of reporting nothing.
      if (hostCtx === undefined || thinkingLevel === undefined || !getPreferencesProvider()) {
        openNativeSettingsMenu(host);
        return;
      }
      // SAFETY: the host builds this context for its own command dispatch.
      const ctx = hostCtx as ExtensionCommandContext;
      void showTab(ctx, thinkingLevel, "preferences", focus ?? {}).catch((error: RuntimeValue) => {
        if (isStaleContextError(error)) return;
        ctx.ui.notify(
          `Could not open settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
    },
    { inChildLoad: sources.inChildLoad() },
  );
}

/** Pi's interactive mode, reached only to retire its built-in `/session` command. */
type SessionCommandHost = {
  handleSessionCommand: () => void;
  run: () => Promise<void>;
  session: Pick<AgentSession, "cacheWarmingStatus"> & { prompt: (text: string) => Promise<void> };
  settingsManager: { getCacheWarmingMode(): CacheWarmingMode };
  __chocoPiSessionCommandApplied?: boolean;
};

/**
 * Retires Pi's built-in `/session` by pointing it at this dialog.
 *
 * Interactive mode matches `/session` by literal string and calls its own
 * handler before any extension command is consulted, so an extension of that
 * name could never take the word. Replacing the handler is what makes `/status`
 * the single session command while `/session` keeps working for anyone who
 * still types it; `command-filter.ts` drops it from the editor's completions so
 * only one of the two is offered.
 */
function overrideSessionCommand(): void {
  const prototype = reinterpretHostValue<SessionCommandHost>(InteractiveMode.prototype);
  if (prototype.__chocoPiSessionCommandApplied) return;
  const run = prototype.run;
  prototype.run = function captureStatusHost(this: SessionCommandHost): Promise<void> {
    // SAFETY: `run` is InteractiveMode's public entry point (interactive-mode.d.ts), and
    // AgentSession.cacheWarmingStatus / SettingsManager.getCacheWarmingMode are documented
    // SDK properties that InteractiveMode's own /session handler reads. Capturing here
    // records the live host once per interactive process, before any command is typed.
    setCacheWarmingSource(this);
    return run.call(this);
  };
  prototype.handleSessionCommand = function openStatusDialog(this: SessionCommandHost) {
    setCacheWarmingSource(this);
    void this.session.prompt("/status");
  };
  prototype.__chocoPiSessionCommandApplied = true;
}

/**
 * Opens the settings dialog on one row's picker. Commands such as `/effort` use
 * this so a bare invocation lands on the same picker the panel shows, instead
 * of a second one rendered over the editor.
 */
export async function openPreferencesPicker(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  focus: NativeSettingsFocus,
): Promise<boolean> {
  if (ctx.mode !== "tui" || !getPreferencesProvider()) return false;
  await showTab(ctx, thinkingLevel, "preferences", focus);
  return true;
}

/**
 * Opens the dialog on one of its text tabs. `/context` uses this so its report
 * is one tab of the status view instead of a second overlay of its own.
 */
export async function openStatusTab(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  tab: TextTabId,
  expanded = false,
): Promise<void> {
  await showTab(ctx, thinkingLevel, tab, {}, expanded);
}
