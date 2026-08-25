import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ShellChangeEvent,
  ShellResult,
  StopShellInput,
  StopShellResult,
} from "../shell-manager.ts";
import { ShellsFocus } from "./shells-focus.ts";
import { sanitizeShellText } from "./shell-viewer.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_LINGER_MS = 4_000;
const DEFAULT_REFRESH_MS = 100;
const MAX_COMMAND_LENGTH = 52;
const MAX_OWNER_LENGTH = 32;
const MAX_DETAIL_LENGTH = 80;
const DEFAULT_RENDER_WIDTH = 120;

export interface ShellsWidgetManager {
  onChange(listener: (event: ShellChangeEvent) => void): () => void;
  stop(input: StopShellInput): Promise<StopShellResult>;
}

export interface ShellsWidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface ShellsWidgetTUI {
  requestRender?(): void;
  focusedComponent?: unknown;
}

export interface ShellsWidgetComponent {
  render(width?: number): string[];
  invalidate(): void;
}

export interface ShellsWidgetUICtx {
  setWidget(
    key: string,
    content:
      | undefined
      | ((tui: ShellsWidgetTUI, theme: ShellsWidgetTheme) => ShellsWidgetComponent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ShellsWidgetOptions {
  lingerMs?: number;
  refreshMs?: number;
  now?: () => number;
}

interface DisplayShell {
  shell: ShellResult;
  settledAt?: number;
}

export class ShellsWidget {
  private readonly manager: ShellsWidgetManager;
  private readonly rootSessionId: string;
  private readonly lingerMs: number;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly shells = new Map<string, DisplayShell>();
  private readonly unsubscribe: () => void;
  private uiCtx: ShellsWidgetUICtx | undefined;
  private tui: ShellsWidgetTUI | undefined;
  private inputUnsubscribe: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private widgetRegistered = false;
  private frame = 0;
  private readonly focus: ShellsFocus;
  private disposed = false;

  constructor(
    manager: ShellsWidgetManager,
    rootSessionId: string,
    options: ShellsWidgetOptions = {},
  ) {
    this.manager = manager;
    this.rootSessionId = rootSessionId;
    this.lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.now = options.now ?? Date.now;
    this.focus = new ShellsFocus(manager, rootSessionId, () => this.update());
    this.unsubscribe = this.manager.onChange((event) => this.onChange(event));
  }

  setUICtx(ctx: ShellsWidgetUICtx): void {
    if (this.disposed || ctx === this.uiCtx) return;

    this.uiCtx?.setWidget("shells", undefined);
    this.inputUnsubscribe?.();
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsubscribe = ctx.onTerminalInput((data) => {
      if (!this.uiCtx) return undefined;
      return this.focus.handleKey(data, this.rows(), this.uiCtx, this.tui);
    });
    this.update();
  }

  private onChange(event: ShellChangeEvent): void {
    if (this.disposed) return;

    const previous = this.shells.get(event.shell.shellId);
    const settledAt =
      event.shell.state === "running" ? undefined : (previous?.settledAt ?? this.now());
    this.shells.set(event.shell.shellId, { shell: event.shell, settledAt });
    if (event.shell.state !== "running") this.focus.shellChanged(event.shell.shellId, false);
    this.focus.clamp(this.rows());
    this.update();
  }

  private ensureTimer(): void {
    if (this.refreshTimer || this.shells.size === 0) return;

    this.refreshTimer = setInterval(() => this.update(), this.refreshMs);
    this.refreshTimer.unref();
  }

  private stopTimer(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private discardExpired(now: number): void {
    for (const [shellId, display] of this.shells) {
      if (display.settledAt !== undefined && now - display.settledAt >= this.lingerMs) {
        this.shells.delete(shellId);
        this.focus.shellChanged(shellId, true);
      }
    }
    this.focus.clamp(this.rows());
  }

  private render(theme: ShellsWidgetTheme, width = DEFAULT_RENDER_WIDTH): string[] {
    const now = this.now();
    const hasRunning = [...this.shells.values()].some(({ shell }) => shell.state === "running");
    const headingColor = hasRunning ? "accent" : "dim";
    const lines = [theme.fg(headingColor, "●") + " " + theme.fg(headingColor, "Shells")];
    const rows = [...this.shells.values()];

    for (const [index, display] of rows.entries()) {
      const connector = index === rows.length - 1 ? "└─" : "├─";
      const focus = this.focus.state();
      const selected = focus.active && display.shell.shellId === focus.selectedShellId;
      const marker = selected ? theme.fg("accent", "›") : " ";
      lines.push(
        truncateToWidth(
          `${marker} ${theme.fg("dim", connector)} ${renderStatus(display.shell, theme, this.frame)} ${renderLabel(display.shell, theme, this.rootSessionId)}  ${renderStats(display.shell, now, theme)}`,
          width,
        ),
      );
    }
    const focus = this.focus.state();
    const selected = this.focus.selectedShell(this.rows());
    if (focus.active && selected) {
      lines.push(...renderDetail({ shell: selected, focus, now: this.now(), theme, width }));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private rows(): ShellResult[] {
    return [...this.shells.values()].map(({ shell }) => shell);
  }

  private update(): void {
    if (this.disposed) return;

    this.discardExpired(this.now());
    if (this.shells.size === 0) {
      this.stopTimer();
      if (this.widgetRegistered && this.uiCtx) this.uiCtx.setWidget("shells", undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
      return;
    }

    this.frame++;
    this.ensureTimer();
    if (!this.uiCtx) return;

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        "shells",
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width) => this.render(theme, width),
            invalidate: () => {},
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.inputUnsubscribe?.();
    this.inputUnsubscribe = undefined;
    this.stopTimer();
    this.uiCtx?.setWidget("shells", undefined);
    this.shells.clear();
    this.focus.clear();
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}

interface DetailRenderInput {
  shell: ShellResult;
  focus: ReturnType<ShellsFocus["state"]>;
  now: number;
  theme: ShellsWidgetTheme;
  width: number;
}

function renderDetail({ shell, focus, now, theme, width }: DetailRenderInput): string[] {
  const shellId = truncateText(sanitizeShellText(shell.shellId).trim(), MAX_DETAIL_LENGTH);
  const cwd = truncateText(sanitizeShellText(shell.cwd).trim(), MAX_DETAIL_LENGTH);
  const command = truncateCommand(shell.command);
  const runtime = formatDuration((shell.endedAt ?? now) - shell.startedAt);
  const pending = focus.pendingShellIds.has(shell.shellId);
  const error = focus.stopErrors.get(shell.shellId);
  let action = "x stop · Esc back";
  if (shell.state !== "running") action = "settled · Esc back";
  else if (pending) action = "stopping… · Esc back";
  const lines = [
    theme.fg("dim", `    Status: ${shell.state} · Runtime: ${runtime}`),
    theme.fg("dim", `    Command: ${command}`),
    theme.fg("dim", `    Cwd: ${cwd}`),
    theme.fg("dim", `    Shell: ${shellId}`),
    theme.fg(pending ? "muted" : "accent", `    ${action}`),
  ];
  if (error) lines.push(theme.fg("error", `    stop failed: ${error}`));
  return lines.map((line) => truncateToWidth(line, width));
}

function renderStatus(shell: ShellResult, theme: ShellsWidgetTheme, frame: number): string {
  switch (shell.state) {
    case "running":
      return theme.fg("accent", SPINNER[frame % SPINNER.length]);
    case "exited":
      return `${theme.fg("success", "✓")} ${theme.fg("dim", "exited")}`;
    case "stopped":
      return `${theme.fg("dim", "■")} ${theme.fg("dim", "stopped")}`;
    case "failed":
      return `${theme.fg("error", "✗")} ${theme.fg("error", "failed")}`;
    default:
      return theme.fg("error", "?");
  }
}

function renderLabel(shell: ShellResult, theme: ShellsWidgetTheme, rootSessionId: string): string {
  const label = shell.name
    ? truncateText(sanitizeShellText(shell.name).trim(), MAX_COMMAND_LENGTH)
    : truncateCommand(shell.command);
  const ownerId = truncateText(sanitizeShellText(shell.ownerId).trim(), MAX_OWNER_LENGTH);
  const ownerTag = shell.ownerId === rootSessionId ? "" : theme.fg("muted", ` [owner:${ownerId}]`);
  return theme.bold(label) + ownerTag;
}

function renderStats(shell: ShellResult, now: number, theme: ShellsWidgetTheme): string {
  const end = shell.endedAt ?? now;
  const parts: string[] = [];
  if (shell.pid !== undefined) parts.push(`pid ${shell.pid}`);
  parts.push(formatDuration(end - shell.startedAt));
  if (shell.state === "exited" && shell.exitCode !== undefined) {
    parts.push(`exit ${shell.exitCode}`);
  } else if (shell.state === "failed" && shell.error) {
    parts.push(truncateText(sanitizeShellText(shell.error), 40));
  }
  return theme.fg("dim", parts.join(" · "));
}

function truncateCommand(command: string): string {
  return truncateText(sanitizeShellText(command).replace(/\s+/g, " ").trim(), MAX_COMMAND_LENGTH);
}

function truncateText(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length - 1) + "…";
}

function formatDuration(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}
