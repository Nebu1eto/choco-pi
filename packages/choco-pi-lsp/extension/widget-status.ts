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

export interface LspStatusUpdaters {
  updateLspStatus: (
    setStatus: (id: string, text: string | undefined) => void,
    theme: LspStatusTheme,
  ) => void;
  captureLspStatusRepaint: (ctx: RuntimeValue) => (() => void) | undefined;
}

export function createLspStatusUpdaters(
  getLensFlag: (name: string) => boolean | string | undefined,
): LspStatusUpdaters {
  function updateLspStatus(
    setStatus: (id: string, text: string | undefined) => void,
    theme: LspStatusTheme,
  ) {
    try {
      if (getLensFlag("no-lsp")) {
        setStatus("choco-pi-lsp", theme.fg("dim", "LSP Inactive (disabled)"));
        return;
      }
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
      setStatus(
        "choco-pi-lsp",
        parts.length > 0 ? parts.join(" · ") : theme.fg("dim", "LSP Inactive"),
      );
    } catch (err) {
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

export interface LensWidgetMount {
  mountLensWidget: (ui: LensWidgetUi | undefined, mode: ExtensionRunMode) => boolean;
  unmountLensWidget: (ui: LensWidgetUi | undefined) => boolean;
}

export function createLensWidgetMount(
  hostPorts: HostPorts,
  activationState: ActivationState,
): LensWidgetMount {
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
