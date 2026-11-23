import { propertiesWhen } from "../../lib/runtime-values.ts";
import {
  isBoolean,
  isFunction,
  isObject,
  isString,
  type RuntimeValue,
} from "../../lib/runtime-values.ts";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  importAtRuntime,
  importZentuiModule,
  resolveZentuiFile,
  ZENTUI_CONFIG,
  ZENTUI_FORMAT,
  ZENTUI_MINIMALIST_EDITOR,
  ZENTUI_UI,
} from "../../lib/zentui-loader.ts";
import { parseEditorRule } from "./review-input.ts";

export { resolveZentuiFile };

export type FrameModel = {
  label: string;
  provider?: string;
  thinkingLevel?: string;
};

export type FrameOptions = {
  width: number;
  editorLines: string[];
  autocompleteLines?: string[];
  cwd: string;
  uiTheme: Theme;
  model?: FrameModel;
};

export type ZentuiFrameAdapter = {
  available: boolean;
  editorWidth(fullWidth: number): number;
  frame(options: FrameOptions): string[];
};

export type ZentuiLoader = () => Promise<ZentuiModules | undefined>;

type MinimalistEditorMetadata = {
  cwd: string;
  projectRoot?: string;
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  costLabel?: string;
  modelLabel?: string;
  thinkingLevel?: string;
  contextPercent?: number;
  contextWindow?: number;
  sessionName?: string;
  agentDurationMs?: number;
  agentActive?: boolean;
};

type ZentuiConfig = Record<string, RuntimeValue>;

type PolishedEditorMeta = {
  modelLabel: string;
  modelId?: string;
  modelName?: string;
  providerLabel: string;
  sessionName?: string;
};

export type ZentuiModules = {
  renderMinimalistFrame: (options: {
    width: number;
    editorLines: string[];
    autocompleteLines?: string[];
    viewport?: { above?: string; below?: string };
    inputText: string;
    metadata: MinimalistEditorMetadata;
    uiTheme: Theme;
    config: ZentuiConfig;
  }) => string[];
  loadConfig: () => ZentuiConfig;
  renderPolishedEditorFrame?: (options: {
    width: number;
    editorLines: string[];
    autocompleteLines?: string[];
    viewport?: { above?: string; below?: string };
    uiTheme: Theme;
    config: ZentuiConfig;
    modelMeta: PolishedEditorMeta;
    thinkingLevel?: string;
  }) => string[];
  formatProviderLabel?: (provider: string | undefined) => string;
};

export const FRAME_BORDER_WIDTH = 4;
export const FRAME_BORDER_ROWS = 2;

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null;
}

function isStringArray(value: RuntimeValue): value is string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry));
}

function unframed(options: FrameOptions): string[] {
  return options.autocompleteLines?.length
    ? [...options.editorLines, ...options.autocompleteLines]
    : options.editorLines;
}

function validateModules(candidate: RuntimeValue): ZentuiModules | undefined {
  if (!isRecord(candidate)) return undefined;
  const renderMinimalistFrame = candidate["renderMinimalistFrame"];
  const loadConfig = candidate["loadConfig"];
  if (!isFunction(renderMinimalistFrame) || !isFunction(loadConfig)) {
    return undefined;
  }
  const renderPolishedEditorFrame = candidate["renderPolishedEditorFrame"];
  const formatProviderLabel = candidate["formatProviderLabel"];
  return {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    renderMinimalistFrame: renderMinimalistFrame as ZentuiModules["renderMinimalistFrame"],
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    loadConfig: loadConfig as ZentuiModules["loadConfig"],
    ...propertiesWhen(isFunction(renderPolishedEditorFrame), () => ({
      // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      renderPolishedEditorFrame: renderPolishedEditorFrame as NonNullable<
        ZentuiModules["renderPolishedEditorFrame"]
      >,
    })),
    ...propertiesWhen(isFunction(formatProviderLabel), () => ({
      // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      formatProviderLabel: formatProviderLabel as NonNullable<ZentuiModules["formatProviderLabel"]>,
    })),
  };
}

const defaultLoader: ZentuiLoader = async () => {
  const [editorPath, configPath] = await Promise.all([
    resolveZentuiFile(ZENTUI_MINIMALIST_EDITOR),
    resolveZentuiFile(ZENTUI_CONFIG),
  ]);
  if (!editorPath || !configPath) return undefined;
  const [editor, config, ui, format] = await Promise.all([
    importAtRuntime(editorPath),
    importAtRuntime(configPath),
    importZentuiModule(ZENTUI_UI),
    importZentuiModule(ZENTUI_FORMAT),
  ]);
  if (!isRecord(editor) || !isRecord(config)) return undefined;
  return validateModules({
    renderMinimalistFrame: editor["renderMinimalistFrame"],
    loadConfig: config["loadConfig"],
    renderPolishedEditorFrame: ui?.["renderPolishedEditorFrame"],
    formatProviderLabel: format?.["formatProviderLabel"],
  });
};

