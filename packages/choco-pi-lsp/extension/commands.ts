import { readExtensionMode, supportsTuiWidget } from "../clients/extension-mode.ts";
import * as path from "node:path";
import { getFailedLspServerIds, getSessionLanguages } from "../clients/widget-state.ts";
import { selectLspStatus } from "../clients/lsp-status.ts";
import { persistPiLensGlobalConfigKey, setRuntimeLensFlagOverride } from "../clients/lsp-config.ts";
import { getLSPService, resetLSPService } from "../clients/lsp/index.ts";
import type { ExtensionActivation } from "./activation.ts";
import { dbg, normalizeCommandArgs, notifyUi } from "./shared.ts";
import type { LspStatusTheme } from "./widget-status.ts";

export function registerToggleCommands(activation: ExtensionActivation): void {
  const { pi, activationState, getLensFlag, updateLspStatus, mountLensWidget, unmountLensWidget } =
    activation;

  pi.registerCommand("lens-toggle", {
    description: "Toggle choco-pi-lsp on/off for the current session. Usage: /lens-toggle",
    handler: async (_args, ctx) => {
      activationState.lensEnabled = !activationState.lensEnabled;
      notifyUi(
        ctx,
        activationState.lensEnabled
          ? "choco-pi-lsp enabled for this session."
          : "choco-pi-lsp disabled for this session. Run /lens-toggle again to resume.",
        activationState.lensEnabled ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("lsp", {
    description:
      "Turn choco-pi-lsp LSP usage on or off at runtime, or show its state. Usage: /lsp on|off|status",
    handler: async (args, ctx) => {
      const [subcommand] = normalizeCommandArgs(args);
      const repaintLspStatus = () => {
        try {
          // SAFETY: Pi command contexts define ui with these optional status and theme members.
          const ui = (
            ctx as {
              ui?: {
                setStatus?: (id: string, text: string | undefined) => void;
                theme?: LspStatusTheme;
              };
            }
          ).ui;
          if (ui?.setStatus && ui.theme) updateLspStatus(ui.setStatus, ui.theme);
        } catch (err) {
          dbg(`/lsp status repaint skipped: ${err}`);
        }
      };
      switch (subcommand) {
        case "on": {
          setRuntimeLensFlagOverride("no-lsp", false);
          const persisted = persistPiLensGlobalConfigKey("lsp.enabled", true);
          repaintLspStatus();
          notifyUi(
            ctx,
            persisted
              ? "LSP enabled. Servers warm lazily on the next edit or LSP tool call (persisted as lsp.enabled=true)."
              : "LSP enabled for this session — persisting lsp.enabled to ~/.choco-pi-lsp/config.json failed.",
            "info",
          );
          return;
        }
        case "off": {
          setRuntimeLensFlagOverride("no-lsp", true);
          const persisted = persistPiLensGlobalConfigKey("lsp.enabled", false);
          resetLSPService({ fast: true, reason: "user_lsp_off" });
          repaintLspStatus();
          notifyUi(
            ctx,
            persisted
              ? "LSP disabled — language servers stopped; lsp_diagnostics/lsp_navigation report disabled. Run /lsp on to re-enable (persisted as lsp.enabled=false)."
              : "LSP disabled for this session — persisting lsp.enabled to ~/.choco-pi-lsp/config.json failed.",
            "warning",
          );
          return;
        }
        case undefined:
        case "status": {
          const disabled = getLensFlag("no-lsp") === true;
          let detail: string;
          if (disabled) {
            detail = "language servers are not started and LSP tools report disabled";
          } else {
            const { activeIds, failedIds } = selectLspStatus(
              getLSPService().getAliveServerIds(),
              getFailedLspServerIds(),
              getSessionLanguages(),
            );
            detail =
              activeIds.length > 0
                ? `LSP Active: ${activeIds.join(", ")}`
                : "LSP Inactive (no server running for this session yet)";
            if (failedIds.length > 0) {
              detail += ` · LSP Failed: ${failedIds.join(", ")}`;
            }
          }
          notifyUi(
            ctx,
            `LSP usage: ${disabled ? "off" : "on"} — ${detail}. Use /lsp on|off to change.`,
            "info",
          );
          return;
        }
        default:
          notifyUi(ctx, "Usage: /lsp on|off|status", "warning");
      }
    },
  });

  pi.registerCommand("lens-context-toggle", {
    description:
      "Toggle automatic context injection on/off for the current session (tools/LSP/read-guard/formatting stay active). Usage: /lens-context-toggle",
    handler: async (_args, ctx) => {
      activationState.contextInjectionEnabled = !activationState.contextInjectionEnabled;
      notifyUi(
        ctx,
        activationState.contextInjectionEnabled
          ? "choco-pi-lsp context injection enabled — findings will be added to the next turn."
          : "choco-pi-lsp context injection disabled — findings are still cached (diagnostics_report, /lens-health) but not added to model context.",
        activationState.contextInjectionEnabled ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("lens-widget-toggle", {
    description:
      "Show or hide the choco-pi-lsp diagnostics widget below the editor. Usage: /lens-widget-toggle",
    handler: async (_args, ctx) => {
      const nextVisible = !activationState.lensWidgetVisible;
      const mode = readExtensionMode(ctx);
      if (nextVisible && !supportsTuiWidget(mode)) {
        notifyUi(
          ctx,
          `choco-pi-lsp widget needs an interactive TUI — unavailable in "${mode}" mode.`,
          "warning",
        );
        return;
      }
      const changed = nextVisible ? mountLensWidget(ctx.ui, mode) : unmountLensWidget(ctx.ui);
      if (!changed) {
        notifyUi(ctx, "choco-pi-lsp widget is not supported by this pi version.", "warning");
        return;
      }

      activationState.lensWidgetVisible = nextVisible;
      notifyUi(
        ctx,
        activationState.lensWidgetVisible
          ? "choco-pi-lsp widget shown. Run /lens-widget-toggle to hide it."
          : "choco-pi-lsp widget hidden. Run /lens-widget-toggle to show it.",
        "info",
      );
    },
  });
}

export function registerReadGuardCommands(activation: ExtensionActivation): void {
  const { pi, runtime } = activation;
  pi.registerCommand("lens-allow-edit", {
    description: "Allow one edit to a file without a prior read. Usage: /lens-allow-edit <path>",
    handler: async (args, ctx) => {
      const [rawTarget] = normalizeCommandArgs(args);
      if (!rawTarget) {
        notifyUi(ctx, "Usage: /lens-allow-edit <path>", "warning");
        return;
      }

      const targetPath = path.isAbsolute(rawTarget)
        ? rawTarget
        : path.resolve(ctx.cwd ?? runtime.projectRoot, rawTarget);
      runtime.readGuard.addExemption(targetPath);
      notifyUi(ctx, `Read guard override armed for next edit: ${targetPath}`, "info");
    },
  });
}
