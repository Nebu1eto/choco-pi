import { propertiesWhen } from "../../lib/runtime-values.ts";
import {
  isBoolean,
  isFunction,
  isObject,
  isString,
  type RuntimeValue,
} from "../../lib/runtime-values.ts";
/**
 * Optional zentui chrome for the review view's input editors.
 *
 * pi-tui's `Editor` keeps every editing behaviour and renders its own two rule
 * rows around the text. zentui exposes its editor decoration as pure functions,
 * so this adapter hands them the text rows and lets zentui draw the chrome
 * instead: the input looks like the prompt the user types into for the rest of
 * the session.
 *
 * zentui decorates the session prompt in the style the user configured, so this
 * adapter follows the same setting. `opencode` and `opencode-copy-friendly` go
 * through `renderPolishedEditorFrame`, which draws the rails and the model,
 * provider, and thinking row under the text; `minimalist` goes through
 * `renderMinimalistFrame`, which draws a box with the same labels on its
 * borders. The review passes the chat's model and effort so those labels read
 * the same way the main prompt's do.
 *
 * An open completion list is passed separately. zentui draws it inside the
 * frame through its own `renderFramedAutocompleteRows`, below the text and
 * above the closing border, which is where the prompt shows it.
 *
 * zentui is an optional package. Missing installation, changed exports, an
 * unreadable config, or a throwing renderer all degrade to the unframed editor,
 * with the completion rows kept below it exactly as pi-tui emitted them.
 * A zentui too old to export the polished renderer keeps the boxed frame.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseEditorRule } from "./review-input.ts";

/** Model and effort the metadata row names, as the review knows them. */
export type FrameModel = {
  /** Model id without its provider, e.g. `claude-opus-5`. */
  label: string;
  /** Raw provider id, e.g. `anthropic`; zentui prints its display name. */
  provider?: string;
  thinkingLevel?: string;
};

export type FrameOptions = {
  width: number;
  /** Raw `Editor.render()` output, including the rule row above and below the text. */
  editorLines: string[];
  /** Completion rows to draw inside the frame. Empty or absent when no list is open. */
  autocompleteLines?: string[];
  /** Working directory the frame labels; the review root of the diff being read. */
  cwd: string;
  uiTheme: Theme;
  /** Omitted while no session backs the input; the row then names no model. */
  model?: FrameModel;
};

export type ZentuiFrameAdapter = {
  /** True when zentui loaded and its config could be read. */
  available: boolean;
  /** Width to render the editor at, leaving room for the frame's side borders. */
  editorWidth(fullWidth: number): number;
  /** Reframe editor lines. Returns them unchanged whenever framing is not possible. */
  frame(options: FrameOptions): string[];
};

/** Loader type for dependency injection in tests. */
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

/** zentui's editor metadata fields, as `renderPolishedEditorFrame` reads them. */
type PolishedEditorMeta = {
  modelLabel: string;
  modelId?: string;
  modelName?: string;
  providerLabel: string;
  sessionName?: string;
};

/**
 * zentui's shape as this adapter uses it. It is declared locally and checked at
 * runtime: zentui's own sources are never part of this project's type program.
 */
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
  /** Absent in a zentui older than the polished frame export. */
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
  /** Turns a provider id into the display name the prompt shows. */
  formatProviderLabel?: (provider: string | undefined) => string;
};

/** Frame border consumes 4 columns (│ plus a space on each side). */
export const FRAME_BORDER_WIDTH = 4;
/**
 * The frame emits a top and a bottom border row. They replace the two rule rows
 * pi-tui's `Editor` already renders, so framing costs no extra terminal rows.
 * An open completion list adds one separator row on top of its own rows; the
 * view measures the rendered result rather than assuming a fixed height.
 */
export const FRAME_BORDER_ROWS = 2;

const ZENTUI_PACKAGES = ["choco-pi-ui", "pi-choco-ui", "pi-zentui"];
const ZENTUI_MINIMALIST_EDITOR = "extensions/zentui/minimalist-editor.ts";
const ZENTUI_CONFIG = "extensions/zentui/config.ts";
const ZENTUI_UI = "extensions/zentui/ui.ts";
const ZENTUI_FORMAT = "extensions/zentui/format.ts";

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null;
}

function isStringArray(value: RuntimeValue): value is string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry));
}

/** What the view would have shown with no zentui at all. */
function unframed(options: FrameOptions): string[] {
  return options.autocompleteLines?.length
    ? [...options.editorLines, ...options.autocompleteLines]
    : options.editorLines;
}

/**
 * Bases to resolve zentui from, in Node's own resolution order. The module's own
 * location comes first, which covers a plain dependency. Pi installs extension
 * packages under `<pi home>/npm/node_modules`, which is not on the lookup path of
 * a file in `<pi home>/extensions`, so every ancestor's `npm/` root follows.
 */
