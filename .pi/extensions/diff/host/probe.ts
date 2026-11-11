import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { toPaneTui, type PaneTui } from "./types.ts";

export const PROBE_WIDGET_KEY = "choco-pi-diff-probe";

type ProbeCapture = { tui?: TUI };

/**
 * Obtain Pi's TUI handle. Extensions receive it only through component
 * factories, so this mounts a zero-line widget, keeps the handle the factory
 * receives, and removes the widget again in the same tick. Pi calls widget
 * factories synchronously, so nothing is ever drawn.
 */
export function probeTui(ui: Pick<ExtensionUIContext, "setWidget">): PaneTui | undefined {
  const captured: ProbeCapture = {};
  ui.setWidget(PROBE_WIDGET_KEY, (tui) => {
    captured.tui = tui;
    return { render: () => [], invalidate: () => {} };
  });
  ui.setWidget(PROBE_WIDGET_KEY, undefined);
  return captured.tui === undefined ? undefined : toPaneTui(captured.tui);
}
