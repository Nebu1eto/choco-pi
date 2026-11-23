/**
 * LSP footer status rendering and the belowEditor diagnostics widget mount.
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

import type { RuntimeValue } from "../tools/runtime-values.ts";
import { isRuntimeFunction } from "../tools/runtime-values.ts";
import { logExtension } from "../clients/extension-log.ts";
import {
  type ExtensionRunMode,
  modeSuppressionNote,
  supportsTuiWidget,
} from "../clients/extension-mode.ts";
import { type HostPorts } from "../clients/host-ports.ts";
import {
  getFailedLspServerIds,
  getSessionLanguages,
  renderWidget,
  scheduleStaleReconcile,
  setRenderCallback,
} from "../clients/widget-state.ts";
import { selectLspStatus } from "../clients/lsp-status.ts";
import { getLSPService } from "../clients/lsp/index.ts";
import type { ActivationState } from "./activation.ts";
import { dbg } from "./shared.ts";

export type LspStatusTheme = {
  fg: (color: "accent" | "success" | "error" | "warning" | "dim", text: string) => string;
};

/** Footer status painters bound to the activation's flag resolver. */
export interface LspStatusUpdaters {
  updateLspStatus: (
    setStatus: (id: string, text: string | undefined) => void,
    theme: LspStatusTheme,
  ) => void;
  captureLspStatusRepaint: (ctx: RuntimeValue) => (() => void) | undefined;
}

/** Create the footer status painters. */
export function createLspStatusUpdaters(
  getLensFlag: (name: string) => boolean | string | undefined,
): LspStatusUpdaters {
  function updateLspStatus(
    setStatus: (id: string, text: string | undefined) => void,
    theme: LspStatusTheme,
  ) {
    try {
      // choco-pi fork: when LSP usage is toggled off (`/lsp off`, `--no-lsp`,
      // or `lsp.enabled=false`), render the disabled state as an "LSP
      // Inactive" variant. The choco-pi-lsp-visibility extension keys on that
      // phrase to hide both the status segment and the widget.
      if (getLensFlag("no-lsp")) {
        setStatus("choco-pi-lsp", theme.fg("dim", "LSP Inactive (disabled)"));
        return;
      }
      // Active and Failed coexist (#170): show the working servers in green
      // AND any language whose servers all failed in red, side by side. A
      // failed server is suppressed when a live sibling covers its language
      // (alt-LSP fallback) or its kind is no longer in use this session.
      const { activeIds, failedIds } = selectLspStatus(
        getLSPService().getAliveServerIds(),
        getFailedLspServerIds(),
        getSessionLanguages(),
      );
      const parts: string[] = [];
      if (activeIds.length > 0) {
        parts.push(theme.fg("success", `LSP Active: ${activeIds.join(", ")}`));
      }
      if (failedIds.length > 0) {
        parts.push(theme.fg("error", `LSP Failed: ${failedIds.join(", ")}`));
      }
      // Inactive is a passive state (no server running for this file, or the
      // idle timer released them) — not a fault. Render it neutral/grey, not
      // red, only when there is nothing else to show.
      setStatus(
        "choco-pi-lsp",
        parts.length > 0 ? parts.join(" · ") : theme.fg("dim", "LSP Inactive"),
      );
    } catch (err) {
      // Theme may not be fully initialized during early session startup.
      // Skip the status update rather than crashing the event handler.
      dbg(`lsp status update skipped: ${err}`);
    }
  }

  function captureLspStatusRepaint(ctx: RuntimeValue): (() => void) | undefined {
    let ui:
      | {
          setStatus?: (id: string, text: string | undefined) => void;
          theme?: LspStatusTheme;
        }
      | undefined;
    try {
      // SAFETY: Pi command contexts define ui with these optional status and theme members.
      ui = (
        ctx as {
          ui?: {
            setStatus?: (id: string, text: string | undefined) => void;
            theme?: LspStatusTheme;
          };
        }
      ).ui;
    } catch (err) {
      // Accessing ctx.ui is guarded by pi and can throw after session
      // replacement. Capture during an active event when possible; detached
      // timers must not touch the ctx getter later (#338).
      dbg(`lsp status repaint capture skipped: ${err}`);
      return undefined;
    }
    if (!ui || !isRuntimeFunction(ui.setStatus) || !ui.theme) {
      return undefined;
    }
    const { setStatus, theme } = ui;
    return () => updateLspStatus(setStatus, theme);
  }
  return { updateLspStatus, captureLspStatusRepaint };
}

