import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { sanitizeShellText, ShellOutputViewer } from "./shell-viewer.ts";

export const SHELLS_OVERLAY_HEIGHT_PCT = 70;

export type ShellState = "running" | "exited" | "stopped" | "failed";

export interface ShellSummary {
  shellId: string;
  ownerId: string;
  name?: string;
  command: string;
  cwd: string;
  state: ShellState;
  pid?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface ShellsManager {
  list(input: { requesterId: string; isAdmin: boolean }): { shells: ShellSummary[] };
  read(input: {
    requesterId: string;
    isAdmin: boolean;
    shellId: string;
    stdoutOffset?: number;
    stderrOffset?: number;
    maxBytes?: number;
  }): {
    shell: ShellSummary;
    stdout: ShellStreamChunk;
    stderr: ShellStreamChunk;
  };
  stop(input: { requesterId: string; isAdmin: boolean; shellId: string }): Promise<ShellSummary>;
  onChange?(listener: () => void): () => void;
}

export interface ShellStreamChunk {
  data: string;
  startOffset: number;
  nextOffset: number;
  endOffset: number;
  dropped: boolean;
}

export interface ShellViewerKeybindings {
  matches(
    data: string,
    keybinding: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown",
  ): boolean;
}

export interface ShellsUICtx {
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: ShellViewerKeybindings | undefined,
      done: (result: T) => void,
    ) => Component,
    options?: ShellCustomOptions,
  ): Promise<T>;
}

export interface ShellCustomOptions {
  overlay?: boolean;
  overlayOptions?: {
    anchor?: "center";
    width?: number | `${number}%`;
    maxHeight?: number | `${number}%`;
  };
}

function viewerKey(
  data: string,
  keybindings: ShellViewerKeybindings | undefined,
  id: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown",
  fallback: "up" | "down" | "pageUp" | "pageDown",
): boolean {
  return keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
}

