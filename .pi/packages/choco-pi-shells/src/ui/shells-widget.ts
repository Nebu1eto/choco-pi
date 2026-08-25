import type { ShellChangeEvent, ShellResult } from "../shell-manager.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_LINGER_MS = 4_000;
const DEFAULT_REFRESH_MS = 100;
const MAX_COMMAND_LENGTH = 52;

export interface ShellsWidgetManager {
  onChange(listener: (event: ShellChangeEvent) => void): () => void;
}

export interface ShellsWidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface ShellsWidgetTUI {
  requestRender?(): void;
}

export interface ShellsWidgetComponent {
  render(): string[];
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
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private widgetRegistered = false;
  private frame = 0;
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
    this.unsubscribe = this.manager.onChange((event) => this.onChange(event));
  }

  setUICtx(ctx: ShellsWidgetUICtx): void {
    if (this.disposed || ctx === this.uiCtx) return;

    this.uiCtx?.setWidget("shells", undefined);
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.update();
  }

  private onChange(event: ShellChangeEvent): void {
    if (this.disposed) return;

    const previous = this.shells.get(event.shell.shellId);
    const settledAt =
      event.shell.state === "running" ? undefined : (previous?.settledAt ?? this.now());
    this.shells.set(event.shell.shellId, { shell: event.shell, settledAt });
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
      }
    }
  }

  private render(theme: ShellsWidgetTheme): string[] {
    const now = this.now();
    const hasRunning = [...this.shells.values()].some(({ shell }) => shell.state === "running");
    const headingColor = hasRunning ? "accent" : "dim";
    const lines = [theme.fg(headingColor, "●") + " " + theme.fg(headingColor, "Shells")];
    const rows = [...this.shells.values()];

    for (const [index, display] of rows.entries()) {
      const connector = index === rows.length - 1 ? "└─" : "├─";
      lines.push(
        `${theme.fg("dim", connector)} ${this.renderStatus(display.shell, theme)} ${this.renderLabel(display.shell, theme)}  ${this.renderStats(display.shell, now, theme)}`,
      );
    }
    return lines;
  }

  private renderStatus(shell: ShellResult, theme: ShellsWidgetTheme): string {
    switch (shell.state) {
      case "running":
        return theme.fg("accent", SPINNER[this.frame % SPINNER.length]);
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

  private renderLabel(shell: ShellResult, theme: ShellsWidgetTheme): string {
    const label = shell.name ?? truncateCommand(shell.command);
    const ownerTag =
      shell.ownerId === this.rootSessionId ? "" : theme.fg("muted", ` [owner:${shell.ownerId}]`);
    return theme.bold(label) + ownerTag;
  }

  private renderStats(shell: ShellResult, now: number, theme: ShellsWidgetTheme): string {
    const end = shell.endedAt ?? now;
    const parts: string[] = [];
    if (shell.pid !== undefined) parts.push(`pid ${shell.pid}`);
    parts.push(formatDuration(end - shell.startedAt));
    if (shell.state === "exited" && shell.exitCode !== undefined) {
      parts.push(`exit ${shell.exitCode}`);
    } else if (shell.state === "failed" && shell.error) {
      parts.push(truncateText(shell.error, 40));
    }
    return theme.fg("dim", parts.join(" · "));
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
            render: () => this.render(theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
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
    this.stopTimer();
    this.uiCtx?.setWidget("shells", undefined);
    this.shells.clear();
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}

function truncateCommand(command: string): string {
  return truncateText(command.replace(/\s+/g, " ").trim(), MAX_COMMAND_LENGTH);
}

function truncateText(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length - 1) + "…";
}

function formatDuration(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}
