import {
  ModelSelectorComponent,
  SettingsSelectorComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { ZentuiConfig } from "./config";
import { installPrototypePatch, removePrototypePatch } from "./prototype-patch-registry";
import { EDITOR_BORDER_STYLE, renderChromeBorder, renderEditorBorder } from "./style";
import { type BoundaryValue, invokeWithReceiver, isNumber } from "./runtime-values";

type PatchableSelectorPrototype = {
  render: (width: number) => string[];
};

type Cleanup = () => void;

function patchableSelectorPrototype(value: BoundaryValue): PatchableSelectorPrototype {
  // SAFETY: both host selector prototypes implement render(width) and are used only through that method.
  return value as PatchableSelectorPrototype;
}

function stripAnsi(text: string): string {
  return text.replaceAll(new RegExp(String.raw`\x1b\[[0-9;]*m`, "g"), "");
}

function isHorizontalBorderLine(line: string): boolean {
  return /^─+$/.test(stripAnsi(line));
}

function renderBorderLine(
  width: number,
  theme: Theme | undefined,
  config: ZentuiConfig | undefined,
): string {
  const text = "─".repeat(Math.max(1, width));
  if (theme && config) {
    return renderChromeBorder(
      theme,
      config.components.selectorBorders.colorSource,
      EDITOR_BORDER_STYLE,
      text,
    );
  }
  return renderEditorBorder(text);
}

export function patchSelectorBorderStyle(
  prototype: PatchableSelectorPrototype,
  getTheme?: () => Theme | undefined,
  getConfig?: () => ZentuiConfig,
): Cleanup {
  return installPrototypePatch(
    prototype,
    "render",
    "selector-border-render",
    ({ predecessor, receiver, args }) => {
      const rendered = invokeWithReceiver(predecessor, receiver, args);
      // SAFETY: the patched host selector render method returns one string per rendered row.
      const lines = rendered as string[];
      const width = args[0];
      if (lines.length === 0 || !isNumber(width) || width <= 0) return lines;

      return lines.map((line, index) => {
        if (index !== 0 && index !== lines.length - 1) return line;
        if (!isHorizontalBorderLine(line)) return line;
        return renderBorderLine(width, getTheme?.(), getConfig?.());
      });
    },
  );
}

export function removeSelectorBorderStyle(): void {
  removePrototypePatch(ModelSelectorComponent.prototype, "render", "selector-border-render");
  removePrototypePatch(SettingsSelectorComponent.prototype, "render", "selector-border-render");
}

export function installSelectorBorderStyle(
  getTheme?: () => Theme | undefined,
  getConfig?: () => ZentuiConfig,
): Cleanup {
  const cleanupModel = patchSelectorBorderStyle(
    patchableSelectorPrototype(ModelSelectorComponent.prototype),
    getTheme,
    getConfig,
  );
  let cleanupSettings: Cleanup;
  try {
    cleanupSettings = patchSelectorBorderStyle(
      patchableSelectorPrototype(SettingsSelectorComponent.prototype),
      getTheme,
      getConfig,
    );
  } catch (error) {
    cleanupModel();
    throw error;
  }
  return () => {
    cleanupModel();
    cleanupSettings();
  };
}
