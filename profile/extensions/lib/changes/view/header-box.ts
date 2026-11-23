import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  isFunction,
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "../../runtime-values.ts";
import {
  importZentuiModule,
  isZentuiModule,
  ZENTUI_CONFIG,
  ZENTUI_MINIMALIST_EDITOR,
  type ZentuiModule,
} from "../../zentui-loader.ts";
import type { PaneStyler } from "./rows.ts";

export const HEADER_BOX_MIN_WIDTH = 30;

export const HEADER_BOX_CHROME = 4;

export type HeaderBox = {
  width: number;
  lines: string[];
  topLeft: string;
  topRight: readonly string[];
  bottomLeft: string;
  bottomRight: readonly string[];
  focused: boolean;
};

export type HeaderBoxRenderer = (box: HeaderBox) => string[] | undefined;

function labeledBorder(
  width: number,
  leftLabel: string,
  rightLabel: string,
  corners: [string, string],
  paint: (text: string) => string,
): string {
  const inner = Math.max(0, width - 2);
  let left = leftLabel;
  let right = rightLabel;
  const overhead = () => (left ? 3 : 1) + (right ? 3 : 1);
  if (visibleWidth(left) + visibleWidth(right) > inner - overhead()) {
    if (right && Math.floor((inner - overhead()) / 3) < 4) right = "";
    const budget = Math.max(0, inner - overhead());
    const rightRoom = right
      ? Math.min(visibleWidth(right), Math.max(4, Math.floor(budget / 3)))
      : 0;
    if (right) right = truncateToWidth(right, rightRoom, "…");
    const leftRoom = Math.max(0, budget - (right ? visibleWidth(right) : 0));
    left = leftRoom > 0 ? truncateToWidth(left, leftRoom, "…") : "";
  }
  const leftPart = left ? `${paint("─ ")}${left}${paint(" ")}` : paint("─");
  const rightPart = right ? `${paint(" ")}${right}${paint(" ─")}` : paint("─");
  const used = (left ? visibleWidth(left) + 3 : 1) + (right ? visibleWidth(right) + 3 : 1);
  const fill = paint("─".repeat(Math.max(0, inner - used)));
  return truncateToWidth(
    `${paint(corners[0])}${leftPart}${fill}${rightPart}${paint(corners[1])}`,
    width,
    "",
  );
}

export function themedHeaderBox(box: HeaderBox, styler: Pick<PaneStyler, "fg">): string[] {
  const paint = (text: string) => styler.fg(box.focused ? "accent" : "borderMuted", text);
  const cells = (values: readonly string[]) =>
    values.filter((value) => value.length > 0).join(paint(" – "));
  const inner = Math.max(0, box.width - HEADER_BOX_CHROME);
  const rows = box.lines.map((line) => {
    const cut = truncateToWidth(line, inner, "…");
    const padding = " ".repeat(Math.max(0, inner - visibleWidth(cut)));
    return `${paint("│")} ${cut}${padding} ${paint("│")}`;
  });
  return [
    labeledBorder(box.width, box.topLeft, cells(box.topRight), ["╭", "╮"], paint),
    ...rows,
    labeledBorder(box.width, box.bottomLeft, cells(box.bottomRight), ["╰", "╯"], paint),
  ];
}

export type HeaderBoxModules = { renderLabeledBox: RuntimeValue; loadConfig: RuntimeValue };

export type HeaderBoxLoader = () => Promise<HeaderBoxModules | undefined>;

const defaultHeaderBoxLoader: HeaderBoxLoader = async () => {
  const [editor, config] = await Promise.all([
    importZentuiModule(ZENTUI_MINIMALIST_EDITOR),
    importZentuiModule(ZENTUI_CONFIG),
  ]);
  if (!editor || !config) return undefined;
  return { renderLabeledBox: editor["renderLabeledBox"], loadConfig: config["loadConfig"] };
};

type LabeledBoxOptions = {
  width: number;
  lines: string[];
  topLeft?: string;
  topRightCells?: readonly string[];
  bottomLeft?: string;
  bottomRightCells?: readonly string[];
  uiTheme: Theme;
  config: ZentuiModule;
  borderColor?: (text: string) => string;
};

function isStringArray(value: RuntimeValue): value is string[] {
  return Array.isArray(value) && value.every((entry: RuntimeValue) => isString(entry));
}

export async function loadZentuiHeaderBox(
  theme: () => Theme,
  loader: HeaderBoxLoader = defaultHeaderBoxLoader,
): Promise<HeaderBoxRenderer | undefined> {
  let modules: HeaderBoxModules | undefined;
  try {
    modules = await loader();
  } catch {
    return undefined;
  }
  const renderLabeledBox = modules?.renderLabeledBox;
  const loadConfig = modules?.loadConfig;
  if (!isFunction(renderLabeledBox) || !isFunction(loadConfig)) return undefined;
  let config: RuntimeValue;
  try {
    config = reinterpretHostValue<() => RuntimeValue>(loadConfig)();
  } catch {
    return undefined;
  }
  if (!isZentuiModule(config)) return undefined;
  const zentuiConfig = config;
  const render =
    reinterpretHostValue<(options: LabeledBoxOptions) => RuntimeValue>(renderLabeledBox);
  return (box) => {
    try {
      const uiTheme = theme();
      const options: LabeledBoxOptions = {
        width: box.width,
        lines: box.lines,
        topLeft: box.topLeft,
        topRightCells: box.topRight,
        bottomLeft: box.bottomLeft,
        bottomRightCells: box.bottomRight,
        uiTheme,
        config: zentuiConfig,
      };
      if (box.focused) options.borderColor = (text) => uiTheme.fg("accent", text);
      const drawn = render(options);
      return isStringArray(drawn) && drawn.length === box.lines.length + 2 ? drawn : undefined;
    } catch {
      return undefined;
    }
  };
}
