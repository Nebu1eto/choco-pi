/** Unified above-editor fleet panel for orchestrator, agents, and owned shells. */

import {
  isKeyRelease,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hasAgentBadge } from "../agent-color.ts";
import type { AgentManager } from "../agent-manager.ts";
import type { AgentRecord, WidgetMode } from "../types.ts";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.ts";
import { buildAgentTree, type AgentTreeRow } from "./agent-tree.ts";
import {
  describeActivity,
  formatRowSessionTokens,
  renderAgentTreeLabel,
  SPINNER,
  type AgentActivity,
  type Theme,
} from "./agent-widget.ts";
import type {
  ShellSectionProvider,
  ShellSectionRow,
  ShellViewerHost,
} from "./shell-section-contract.ts";
import type { ViewerKeybindings } from "./viewer-keys.ts";

export const MAX_PANEL_LINES = 12;
const MAX_AGENT_ROWS = 5;
const MAX_SHELL_ROWS = 3;
const TICK_MS = 100;
const FINISHED_LINGER_MS = 4_000;
const ERROR_LINGER_TURNS = 2;

export type FleetPanelFocusOptions = {
  focusAgent?: (record: AgentRecord, tui: TUI, theme: Theme) => boolean;
  focusedAgentId?: () => string | undefined;
  unfocusAgent?: () => void;
  openSideConversation?: (record: AgentRecord) => boolean;
};

export type FleetPanelUICtx = ShellViewerHost & {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content:
      | undefined
      | ((
          tui: TUI,
          theme: Theme,
        ) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: ViewerKeybindings | undefined,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
};

type RowKey = "main" | `agent:${string}` | `shell:${string}`;
type MainEntry = { kind: "main"; key: "main" };
type AgentEntry = {
  kind: "agent";
  key: `agent:${string}`;
  record: AgentRecord;
  depth: number;
};
type ShellEntry = { kind: "shell"; key: `shell:${string}`; shell: ShellSectionRow };
type FleetEntry = MainEntry | AgentEntry | ShellEntry;
type FocusedComponentBoundary = {} | null | undefined;

interface FocusedEditorProbe {
  getText?: FocusedComponentBoundary;
  setText?: FocusedComponentBoundary;
  handleInput?: FocusedComponentBoundary;
}

interface WindowedRows<T> {
  rows: readonly T[];
  start: number;
  hiddenBelow: number;
}

function focusedEditorProbe(value: FocusedComponentBoundary): FocusedEditorProbe | undefined {
  if (
    value === null ||
    Object(value) !== value ||
    Array.isArray(value) ||
    value instanceof Function
  ) {
    return undefined;
  }
  // SAFETY: The guard admits only a non-array, non-callable host object;
  // each probed method is independently checked before use.
  return value as FocusedEditorProbe;
}

/** Integer elapsed seconds used by compact fleet rows. */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1_000))}s`;
}

/** Compact token total used by compact fleet rows. */
export function formatFleetTokens(count: number): string {
  if (count >= 1_000_000) return `↓ ${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `↓ ${(count / 1_000).toFixed(1)}k`;
  return `↓ ${count}`;
}

/** Keep right-hand stats visible while truncating the descriptive left side. */
export function rightAlign(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);
  const leftMax = width - rightWidth - 1;
  const clippedLeft = truncateToWidth(left, leftMax);
  const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
  return clippedLeft + " ".repeat(gap) + right;
}

function sanitizeStopError(raw: string): string {
  let sanitized = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code === 27 && raw[index + 1] === "[") {
      index += 2;
      while (index < raw.length && raw.charCodeAt(index) < 64) index++;
      continue;
    }
    if (code === 27 && raw[index + 1] === "]") {
      index += 2;
      while (index < raw.length && raw.charCodeAt(index) !== 7) index++;
      continue;
    }
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    sanitized += raw[index];
  }
  const clean = sanitized.trim();
  if (clean.length <= 60) return clean;
  return `${clean.slice(0, 59)}…`;
}

