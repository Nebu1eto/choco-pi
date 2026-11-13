/**
 * shell-section-contract.ts — Cross-package type contract for the merged above-editor panel.
 *
 * choco-pi-shells imports this contract to provide shell rows and viewer actions to
 * choco-pi-subagents without introducing runtime code or package imports here.
 */

import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.ts";
import type { ViewerKeybindings } from "./viewer-keys.ts";

export type ShellSectionState = "running" | "exited" | "stopped" | "failed";

export interface ShellSectionRow {
  shellId: string;
  /** Already sanitized/bounded by the provider (sanitizeShellText + length caps). */
  label: string;
  ownerTag?: string; // "" for root-owned; provider formats "[owner:…]"
  state: ShellSectionState;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  error?: string; // sanitized, bounded
  command: string;
  cwd: string; // sanitized, bounded (detail lines)
}

export interface ShellViewerHost {
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: ViewerKeybindings | undefined,
      done: (r: T) => void,
    ) => {
      render(width: number): string[];
      invalidate(): void;
      dispose?(): void;
    },
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
}

export interface ShellSectionProvider {
  /** Linger already applied by the provider using `now`; settled rows expire 4 s after settling. */
  rows(now: number): readonly ShellSectionRow[];
  onChange(listener: () => void): () => void;
  /** Root admin stop; rejects with an Error whose message is safe to display. */
  stop(shellId: string): Promise<void>;
  /** Opens the output viewer; resolves when closed. `onOpened` receives a closer the panel may call on dispose. */
  openViewer(
    shellId: string,
    ui: ShellViewerHost,
    onOpened: (close: () => void) => void,
  ): Promise<void>;
}

export type ShellSectionRegistration = { unregister(): void };
