import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createLifecycleOwner } from "./lib/lifecycle.ts";
import {
  isInputReplayTarget,
  MouseEscapeGuard,
  rawInputText,
  type InputReplayTarget,
} from "./lib/mouse-escape-guard.ts";

/**
 * Keeps mouse scrolling from aborting the running turn or typing `[<65;12;30M`
 * into the prompt (see ./lib/mouse-escape-guard.ts for the cause).
 *
 * The guard needs two inputs. Pi's terminal input listener is where a bare ESC
 * is held back and dropped. Recent mouse input has to be read from raw stdin:
 * in fullscreen mode pi-tui's own viewport listener runs before every
 * extension listener and consumes every whole mouse report, so no extension
 * listener ever sees the scrolling that precedes a split report.
 *
 * A held ESC is handed back through the TUI's own input path, so it reaches
 * every listener after this one and the focused component exactly as it would
 * have without the guard.
 */

export const PROBE_WIDGET_KEY = "choco-pi-mouse-escape-guard-probe";

type RawInputListener = (chunk: string | Buffer) => void;

/** The part of `process.stdin` the raw observer uses. */
export interface RawInput {
  prependListener(event: "data", listener: RawInputListener): void;
  removeListener(event: "data", listener: RawInputListener): void;
}

type GuardContext = Pick<ExtensionContext, "mode"> & {
  ui: Pick<ExtensionContext["ui"], "onTerminalInput" | "setWidget">;
};

interface Installed {
  dispose(): void;
}

interface ProbeCapture {
  tui?: TUI;
}

/**
 * Obtain Pi's TUI handle from a widget factory, which Pi calls synchronously,
 * and remove the zero-line widget again before anything is drawn. The handle
 * follows Pi's current renderer across TUI mode switches.
 */
export function probeReplayTarget(ui: GuardContext["ui"]): InputReplayTarget | undefined {
  const captured: ProbeCapture = {};
  ui.setWidget(PROBE_WIDGET_KEY, (tui) => {
    captured.tui = tui;
    return { render: () => [], invalidate: () => {} };
  });
  ui.setWidget(PROBE_WIDGET_KEY, undefined);
  const tui = captured.tui;
  return tui !== undefined && isInputReplayTarget(tui) ? tui : undefined;
}

/** Start the guard for one session; undefined outside the TUI or when input cannot be replayed. */
export function installMouseEscapeGuard(ctx: GuardContext, stdin: RawInput): Installed | undefined {
  if (ctx.mode !== "tui") return undefined;
  const target = probeReplayTarget(ctx.ui);
  if (target === undefined) return undefined;
  const guard = new MouseEscapeGuard({
    now: () => performance.now(),
    replay: (data) => target.handleTerminalInput(data),
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    afterPendingInput: (run) => {
      const immediate = setImmediate(run);
      return () => clearImmediate(immediate);
    },
  });
  const unsubscribe = ctx.ui.onTerminalInput((data) => guard.handleInput(data));
  const observe: RawInputListener = (chunk) => guard.observeRaw(rawInputText(chunk));
  // prependListener, unlike on(), never switches a paused stdin to flowing.
  stdin.prependListener("data", observe);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      guard.dispose();
      stdin.removeListener("data", observe);
      unsubscribe();
    },
  };
}

export function createMouseEscapeGuardExtension(stdin: RawInput): (pi: ExtensionAPI) => void {
  return (pi) => {
    const owner = createLifecycleOwner<Installed>();
    const teardown = (): void => {
      const installed = owner.current();
      owner.invalidate();
      installed?.dispose();
    };
    pi.on("session_start", (_event, ctx) => {
      teardown();
      const installed = installMouseEscapeGuard(ctx, stdin);
      if (installed !== undefined) owner.replace(installed);
    });
    pi.on("session_shutdown", () => {
      teardown();
    });
  };
}

export default createMouseEscapeGuardExtension(process.stdin);