function elapsed(shell: ShellSummary): string {
  const end = shell.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - shell.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function stateMark(shell: ShellSummary, theme: Theme): string {
  if (shell.state === "running") return theme.fg("accent", "●");
  if (shell.state === "exited") return theme.fg("success", "✓");
  if (shell.state === "failed") return theme.fg("error", "✗");
  return theme.fg("muted", "○");
}

export class ShellsOverlay implements Component {
  private selectedIndex = 0;
  private stopArmed = false;
  private closed = false;
  private listError: string | undefined;
  private actionError: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private lastHeight = 8;

  private tui: TUI;
  private manager: ShellsManager;
  private requesterId: string;
  private theme: Theme;
  private done: (result: ShellSummary | undefined) => void;
  private keybindings: ShellViewerKeybindings | undefined;

  constructor(
    tui: TUI,
    manager: ShellsManager,
    requesterId: string,
    theme: Theme,
    done: (result: ShellSummary | undefined) => void,
    keybindings?: ShellViewerKeybindings,
  ) {
    this.tui = tui;
    this.manager = manager;
    this.requesterId = requesterId;
    this.theme = theme;
    this.done = done;
    this.keybindings = keybindings;
    this.unsubscribe = manager.onChange?.(() => {
      if (!this.closed) this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close(undefined);
      return;
    }

    const shells = this.shells();
    if (shells.length === 0) return;
    if (matchesKey(data, "enter")) {
      this.close(shells[this.selectedIndex]);
      return;
    }
    if (matchesKey(data, "x")) {
      const selected = shells[this.selectedIndex];
      if (selected?.state !== "running") return;
      if (!this.stopArmed) {
        this.stopArmed = true;
        this.tui.requestRender();
        return;
      }
      this.stopArmed = false;
      void this.manager
        .stop({ requesterId: this.requesterId, isAdmin: true, shellId: selected.shellId })
        .then(() => {
          this.actionError = undefined;
        })
        .catch((error) => {
          this.actionError = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => this.tui.requestRender());
      return;
    }

    const page = Math.max(1, this.lastHeight);
    let next = this.selectedIndex;
    if (viewerKey(data, this.keybindings, "tui.select.up", "up") || matchesKey(data, "k")) {
      next = Math.max(0, next - 1);
    } else if (
      viewerKey(data, this.keybindings, "tui.select.down", "down") ||
      matchesKey(data, "j")
    ) {
      next = Math.min(shells.length - 1, next + 1);
    } else if (
      viewerKey(data, this.keybindings, "tui.select.pageUp", "pageUp") ||
      matchesKey(data, "shift+up")
    ) {
      next = Math.max(0, next - page);
    } else if (
      viewerKey(data, this.keybindings, "tui.select.pageDown", "pageDown") ||
      matchesKey(data, "shift+down")
    ) {
      next = Math.min(shells.length - 1, next + page);
    } else if (matchesKey(data, "home")) {
      next = 0;
    } else if (matchesKey(data, "end")) {
      next = shells.length - 1;
    } else {
      if (this.stopArmed) {
        this.stopArmed = false;
        this.tui.requestRender();
      }
      return;
    }

    this.stopArmed = false;
    if (next !== this.selectedIndex) {
      this.selectedIndex = next;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const shells = this.shells();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, shells.length - 1));
    const inner = width - 4;
    const maxRows = Math.max(
      3,
      Math.floor((this.tui.terminal.rows * SHELLS_OVERLAY_HEIGHT_PCT) / 100) - 6,
    );
    this.lastHeight = maxRows;
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - maxRows + 1, Math.max(0, shells.length - maxRows)),
    );
    const visible = shells.slice(start, start + maxRows);
    const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    lines.push(this.row(`Shells (${shells.length})`, inner));
    lines.push(this.row(this.theme.fg("dim", "─".repeat(inner)), inner));
    if (visible.length === 0) lines.push(this.row(this.theme.fg("dim", "(no shells)"), inner));
    for (let index = 0; index < visible.length; index++) {
      const shell = visible[index];
      if (!shell) continue;
      const selected = start + index === this.selectedIndex;
      const bullet = selected ? this.theme.fg("accent", "●") : " ";
      const label = sanitizeShellText(shell.name ?? shell.command).trim();
      const pid = shell.pid === undefined ? "" : ` pid ${shell.pid}`;
      lines.push(
        this.row(
          `${bullet} ${stateMark(shell, this.theme)} ${label} ${this.theme.fg("dim", `· ${shell.state}${pid} · ${elapsed(shell)}`)}`,
          inner,
        ),
      );
    }
    lines.push(this.row(this.theme.fg("dim", "─".repeat(inner)), inner));
    const selected = shells[this.selectedIndex];
    let action = "";
    if (selected?.state === "running") {
      action = this.stopArmed ? this.theme.fg("error", "x again to STOP") : "x stop";
    }
    const errorText = this.actionError ?? this.listError;
    const error = errorText ? this.theme.fg("error", errorText) : "";
    lines.push(
      this.row(
        [error || action, "↑↓/kj move · PgUp/PgDn · Enter view · Esc/q close"]
          .filter(Boolean)
          .join(" · "),
        inner,
      ),
    );
    lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private shells(): ShellSummary[] {
    try {
      const shells = this.manager.list({ requesterId: this.requesterId, isAdmin: true }).shells;
      this.listError = undefined;
      return shells;
    } catch (error: unknown) {
      this.listError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  private close(result: ShellSummary | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  private row(content: string, inner: number): string {
    const clipped = truncateToWidth(content, inner, "…", true);
    return `${this.theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${this.theme.fg("border", "│")}`;
  }
}

/** Open the admin shell roster and hand Enter selections to a live output viewer. */
export async function openShellsOverlay(
  ui: ShellsUICtx,
  manager: ShellsManager,
  requesterId: string,
): Promise<void> {
  for (;;) {
    const selected = await ui.custom<ShellSummary | undefined>(
      (tui, theme, keybindings, done) =>
        new ShellsOverlay(tui, manager, requesterId, theme, done, keybindings),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: `${SHELLS_OVERLAY_HEIGHT_PCT}%`,
        },
      },
    );
    if (!selected) return;
    await ui.custom<undefined>(
      (tui, theme, keybindings, done) =>
        new ShellOutputViewer(tui, manager, requesterId, selected, theme, done, keybindings),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: `${SHELLS_OVERLAY_HEIGHT_PCT}%`,
        },
      },
    );
  }
}
