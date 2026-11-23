import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createLifecycleOwner } from "./lib/lifecycle.ts";
import {
  isInputReplayTarget,
  MouseEscapeGuard,
  rawInputText,
  type InputReplayTarget,
} from "./lib/mouse-escape-guard.ts";

export const PROBE_WIDGET_KEY = "choco-pi-mouse-escape-guard-probe";

type RawInputListener = (chunk: string | Buffer) => void;

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
