import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.ts";
import type { ViewerKeybindings } from "./viewer-keys.ts";

export type ShellSectionState = "running" | "exited" | "stopped" | "failed";

export interface ShellSectionRow {
  shellId: string;
  label: string;
  ownerTag?: string;
  state: ShellSectionState;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  error?: string;
  command: string;
  cwd: string;
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
  rows(now: number): readonly ShellSectionRow[];
  onChange(listener: () => void): () => void;
  stop(shellId: string): Promise<void>;
  openViewer(
    shellId: string,
    ui: ShellViewerHost,
    onOpened: (close: () => void) => void,
  ): Promise<void>;
}

export type ShellSectionRegistration = { unregister(): void };
