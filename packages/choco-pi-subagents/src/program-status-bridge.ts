import type { ProgramStatus } from "@earendil-works/pi-tui";
import { ProgramStatusHold, type ProgramStatusHoldOptions } from "./program-status-hold.ts";
import { installMethodPatch } from "./ui/method-patch-registry.ts";

const PROBE_WIDGET_KEY = "choco-pi-subagents:terminal-probe";

/** The terminal member Pi's status reporter writes through. */
export interface StatusTerminal {
  setProgramStatus(status: ProgramStatus): void;
}

/** The widget surface used to reach the TUI's terminal. */
export interface TerminalProbeUI {
  setWidget(
    key: string,
    content:
      | ((tui: { terminal: StatusTerminal }) => {
          render(width: number): string[];
          invalidate(): void;
        })
      | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

/**
 * The TUI terminal Pi's status reporter writes through. A widget factory is
 * the only extension surface that receives the TUI; a below-editor widget
 * that renders nothing adds no spacer, and it is removed straight away.
 */
function captureTerminal(ui: TerminalProbeUI): StatusTerminal | undefined {
  let terminal: StatusTerminal | undefined;
  ui.setWidget(
    PROBE_WIDGET_KEY,
    (tui) => {
      terminal = tui.terminal;
      return { render: () => [], invalidate: () => {} };
    },
    { placement: "belowEditor" },
  );
  ui.setWidget(PROBE_WIDGET_KEY, undefined);
  return terminal;
}

export interface ProgramStatusBridge {
  hold: ProgramStatusHold;
  dispose(): void;
}

/**
 * Keep the root's terminal status `working` while its background work runs.
 * Returns `undefined`, leaving Pi's own reporting untouched, when the TUI
 * terminal cannot be reached.
 */
export function installProgramStatusBridge(
  ui: TerminalProbeUI,
  options: ProgramStatusHoldOptions,
): ProgramStatusBridge | undefined {
  const terminal = captureTerminal(ui);
  if (!terminal || !(terminal.setProgramStatus instanceof Function)) return undefined;
  const hold = new ProgramStatusHold(options);
  let restore: (() => void) | undefined;
  try {
    restore = installMethodPatch(
      terminal,
      "setProgramStatus",
      "background-program-status",
      ({ predecessor, receiver, args }) => {
        hold.attach((status: ProgramStatus) => {
          predecessor.call(receiver, status);
        });
        hold.report(args[0]);
      },
    );
  } catch {
    return undefined;
  }
  return {
    hold,
    dispose: () => {
      hold.dispose();
      restore?.();
      restore = undefined;
    },
  };
}