function windowRows<T>(rows: readonly T[], limit: number, selected: number): WindowedRows<T> {
  if (rows.length === 0) return { rows: [], start: 0, hiddenBelow: 0 };
  const visible = Math.min(limit, rows.length);
  const boundedSelection = Math.max(0, Math.min(rows.length - 1, selected));
  const start = boundedSelection < visible ? 0 : boundedSelection - visible + 1;
  return {
    rows: rows.slice(start, start + visible),
    start,
    hiddenBelow: rows.length - start - visible,
  };
}

function windowLineCount<T>(window: WindowedRows<T>): number {
  return window.rows.length + (window.start > 0 ? 1 : 0) + (window.hiddenBelow > 0 ? 1 : 0);
}

export class FleetPanel {
  private ui: FleetPanelUICtx | undefined;
  private tui: TUI | undefined;
  private theme: Theme | undefined;
  private inputUnsub: (() => void) | undefined;
  private shellUnsub: (() => void) | undefined;
  private shellProvider: ShellSectionProvider | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private active = false;
  private agentSectionEnabled = true;
  private selectedKey: RowKey = "main";
  private lastIndex = 0;
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  private viewingShellId: string | undefined;
  private readonly pendingStop = new Set<string>();
  private readonly stopErrors = new Map<string, string>();
  private readonly finishedTurnAge = new Map<string, number>();
  private lastStatusText: string | undefined;
  private disposed = false;
  private generation = 0;
  private readonly manager: AgentManager;
  private readonly agentActivity: Map<string, AgentActivity>;
  private readonly focusOptions: FleetPanelFocusOptions;
  private readonly widgetMode: () => WidgetMode;

  constructor(
    manager: AgentManager,
    agentActivity: Map<string, AgentActivity>,
    focusOptions: FleetPanelFocusOptions,
    extras: { widgetMode: () => WidgetMode },
  ) {
    this.manager = manager;
    this.agentActivity = agentActivity;
    this.focusOptions = focusOptions;
    this.widgetMode = extras.widgetMode;
  }