export type LensWidgetTui = { requestRender: () => void };
export type LensWidgetTheme = { fg: (color: string, s: string) => string };
export type LensWidgetComponent = {
  render: (width: number) => string[];
  invalidate: () => void;
};
export type LensWidgetFactory = (tui: LensWidgetTui, theme: LensWidgetTheme) => LensWidgetComponent;
export type LensWidgetUi = { setWidget?: unknown };
export type LensWidgetSetWidget = (
  id: string,
  widget: LensWidgetFactory | undefined,
  options?: { placement: "belowEditor" },
) => void;

/** Widget mount/unmount bound to one activation. */
export interface LensWidgetMount {
  mountLensWidget: (ui: LensWidgetUi | undefined, mode: ExtensionRunMode) => boolean;
  unmountLensWidget: (ui: LensWidgetUi | undefined) => boolean;
}

/** Create the widget mount/unmount pair for one activation. */
export function createLensWidgetMount(
  hostPorts: HostPorts,
  activationState: ActivationState,
): LensWidgetMount {
  /**
   * #1334 S2: the widget is a terminal-only custom component. The host's own
   * types say so — *"Use `"tui"` to guard terminal-only UI such as custom
   * components"* — so mounting is gated on the mode pi reports, not attempted
   * blindly. `rpc` is excluded despite `hasUI: true`: dialogs travel over the
   * protocol there, a belowEditor component does not. An older host with no
   * `mode` field reads "unknown" and mounts exactly as before.
   */
  function mountLensWidget(ui: LensWidgetUi | undefined, mode: ExtensionRunMode): boolean {
    if (!supportsTuiWidget(mode)) {
      dbg(`widget mount ${modeSuppressionNote(mode)}`);
      return false;
    }
    if (!isRuntimeFunction(ui?.setWidget)) {
      if (!activationState.widgetMountFailureLogged) {
        activationState.widgetMountFailureLogged = true;
        logExtension({
          subsystem: "widget",
          level: "debug",
          message: "widget mount unavailable: host ui.setWidget is missing",
        });
      }
      return false;
    }
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    const setWidget = ui.setWidget as LensWidgetSetWidget;
    setWidget(
      "choco-pi-lsp",
      (tui: LensWidgetTui, theme: LensWidgetTheme) => {
        activationState.renderInvalidator = () => tui.requestRender();
        setRenderCallback(() => {
          scheduleStaleReconcile();
          hostPorts.render.invalidate();
        });
        return {
          render: (width: number) => {
            scheduleStaleReconcile();
            return renderWidget(width, theme);
          },
          invalidate: () => {
            activationState.renderInvalidator = undefined;
            setRenderCallback(() => {});
          },
        };
      },
      { placement: "belowEditor" },
    );
    activationState.mountedLensWidgetUi = ui;
    return true;
  }

  function unmountLensWidget(ui: LensWidgetUi | undefined): boolean {
    activationState.renderInvalidator = undefined;
    setRenderCallback(() => {});
    if (!isRuntimeFunction(ui?.setWidget)) return false;
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    const setWidget = ui.setWidget as LensWidgetSetWidget;
    setWidget("choco-pi-lsp", undefined);
    activationState.mountedLensWidgetUi = undefined;
    return true;
  }
  return { mountLensWidget, unmountLensWidget };
}