function resolutionBases(): string[] {
  const self = fileURLToPath(import.meta.url);
  const bases = [self];
  let directory = dirname(self);
  for (;;) {
    bases.push(join(directory, "npm", "package.json"));
    const parent = dirname(directory);
    if (parent === directory) return bases;
    directory = parent;
  }
}

/**
 * Directories a fork pinned by path can sit in. A `./packages/choco-pi-ui`
 * entry in Pi's settings is loaded from that directory and never installed
 * under the package name, so name resolution alone would miss the very copy
 * the session is running. The former `pi-choco-ui` and upstream `pi-zentui`
 * names stay as migration fallbacks.
 */
function localForkCandidates(subpath: string): string[] {
  const candidates: string[] = [];
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const pkg of ZENTUI_PACKAGES) {
      candidates.push(join(directory, "packages", pkg, subpath));
    }
    const parent = dirname(directory);
    if (parent === directory) return candidates;
    directory = parent;
  }
}

/** Locate one zentui source file, whether it is installed or pinned by path. */
export function resolveZentuiFile(subpath: string): string | undefined {
  // A path-pinned fork is the copy the session actually loads, so it wins
  // over any npm-installed namesake left in an ancestor's node_modules.
  for (const candidate of localForkCandidates(subpath)) {
    if (existsSync(candidate)) return candidate;
  }
  for (const pkg of ZENTUI_PACKAGES) {
    const specifier = `${pkg}/${subpath}`;
    for (const base of resolutionBases()) {
      try {
        return createRequire(base).resolve(specifier);
      } catch {
        // Not installed relative to this base; try the next one.
      }
    }
  }
  return undefined;
}

/**
 * Import through a specifier built at runtime. A string literal would make
 * TypeScript resolve zentui's sources into this project's program, where their
 * extensionless relative imports fail node16 module resolution.
 */
async function importAtRuntime(path: string): Promise<RuntimeValue> {
  const specifier = pathToFileURL(path).href;
  return await import(specifier);
}

/** Accept a candidate only when it still has the exports this adapter calls. */
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

/** Import a zentui module, treating an absent or unloadable file as absent. */
async function importOptional(subpath: string): Promise<Record<string, RuntimeValue> | undefined> {
  const path = resolveZentuiFile(subpath);
  if (!path) return undefined;
  try {
    const loaded = await importAtRuntime(path);
    return isRecord(loaded) ? loaded : undefined;
  } catch {
    return undefined;
  }
}

const defaultLoader: ZentuiLoader = async () => {
  const editorPath = resolveZentuiFile(ZENTUI_MINIMALIST_EDITOR);
  const configPath = resolveZentuiFile(ZENTUI_CONFIG);
  if (!editorPath || !configPath) return undefined;
  const [editor, config, ui, format] = await Promise.all([
    importAtRuntime(editorPath),
    importAtRuntime(configPath),
    importOptional(ZENTUI_UI),
    importOptional(ZENTUI_FORMAT),
  ]);
  if (!isRecord(editor) || !isRecord(config)) return undefined;
  return validateModules({
    renderMinimalistFrame: editor["renderMinimalistFrame"],
    loadConfig: config["loadConfig"],
    renderPolishedEditorFrame: ui?.["renderPolishedEditorFrame"],
    formatProviderLabel: format?.["formatProviderLabel"],
  });
};

/** The editor section of a zentui config, or an empty record when absent. */
function editorConfig(config: ZentuiConfig): Record<string, RuntimeValue> {
  const components = config["components"];
  const editor = isRecord(components) ? components["editor"] : undefined;
  return isRecord(editor) ? editor : {};
}

/**
 * The style zentui decorates the session prompt with. `opencode` is zentui's
 * own default, so an absent setting must decorate the review the same way.
 */
function editorStyle(config: ZentuiConfig): string {
  const style = editorConfig(config)["style"];
  return isString(style) ? style : "opencode";
}

/**
 * Columns the polished styles spend on chrome left of the text: the rail icon
 * plus its trailing space, or the prompt icon for the copy-friendly style,
 * which moves the rail below the text and prefixes the first row instead.
 */
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

/** Honour the user's zentui setting for the "↑ n more" labels; default on. */
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
    // Injected loaders are validated too: the shape is checked, never trusted.
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
  // The polished styles are how zentui decorates the session prompt unless the
  // user chose the box, so they are what the review must reproduce. A zentui
  // without that export can still draw the box.
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
          // Empty: zentui reads this only to flag its shell mode, which
          // a review comment box does not have.
          inputText: "",
          // The review root is both the directory shown and the project
          // the diff belongs to, so every path style resolves to it.
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