  setUICtx(ui: FleetPanelUICtx): void {
    if (this.disposed || ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.theme = undefined;
    this.lastStatusText = undefined;
    this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
  }

  setAgentSectionEnabled(enabled: boolean): void {
    if (enabled === this.agentSectionEnabled) return;
    this.agentSectionEnabled = enabled;
    if (!enabled && this.selectedKey.startsWith("agent:")) {
      this.selectedKey = "main";
      this.lastIndex = 0;
      this.unfocusAgent();
    }
    this.update();
  }

  setShellSection(provider: ShellSectionProvider | undefined): void {
    if (provider === this.shellProvider) return;
    this.shellUnsub?.();
    this.shellUnsub = undefined;
    this.shellProvider = provider;
    this.pendingStop.clear();
    this.stopErrors.clear();
    if (provider) this.shellUnsub = provider.onChange(() => this.update());
    this.update();
  }

  ensureTimer(): void {
    if (this.timer || !this.hasManagedRows()) return;
    this.timer = setInterval(() => this.update(), TICK_MS);
    this.timer.unref();
  }

  update(): void {
    if (this.disposed || !this.ui) return;
    const roster = this.roster();
    const managedCount = roster.length - 1;
    this.pruneShellState(roster);
    this.updateStatus();

    if (this.agentRows().length === 0) this.unfocusAgent();

    if (managedCount === 0) {
      this.active = false;
      this.selectedKey = "main";
      this.lastIndex = 0;
      this.stopTimer();
      if (this.widgetRegistered) {
        this.ui.setWidget("fleet", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
        this.theme = undefined;
      }
      return;
    }

    this.clampSelection(roster);
    this.ensureTimer();
    this.frame++;
    if (!this.widgetRegistered) {
      this.ui.setWidget(
        "fleet",
        (tui, theme) => {
          this.tui = tui;
          this.theme = theme;
          return {
            render: (width: number) => this.renderPanel(width, theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
              this.theme = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  onTurnStart(): void {
    const recordIds = new Set(this.manager.listAgents().map((record) => record.id));
    for (const [id, age] of this.finishedTurnAge) {
      if (recordIds.has(id)) this.finishedTurnAge.set(id, age + 1);
      else this.finishedTurnAge.delete(id);
    }
    this.update();
  }

  markFinished(id: string): void {
    if (!this.finishedTurnAge.has(id)) this.finishedTurnAge.set(id, 0);
  }

  markRunning(id: string): void {
    this.finishedTurnAge.delete(id);
  }

  onAgentFinished(_id: string): void {
    this.update();
  }

  hasAgentRows(): boolean {
    return this.agentRows().length > 0;
  }

  isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.stopTimer();
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.shellUnsub?.();
    this.shellUnsub = undefined;
    const close = this.viewerClose;
    this.viewerClose = undefined;
    close?.();
    this.viewingAgentId = undefined;
    this.viewingShellId = undefined;
    this.pendingStop.clear();
    this.stopErrors.clear();
    if (this.ui) {
      this.ui.setWidget("fleet", undefined);
      this.ui.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.lastStatusText = undefined;
    this.tui = undefined;
    this.theme = undefined;
    this.active = false;
    this.ui = undefined;
  }

  private agentRows(): AgentTreeRow<AgentRecord>[] {
    if (!this.agentSectionEnabled) return [];
    const now = Date.now();
    const focusedId = this.focusOptions.focusedAgentId?.();
    const records = this.manager.listAgents();
    const byId = new Map(records.map((record) => [record.id, record]));
    const visibleIds = new Set(
      records
        .filter((record) => {
          if (
            record.status === "running" ||
            record.status === "queued" ||
            record.id === this.viewingAgentId ||
            record.id === focusedId
          ) {
            return true;
          }
          if (record.completedAt === undefined) return false;
          const age = this.finishedTurnAge.get(record.id) ?? 0;
          const maxAge = record.status === "completed" ? 1 : ERROR_LINGER_TURNS;
          // Preserve both legacy surfaces: rows remain while either the widget's
          // turn-age window or the below-editor switcher's 4 s window is open.
          return now - record.completedAt < FINISHED_LINGER_MS || age < maxAge;
        })
        .map((record) => record.id),
    );
    for (const id of visibleIds) {
      let parentId = byId.get(id)?.parentAgentId;
      while (parentId !== undefined) {
        visibleIds.add(parentId);
        parentId = byId.get(parentId)?.parentAgentId;
      }
    }
    return buildAgentTree(records).filter(({ record }) => visibleIds.has(record.id));
  }

  private shellRows(): readonly ShellSectionRow[] {
    return this.shellProvider?.rows(Date.now()) ?? [];
  }

  private roster(): FleetEntry[] {
    return [
      { kind: "main", key: "main" },
      ...this.agentRows().map(({ record, depth }): AgentEntry => ({
        kind: "agent",
        key: `agent:${record.id}`,
        record,
        depth,
      })),
      ...this.shellRows().map((shell): ShellEntry => ({
        kind: "shell",
        key: `shell:${shell.shellId}`,
        shell,
      })),
    ];
  }

  private hasManagedRows(): boolean {
    return this.agentRows().length + this.shellRows().length > 0;
  }

  private clampSelection(roster = this.roster()): void {
    const focusedId = this.focusOptions.focusedAgentId?.();
    if (focusedId) {
      const focused = roster.findIndex((entry) => entry.key === `agent:${focusedId}`);
      if (focused >= 0) {
        this.lastIndex = focused;
        this.selectedKey = roster[focused].key;
        return;
      }
    }
    const keyed = roster.findIndex((entry) => entry.key === this.selectedKey);
    if (keyed >= 0) {
      this.lastIndex = keyed;
      return;
    }
    this.lastIndex = Math.min(this.lastIndex, roster.length - 1);
    this.selectedKey = roster[this.lastIndex]?.key ?? "main";
  }

  private selectedEntry(roster = this.roster()): FleetEntry | undefined {
    return roster.find((entry) => entry.key === this.selectedKey);
  }

  private handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.disposed || !this.ui || isKeyRelease(data) || this.viewerClose) return undefined;
    if (!this.editorHasFocus()) {
      this.deactivate();
      return undefined;
    }
    const roster = this.roster();
    if (roster.length === 1) {
      this.deactivate();
      return undefined;
    }
    this.clampSelection(roster);

    if (!this.active) {
      const down = matchesKey(data, "down");
      const left = matchesKey(data, "left");
      const canActivate = down || (left && roster.some((entry) => entry.kind === "agent"));
      if (canActivate && this.ui.getEditorText() === "") {
        this.active = true;
        if (!this.focusOptions.focusedAgentId?.()) {
          this.selectedKey = "main";
          this.lastIndex = 0;
        }
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    if (matchesKey(data, "down") || matchesKey(data, "up")) {
      const delta = matchesKey(data, "down") ? 1 : -1;
      const current = roster.findIndex((entry) => entry.key === this.selectedKey);
      if (delta < 0 && current === 0) {
        this.deactivate();
        return { consume: true };
      }
      this.lastIndex = Math.max(0, Math.min(roster.length - 1, current + delta));
      this.selectedKey = roster[this.lastIndex].key;
      this.applySelection(roster);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "right")) {
      const shell = roster.find((entry) => entry.kind === "shell");
      if (shell) {
        this.selectedKey = shell.key;
        this.lastIndex = roster.indexOf(shell);
        this.applySelection(roster);
        this.update();
      }
      return { consume: true };
    }
    if (matchesKey(data, "left")) {
      const agent = roster.find((entry) => entry.kind === "agent");
      if (agent) {
        this.selectedKey = agent.key;
        this.lastIndex = roster.indexOf(agent);
        this.applySelection(roster);
        this.update();
      }
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.acceptSelection(roster);
      return { consume: true };
    }
    if (matchesKey(data, "f")) {
      this.focusSelected(roster);
      return { consume: true };
    }
    if (matchesKey(data, "x")) {
      const entry = this.selectedEntry(roster);
      if (entry?.kind === "shell") void this.stopSelected(entry.shell);
      return { consume: true };
    }
    this.deactivate();
    return undefined;
  }

  private editorHasFocus(): boolean {
    if (this.tui?.hasOverlay?.() === true) return false;
    // SAFETY: Pi's TUI owns this optional private field for focus routing.
    const focused = (this.tui as { focusedComponent?: FocusedComponentBoundary } | undefined)
      ?.focusedComponent;
    if (focused == null) return true;
    const candidate = focusedEditorProbe(focused);
    return (
      candidate !== undefined &&
      candidate.getText instanceof Function &&
      candidate.setText instanceof Function &&
      candidate.handleInput instanceof Function
    );
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.stopErrors.clear();
    if (!this.focusOptions.focusedAgentId?.()) {
      this.selectedKey = "main";
      this.lastIndex = 0;
    }
    this.update();
  }

  private applySelection(roster = this.roster()): void {
    const entry = this.selectedEntry(roster);
    if (
      !entry ||
      entry.kind === "main" ||
      entry.kind === "shell" ||
      entry.record.sideConversation
    ) {
      this.unfocusAgent();
      return;
    }
    if (this.focusOptions.focusedAgentId?.() === entry.record.id) return;
    if (!entry.record.session || !this.tui || !this.theme || !this.focusOptions.focusAgent) {
      this.unfocusAgent();
      return;
    }
    if (!this.focusOptions.focusAgent(entry.record, this.tui, this.theme)) this.unfocusAgent();
  }

  private unfocusAgent(): void {
    if (this.focusOptions.focusedAgentId?.()) this.focusOptions.unfocusAgent?.();
  }

  private focusSelected(roster: FleetEntry[]): void {
    if (!this.agentSectionEnabled) return;
    const entry = this.selectedEntry(roster);
    if (!entry || entry.kind !== "agent" || entry.record.sideConversation) return;
    if (!entry.record.session || !this.tui || !this.theme || !this.focusOptions.focusAgent) {
      this.ui?.notify(`Agent is ${entry.record.status} — fullscreen focus is unavailable.`, "info");
      return;
    }
    this.focusOptions.focusAgent(entry.record, this.tui, this.theme);
    this.update();
  }

  private acceptSelection(roster: FleetEntry[]): void {
    const entry = this.selectedEntry(roster);
    if (!entry || entry.kind === "main") {
      this.applySelection(roster);
      this.deactivate();
      return;
    }
    if (entry.kind === "shell") {
      this.openShell(entry.shell.shellId);
      return;
    }
    if (entry.record.sideConversation) {
      if (this.focusOptions.openSideConversation?.(entry.record)) {
        this.active = false;
        this.update();
      } else {
        this.ui?.notify(`Agent is ${entry.record.status} — no session available.`, "info");
      }
      return;
    }
    this.applySelection(roster);
    this.deactivate();
  }

  private openShell(shellId: string): void {
    const provider = this.shellProvider;
    const ui = this.ui;
    if (!provider || !ui) return;
    this.viewingShellId = shellId;
    const generation = this.generation;
    void (async () => {
      try {
        await provider.openViewer(shellId, ui, (close) => {
          if (this.generation === generation && !this.disposed) this.viewerClose = close;
        });
        this.clearViewer(generation);
      } catch (error) {
        this.clearViewer(generation);
        if (this.disposed || generation !== this.generation) return;
        const message = sanitizeStopError(
          error instanceof Error ? error.message : "Shell viewer failed.",
        );
        ui.notify(message || "Shell viewer failed.", "error");
      }
    })();
  }

  private clearViewer(generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    const key: RowKey | undefined = this.viewingAgentId
      ? `agent:${this.viewingAgentId}`
      : this.viewingShellId
        ? `shell:${this.viewingShellId}`
        : undefined;
    if (key && this.roster().some((entry) => entry.key === key)) this.selectedKey = key;
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingShellId = undefined;
    this.update();
  }

  private async stopSelected(shell: ShellSectionRow): Promise<void> {
    const provider = this.shellProvider;
    const ui = this.ui;
    const generation = this.generation;
    if (!provider || !ui || this.disposed) return;
    if (shell.state !== "running") {
      ui.notify("Shell already settled; nothing to stop.", "info");
      return;
    }
    if (this.pendingStop.has(shell.shellId)) return;
    this.pendingStop.add(shell.shellId);
    this.stopErrors.delete(shell.shellId);
    this.update();
    try {
      await provider.stop(shell.shellId);
      if (this.disposed || generation !== this.generation) return;
      this.pendingStop.delete(shell.shellId);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.pendingStop.delete(shell.shellId);
      const message = sanitizeStopError(
        error instanceof Error ? error.message : "Shell stop failed.",
      );
      this.stopErrors.set(shell.shellId, message);
      ui.notify(message, "error");
    }
    if (!this.disposed && generation === this.generation) this.update();
  }

  private pruneShellState(roster: FleetEntry[]): void {
    const shellIds = new Set(
      roster
        .filter((entry): entry is ShellEntry => entry.kind === "shell")
        .map(({ shell }) => shell.shellId),
    );
    for (const id of this.pendingStop) if (!shellIds.has(id)) this.pendingStop.delete(id);
    for (const id of this.stopErrors.keys()) if (!shellIds.has(id)) this.stopErrors.delete(id);
  }

  private updateStatus(): void {
    if (!this.ui) return;
    const records = this.manager.listAgents();
    const hasActive = records.some(
      (record) => record.status === "running" || record.status === "queued",
    );
    let text: string | undefined;
    if (hasActive) {
      const scheduled = this.manager.getScheduledActiveCount();
      const tree = this.manager.getActiveCount();
      const cap = this.manager.getMaxConcurrent();
      text = `${scheduled} scheduled / cap ${cap === 0 ? "unlimited" : cap}${tree === scheduled ? "" : ` · ${tree} in tree`}`;
    }
    if (text !== this.lastStatusText) {
      this.ui.setStatus("subagents", text);
      this.lastStatusText = text;
    }
  }

  private renderPanel(width: number, theme: Theme): string[] {
    const roster = this.roster();
    if (roster.length === 1) return [];
    this.clampSelection(roster);
    const selectedIndex = roster.findIndex((entry) => entry.key === this.selectedKey);
    const agents = roster.filter((entry): entry is AgentEntry => entry.kind === "agent");
    const shells = roster.filter((entry): entry is ShellEntry => entry.kind === "shell");
    const selectedAgent = Math.max(
      0,
      agents.findIndex((entry) => entry.key === this.selectedKey),
    );
    const selectedShell = Math.max(
      0,
      shells.findIndex((entry) => entry.key === this.selectedKey),
    );
    let agentLimit = Math.min(MAX_AGENT_ROWS, agents.length);
    let shellLimit = Math.min(MAX_SHELL_ROWS, shells.length);
    let details = agents.some((entry) => this.showDetail(entry.record));

    const projected = (): number => {
      const aw = windowRows(agents, agentLimit, selectedAgent);
      const sw = windowRows(shells, shellLimit, selectedShell);
      const detailCount = details
        ? aw.rows.filter((entry) => this.showDetail(entry.record)).length
        : 0;
      return 2 + windowLineCount(aw) + windowLineCount(sw) + detailCount;
    };
    if (projected() > MAX_PANEL_LINES) details = false;
    while (projected() > MAX_PANEL_LINES && shellLimit > Math.min(1, shells.length)) shellLimit--;
    while (projected() > MAX_PANEL_LINES && agentLimit > Math.min(1, agents.length)) agentLimit--;

    const agentWindow = windowRows(agents, agentLimit, selectedAgent);
    const shellWindow = windowRows(shells, shellLimit, selectedShell);
    const lines = [truncateToWidth(theme.fg("dim", this.hint(roster)), width)];
    lines.push(this.renderMainRow(selectedIndex, width, theme));
    this.pushWindow(
      lines,
      agentWindow,
      width,
      theme,
      (entry) => this.renderAgentRow(entry, selectedIndex, width, theme),
      details ? (entry) => this.renderAgentDetail(entry, width, theme) : undefined,
    );
    this.pushWindow(lines, shellWindow, width, theme, (entry) =>
      this.renderShellRow(entry, selectedIndex, width, theme),
    );
    return lines.slice(0, MAX_PANEL_LINES);
  }

  private pushWindow<T>(
    lines: string[],
    window: WindowedRows<T>,
    width: number,
    theme: Theme,
    render: (row: T) => string,
    renderDetail?: (row: T) => string | undefined,
  ): void {
    if (window.start > 0)
      lines.push(rightAlign("", theme.fg("dim", `↑ ${window.start} more`), width));
    for (const row of window.rows) {
      lines.push(render(row));
      const detail = renderDetail?.(row);
      if (detail) lines.push(detail);
    }
    if (window.hiddenBelow > 0) {
      lines.push(rightAlign("", theme.fg("dim", `↓ ${window.hiddenBelow} more`), width));
    }
  }

  private hint(roster: FleetEntry[]): string {
    const selected = this.selectedEntry(roster);
    if (this.active) {
      if (!selected || selected.kind === "main") {
        return "↑↓ move · main returns to orchestrator · → shells · esc back";
      }
      if (selected.kind === "shell") {
        const suffix = this.pendingStop.has(selected.shell.shellId)
          ? " · stopping…"
          : this.stopErrors.has(selected.shell.shellId)
            ? ` · stop failed: ${this.stopErrors.get(selected.shell.shellId)}`
            : "";
        return `↑↓ move · enter output · x stop · ← agents · esc back${suffix}`;
      }
      if (selected.record.sideConversation) return "enter opens the [btw] overlay";
      return "↑↓ switch agent · f focus · esc back";
    }
    const focusedId = this.focusOptions.focusedAgentId?.();
    const focused = focusedId
      ? roster.find(
          (entry): entry is AgentEntry => entry.kind === "agent" && entry.record.id === focusedId,
        )
      : undefined;
    if (focused)
      return `prompt targets @${focused.record.alias ?? focused.record.type} · ↓ to switch agents · esc stays`;
    return this.hasAgentRows()
      ? "esc to interrupt · ← for agents · ↓ to manage"
      : "↓ to manage shells";
  }

  private renderMainRow(selectedIndex: number, width: number, theme: Theme): string {
    return truncateToWidth(`  ${this.bullet(0, selectedIndex, theme)} main`, width);
  }

  private renderAgentRow(
    entry: AgentEntry,
    selectedIndex: number,
    width: number,
    theme: Theme,
  ): string {
    const rosterIndex = this.roster().findIndex((row) => row.key === entry.key);
    const selected = rosterIndex === selectedIndex;
    const record = entry.record;
    const name = renderAgentTreeLabel(record, entry.depth, theme, {
      topLevel: selected
        ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
        : { fallbackColor: "muted" },
    });
    const treePrefix = entry.depth > 0 ? `${"  ".repeat(entry.depth - 1)}└ ` : "";
    const sideTag = record.sideConversation ? theme.fg("accent", "[btw] ") : "";
    const workflowTag = record.workflowStepId
      ? theme.fg("accent", `[wf:${record.workflowStepId}] `)
      : "";
    const errorText =
      record.status === "error" && record.error
        ? theme.fg("error", ` error: ${sanitizeStopError(record.error)}`)
        : "";
    const status =
      record.status === "running"
        ? theme.fg("accent", SPINNER[this.frame % SPINNER.length])
        : theme.fg("dim", `[${record.status}]`);
    const left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${treePrefix}${status} ${sideTag}${workflowTag}${name}  ${record.description}${errorText}`;
    const usage = this.agentActivity.get(record.id)?.lifetimeUsage ?? record.lifetimeUsage;
    const elapsed = (record.completedAt ?? Date.now()) - record.startedAt;
    const right = theme.fg(
      "dim",
      `${formatFleetElapsed(elapsed)} · ${formatFleetTokens(getLifetimeTotal(usage))}`,
    );
    return rightAlign(left, right, width);
  }

  private showDetail(record: AgentRecord): boolean {
    if (record.status !== "running") return false;
    const mode = this.widgetMode();
    return mode === "all" || (mode === "background" && record.isBackground !== false);
  }

  private renderAgentDetail(entry: AgentEntry, width: number, theme: Theme): string | undefined {
    if (!this.showDetail(entry.record)) return undefined;
    const activity = this.agentActivity.get(entry.record.id);
    const parts = [describeActivity(activity?.activeTools ?? new Map(), activity?.responseText)];
    const toolUses = activity?.toolUses ?? entry.record.toolUses;
    if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(activity?.lifetimeUsage ?? entry.record.lifetimeUsage);
    if (tokens > 0) {
      parts.push(
        formatRowSessionTokens(
          tokens,
          getSessionContextPercent(activity?.session),
          theme,
          entry.record.compactionCount,
        ),
      );
    }
    const indent = "  ".repeat(entry.depth);
    return truncateToWidth(theme.fg("dim", `      ${indent}⎿  ${parts.join(" · ")}`), width);
  }

  private renderShellRow(
    entry: ShellEntry,
    selectedIndex: number,
    width: number,
    theme: Theme,
  ): string {
    const rosterIndex = this.roster().findIndex((row) => row.key === entry.key);
    const shell = entry.shell;
    const status =
      shell.state === "running"
        ? theme.fg("accent", SPINNER[this.frame % SPINNER.length])
        : theme.fg("dim", `[${shell.state}]`);
    const owner = shell.ownerTag ? ` ${theme.fg("dim", shell.ownerTag)}` : "";
    const pending = this.pendingStop.has(shell.shellId) ? ` ${theme.fg("dim", "stopping…")}` : "";
    const left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${status} ${shell.label}${owner}${pending}`;
    const elapsed = (shell.endedAt ?? Date.now()) - shell.startedAt;
    return rightAlign(left, theme.fg("dim", formatFleetElapsed(elapsed)), width);
  }

  private bullet(rosterIndex: number, selectedIndex: number, theme: Theme): string {
    return rosterIndex === selectedIndex ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
