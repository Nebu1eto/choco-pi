import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { readProviderUsages, usageReport, type ProviderUsageReport } from "../../provider-usage.ts";
import {
  condenseStatusRows,
  formatCacheWarming,
  formatStatus,
  statusHeading,
  summarizeMcpServers,
  summarizeStatusRows,
  type StatusRow,
} from "../../session-status.ts";
import { buildContextReport, renderContext } from "../context-report.ts";
import { daybreakStatusValue, getDaybreakBridge } from "../daybreak-state.ts";
import { getFastModeBridge, isOpenAISubscriptionSignIn } from "../fast-mode-state.ts";
import { hostFramesEnabled } from "../host-bridge/bridge.ts";
import {
  REPORT_SCHEMA_VERSION,
  ReportFrameSchema,
  type ReportFrame,
  type ReportRow,
} from "../host-bridge/report-schema.ts";
import { REPORT_STATUS_KEY } from "../host-bridge/schema.ts";
import { isStaleContextError, rethrowUnlessStaleContext } from "../lifecycle.ts";
import type { RuntimeValue } from "../runtime-values.ts";
import {
  computeCacheWaste,
  formatSessionInfo,
  sessionInfoRows,
  summarizeMainUsage,
  summarizeSubagentUsage,
  type SessionInfoInput,
  type SessionInfoStyle,
} from "../session-usage.ts";
import {
  DEFAULT_PERIOD,
  DEFAULT_SCOPE,
  isPeriod,
  type StatsSelection,
} from "../stats/aggregate.ts";
import { DEFAULT_STATS_SECTION, isStatsSection, type StatsSection } from "../stats/format.ts";
import { registryModelNames, registryPriceLookup, statsBody } from "../stats/report.ts";
import { hasRunningSubagents } from "../subagent-manager.ts";
import { hasUsageWindows, usageReportFrame } from "../usage-report.ts";
import {
  currentCacheWarming,
  getLatestPromptOptions,
  getToolInventory,
  registeredMcpNames,
  setLatestPromptOptions,
  statsRoots,
} from "./host-state.ts";
import type { TabLoad, TextTabId } from "./tabs.ts";

const SESSION_INFO_ROWS: ReadonlySet<string> = new Set([
  "Session name",
  "Session ID",
  "Session file",
]);

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

function fastStatusValue(ctx: ExtensionCommandContext, sessionId: string): string {
  const decision = getFastModeBridge().get(sessionId)?.decide(ctx.model, ctx.modelRegistry);
  if (!decision) return "not initialized";
  if (!decision.requested) return "off";
  if (decision.reason !== undefined) return `on (saved; ${decision.reason})`;
  return decision.supported ? "on" : "on (saved; inactive for this model)";
}

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

function reportRow(row: StatusRow): ReportRow {
  const [value = "", ...rest] = row.value.split("\n");
  const hint = rest
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return hint.length > 0 ? { label: row.label, value, hint } : { label: row.label, value };
}

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
      {
        title: "Environment",
        rows: environmentRows(ctx, thinkingLevel, mcpLabel).map(reportRow),
      },
    ],
  };
}

const isReportFrame = compile(ReportFrameSchema).check;

function publishReport(ui: Pick<ExtensionContext["ui"], "setStatus">, frame: ReportFrame): void {
  const kind = frame.kind;
  if (!isReportFrame(frame)) {
    throw new Error(`status-commands produced an invalid ${kind} report frame`);
  }
  ui.setStatus(REPORT_STATUS_KEY, JSON.stringify(frame));
}

export function reportThenNotify(
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
  ctx.ui.notify(stripVTControlCharacters(body), "info");
  if (failure) rethrowUnlessStaleContext(failure.error);
}

export const REPORT_DEBOUNCE_MS = 500;
export const USAGE_REPORT_INTERVAL_MS = 10 * 60_000;

type ReportApi = Pick<ExtensionAPI, "on" | "getAllTools" | "getActiveTools"> &
  Partial<Pick<ExtensionAPI, "getMcpServers">>;

export interface ReportAutoPublishOptions {
  host: string | undefined;
  inChildLoad?: boolean;
  isChildSession?: (sessionId: string) => boolean;
  setTimer?: (callback: () => void, ms: number) => () => void;
  readUsage?: (ctx: ExtensionContext) => Promise<ProviderUsageReport>;
  now?: () => number;
  warn?: (message: string) => void;
}

function defaultTimer(callback: () => void, ms: number): () => void {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return () => clearTimeout(handle);
}

export function registerReportAutoPublish(pi: ReportApi, options: ReportAutoPublishOptions): void {
  if (options.inChildLoad === true) return;
  const setTimer = options.setTimer ?? defaultTimer;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const readUsage = options.readUsage ?? readProviderUsages;
  const now = options.now ?? Date.now;
  let generation = 0;
  let cancel: (() => void) | undefined;
  let lastKey: string | undefined;
  let usageDue = false;
  let lastUsageQuery: number | undefined;
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
      const source = getLatestPromptOptions();
      if (source?.sessionId !== sessionId) return;
      const frame = buildContextReport(pi, ctx, source.read());
      const key = JSON.stringify({ ...frame, at: "" });
      if (key === lastKey) return;
      publishReport(ctx.ui, frame);
      lastKey = key;
    } catch (error) {
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
      setLatestPromptOptions({ sessionId, read: () => promptOptions });
    } catch (error) {
      rethrowUnlessStaleContext(error);
    }
  });
  pi.on("turn_end", (_event, ctx) => schedule(ctx, true));
  pi.on("model_select", (_event, ctx) => schedule(ctx));
}

export function contextBody(
  ctx: ExtensionCommandContext,
  expanded: boolean,
  styled: boolean,
): string {
  const inventory = getToolInventory();
  if (!inventory) return "The context report is unavailable in this session.";
  const body = renderContext(inventory, ctx, expanded, styled);
  if (!styled) return body;
  const heading = ctx.ui.theme.bold(ctx.ui.theme.fg("accent", "Context Usage"));
  return body.replace(/^Context Usage/, () => heading);
}

export type StatsTabView = StatsSelection & { section: StatsSection };

export function statsViewOf(variant: string): StatsTabView {
  const [period = "", scope, section = ""] = variant.split(":");
  return {
    period: isPeriod(period) ? period : DEFAULT_PERIOD,
    scope: scope === "project" ? scope : DEFAULT_SCOPE,
    section: isStatsSection(section) ? section : DEFAULT_STATS_SECTION,
  };
}

export function statsDataKey(view: StatsSelection): string {
  return `${view.period}:${view.scope}`;
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
      roots: statsRoots(),
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

export function loadTabBody(
  ctx: ExtensionCommandContext,
  thinkingLevel: string,
  id: TextTabId,
  expanded: boolean,
  variant: string,
): TabLoad {
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
