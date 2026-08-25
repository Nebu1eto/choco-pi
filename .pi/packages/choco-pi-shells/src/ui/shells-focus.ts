import { Editor, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

import type { ShellResult } from "../shell-manager.ts";
import type { ShellsWidgetManager, ShellsWidgetTUI, ShellsWidgetUICtx } from "./shells-widget.ts";
import { sanitizeShellText } from "./shell-viewer.ts";

export interface ShellsFocusState {
  active: boolean;
  selectedShellId?: string;
  pendingShellIds: ReadonlySet<string>;
  stopErrors: ReadonlyMap<string, string>;
}

export class ShellsFocus {
  private readonly manager: ShellsWidgetManager;
  private readonly rootSessionId: string;
  private readonly requestUpdate: () => void;
  private active = false;
  private selectedShellId: string | undefined;
  private selectedIndex = 0;
  private readonly pendingShellIds = new Set<string>();
  private readonly stopErrors = new Map<string, string>();

  constructor(manager: ShellsWidgetManager, rootSessionId: string, requestUpdate: () => void) {
    this.manager = manager;
    this.rootSessionId = rootSessionId;
    this.requestUpdate = requestUpdate;
  }

  state(): ShellsFocusState {
    return {
      active: this.active,
      selectedShellId: this.selectedShellId,
      pendingShellIds: this.pendingShellIds,
      stopErrors: this.stopErrors,
    };
  }

  selectedShell(rows: readonly ShellResult[]): ShellResult | undefined {
    return rows.find((shell) => shell.shellId === this.selectedShellId);
  }

  shellChanged(shellId: string, removed: boolean): void {
    this.pendingShellIds.delete(shellId);
    if (removed) this.stopErrors.delete(shellId);
  }

  clamp(rows: readonly ShellResult[]): void {
    if (rows.length === 0) {
      this.active = false;
      this.selectedShellId = undefined;
      this.selectedIndex = 0;
      return;
    }
    const keyedIndex = rows.findIndex((shell) => shell.shellId === this.selectedShellId);
    if (keyedIndex >= 0) {
      this.selectedIndex = keyedIndex;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    this.selectedShellId = rows[this.selectedIndex]?.shellId;
  }

  handleKey(
    data: string,
    rows: readonly ShellResult[],
    uiCtx: ShellsWidgetUICtx,
    tui: ShellsWidgetTUI | undefined,
  ): { consume?: boolean; data?: string } | undefined {
    if (isKeyRelease(data)) return undefined;
    const focused = tui?.focusedComponent;
    if (
      (focused != null && !(focused instanceof Editor)) ||
      uiCtx.getEditorText() !== "" ||
      rows.length === 0
    ) {
      this.deactivate();
      return undefined;
    }
    if (!this.active) {
      if (!matchesKey(data, "down")) return undefined;
      this.active = true;
      this.clamp(rows);
      this.requestUpdate();
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "up")) {
      const delta = matchesKey(data, "down") ? 1 : -1;
      this.selectedIndex = Math.max(0, Math.min(rows.length - 1, this.selectedIndex + delta));
      this.selectedShellId = rows[this.selectedIndex]?.shellId;
      this.stopErrors.clear();
      this.requestUpdate();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, "x")) {
      void this.stopSelected(rows, uiCtx);
      return { consume: true };
    }
    this.deactivate();
    return undefined;
  }

  clear(): void {
    this.pendingShellIds.clear();
    this.stopErrors.clear();
    this.active = false;
    this.selectedShellId = undefined;
    this.selectedIndex = 0;
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.stopErrors.clear();
    this.requestUpdate();
  }

  private async stopSelected(
    rows: readonly ShellResult[],
    uiCtx: ShellsWidgetUICtx,
  ): Promise<void> {
    const shell = this.selectedShell(rows);
    if (!shell) return;
    if (shell.state !== "running") {
      uiCtx.notify("Shell already settled; nothing to stop.", "info");
      return;
    }
    if (this.pendingShellIds.has(shell.shellId)) return;
    this.pendingShellIds.add(shell.shellId);
    this.stopErrors.delete(shell.shellId);
    this.requestUpdate();
    try {
      await this.manager.stop({
        requesterId: this.rootSessionId,
        isAdmin: true,
        shellId: shell.shellId,
      });
      this.pendingShellIds.delete(shell.shellId);
    } catch (error) {
      this.pendingShellIds.delete(shell.shellId);
      const message = error instanceof Error ? error.message : String(error);
      this.stopErrors.set(shell.shellId, truncateText(sanitizeShellText(message), 60));
    }
    this.requestUpdate();
  }
}

function truncateText(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}
