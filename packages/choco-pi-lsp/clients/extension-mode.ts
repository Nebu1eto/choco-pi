export type ExtensionRunMode = "tui" | "rpc" | "json" | "print" | "unknown";

const ExtensionModeContextSchema = obj({ mode: str() }, { open: true });
const isExtensionModeContext = compile(ExtensionModeContextSchema).check;

export function readExtensionMode<T>(ctx: T): ExtensionRunMode {
  try {
    if (!isExtensionModeContext(ctx)) return "unknown";
    switch (ctx.mode) {
      case "tui":
      case "rpc":
      case "json":
      case "print":
        return ctx.mode;
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

export function supportsTuiWidget(mode: ExtensionRunMode): boolean {
  return mode === "tui" || mode === "unknown";
}

export function suppressesUserNotify(mode: ExtensionRunMode): boolean {
  return mode === "print" || mode === "json";
}

export function modeSuppressionNote(mode: ExtensionRunMode): string {
  return `suppressed in "${mode}" mode (no interactive TUI)`;
}
import { compile, obj, str } from "@earendil-works/pi-schema";