function editorConfig(config: ZentuiConfig): Record<string, RuntimeValue> {
  const components = config["components"];
  const editor = isRecord(components) ? components["editor"] : undefined;
  return isRecord(editor) ? editor : {};
}

function editorStyle(config: ZentuiConfig): string {
  const style = editorConfig(config)["style"];
  return isString(style) ? style : "opencode";
}

function polishedRailWidth(config: ZentuiConfig): number {
  const icons = config["icons"];
  const icon = (name: string): string => {
    const value = isRecord(icons) ? icons[name] : undefined;
    return isString(value) ? value : "";
  };
  if (editorStyle(config) === "opencode-copy-friendly") {
    const prompt = icon("editorPrompt");
    return prompt ? visibleWidth(prompt) + 1 : 0;
  }
  return visibleWidth(icon("rail")) + 1;
}

function viewportIndicatorsEnabled(config: ZentuiConfig): boolean {
  const enabled = editorConfig(config)["viewportIndicators"];
  return isBoolean(enabled) ? enabled : true;
}

function createFallbackAdapter(): ZentuiFrameAdapter {
  return {
    available: false,
    editorWidth: (width) => width,
    frame: unframed,
  };
}

export async function createZentuiFrameAdapter(
  loader: ZentuiLoader = defaultLoader,
): Promise<ZentuiFrameAdapter> {
  let zentui: ZentuiModules | undefined;
  let config: ZentuiConfig;
  try {
    zentui = validateModules(await loader());
  } catch {
    return createFallbackAdapter();
  }
  if (!zentui) return createFallbackAdapter();
  try {
    const loaded = zentui.loadConfig();
    if (!isRecord(loaded)) return createFallbackAdapter();
    config = loaded;
  } catch {
    return createFallbackAdapter();
  }
  const viewportIndicators = viewportIndicatorsEnabled(config);
  const modules = zentui;
  const polished =
    editorStyle(config) !== "minimalist" && modules.renderPolishedEditorFrame
      ? { render: modules.renderPolishedEditorFrame, railWidth: polishedRailWidth(config) }
      : undefined;

  return {
    available: true,
    editorWidth: (width) => {
      const chrome = polished ? polished.railWidth : FRAME_BORDER_WIDTH;
      return width > chrome ? width - chrome : width;
    },
    frame: (options) => {
      const { width, editorLines, autocompleteLines, cwd, uiTheme, model } = options;
      if (width <= FRAME_BORDER_WIDTH || editorLines.length < FRAME_BORDER_ROWS) {
        return unframed(options);
      }
      const above = parseEditorRule(editorLines[0], "above");
      const below = parseEditorRule(editorLines.at(-1), "below");
      if (!above || !below) return unframed(options);
      const viewport = viewportIndicators
        ? {
            ...propertiesWhen(above.count, () => ({ above: above.count })),
            ...propertiesWhen(below.count, () => ({ below: below.count })),
          }
        : {};
      const text = editorLines.slice(1, -1);
      try {
        if (polished) {
          const framed = polished.render({
            width,
            editorLines: text,
            ...propertiesWhen(autocompleteLines?.length, () => ({ autocompleteLines })),
            ...propertiesWhen(above.count || below.count, () => ({ viewport })),
            uiTheme,
            config,
            modelMeta: {
              modelLabel: model?.label ?? "",
              ...propertiesWhen(model?.label, () => ({
                modelId: model!.label,
                modelName: model!.label,
              })),
              providerLabel: model?.provider
                ? (modules.formatProviderLabel?.(model.provider) ?? model.provider)
                : "",
            },
            ...propertiesWhen(model?.thinkingLevel, () => ({
              thinkingLevel: model!.thinkingLevel,
            })),
          });
          return isStringArray(framed) && framed.length > 0 ? framed : unframed(options);
        }
        const framed = modules.renderMinimalistFrame({
          width,
          editorLines: text,
          ...propertiesWhen(autocompleteLines?.length, () => ({ autocompleteLines })),
          ...propertiesWhen(above.count || below.count, () => ({ viewport })),
          inputText: "",
          metadata: {
            cwd,
            projectRoot: cwd,
            ...propertiesWhen(model?.label, () => ({ modelLabel: model!.label })),
            ...propertiesWhen(model?.thinkingLevel, () => ({
              thinkingLevel: model!.thinkingLevel,
            })),
          },
          uiTheme,
          config,
        });
        return isStringArray(framed) && framed.length > 0 ? framed : unframed(options);
      } catch {
        return unframed(options);
      }
    },
  };
}
