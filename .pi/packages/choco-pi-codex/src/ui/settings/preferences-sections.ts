import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import {
  getCodexConversionConfigPath,
  getProjectCodexConversionConfigPath,
  hasFolderCodexConversionConfig,
  readCodexConversionConfig,
  readLayeredCodexConversionConfig,
  setProjectCodexCacheKeepalive,
  type CodexConversionConfigScope,
} from "../../adapter/activation/config-store.ts";
import type { ExecutionMode } from "../../adapter/activation/execution-mode.ts";
import { buildConfigSettings, type ConfigSetting } from "./config-items.ts";

/** Registry key the choco-pi profile reads to host Codex rows in its preferences panel. */
export const CODEX_PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.codex-preferences-provider");
export const CODEX_SECTION_ID = "codex";
export const CODEX_OUTCOME_PREFIX = "codex:";
export const CODEX_EDIT_CONFIG_OUTCOME = `${CODEX_OUTCOME_PREFIX}edit-config`;

const EXECUTION_MODE_ITEM_ID = "executionMode";
const OPEN_LABEL = "Open";

/** What the host panel does after a Codex row changed. Mirrors the panel's own section contract. */
export type CodexSectionChange =
  | { kind: "update" }
  | { kind: "rebuild" }
  | { kind: "outcome"; outcome: string };

export interface CodexPreferencesSection {
  id: string;
  label: string;
  /** When set, the rows are appended to the named host section instead of owning a tab. */
  mergeInto?: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => CodexSectionChange;
}

export interface CodexPreferencesProvider {
  buildSections: (ctx: ExtensionContext) => CodexPreferencesSection[];
  /** Runs a follow-up flow while the dialog is closed; `undefined` means the outcome is not ours. */
  runOutcome: (
    outcome: string,
    ctx: ExtensionContext,
  ) => Promise<{ section?: string; focusId?: string } | undefined>;
}

export interface CodexPreferencesDeps {
  /** Config the adapter is currently running with, layered over the project scope. */
  effectiveConfig: (ctx: ExtensionContext) => CodexConversionConfig;
  /** Persists a config in the given scope and re-applies the adapter; false when the write failed. */
  saveAndApply: (
    ctx: ExtensionContext,
    scope: CodexConversionConfigScope,
    nextConfig: CodexConversionConfig,
  ) => boolean;
  /** Re-reads the effective config and re-applies the adapter without writing. */
  applyEffectiveConfig: (ctx: ExtensionContext, previousConfig: CodexConversionConfig) => void;
  /** The adapter's live config, used as the previous value when re-applying. */
  getRunningConfig: () => CodexConversionConfig;
}

/**
 * Where each Codex row belongs in the preferences panel, by topic. A row a
 * later adapter version adds is unlisted and falls back to its own Codex tab,
 * so an upgrade never hides a setting.
 */
const CODEX_ROW_LAYOUT: ReadonlyArray<{ section: string; rows: readonly string[] }> = [
  { section: "appearance", rows: ["toolRenaming", "compactTools", "codeModeDetails"] },
  {
    section: "model",
    rows: [
      EXECUTION_MODE_ITEM_ID,
      "fast",
      "cacheKeepalive",
      "verbosity",
      "transportHeader",
      "responsesLite",
      "forceCachedWebSockets",
      "harnessIdentifierHeader",
      "compactionHeader",
      "responsesCompaction",
      "v2UserMessageRetention",
      "diagnosticsHeader",
      "cacheDiagnosticsStatus",
      "cacheDiagnosticsLog",
    ],
  },
  {
    section: "tools",
    rows: [
      "viewImageFallback",
      "webRun",
      "webSearchModel",
      "imageGeneration",
      "activateOnlyHeader",
      "applyPatchOnly",
      "viewImageOnly",
      "webRunOnly",
      "imageGenerationOnly",
      "customRustBinariesHelp",
      "customRustBinariesPath",
    ],
  },
  { section: "agent", rows: ["additionalProviders", "editConfig"] },
];

/**
 * Marks where the Codex rows begin inside a section it shares with choco-ui or
 * Pi rows, so the merged list still says which system stores the value.
 */
function sourceHeader(section: string, theme: Theme): SettingItem {
  return { id: `codexSourceHeader:${section}`, label: theme.fg("dim", "Codex"), currentValue: "" };
}

/**
 * Restates the Edit config row for this panel. `/codex` handed the file to
 * `$EDITOR` and reported when none was configured; here the document opens in
 * Pi's own editor, so the row is always available and never asks for a reload.
 */
function withInPlaceEditor(setting: ConfigSetting, path: string): ConfigSetting {
  return {
    ...setting,
    item: {
      ...setting.item,
      description: `Edit ${path} as JSON.`,
      currentValue: OPEN_LABEL,
      values: [OPEN_LABEL],
    },
  };
}

/**
 * Spreads every row `/codex` showed across its General, Tools, OpenAI, Display,
 * and About tabs over the preferences panel by topic. All sections share one
 * draft and one scope, so a change made on any tab writes the same document.
 *
 * The Usage tab is deliberately left out: the host dialog already reports Codex
 * usage on its own Usage tab.
 */
export function buildCodexPreferencesSections(
  ctx: ExtensionContext,
  deps: CodexPreferencesDeps,
): CodexPreferencesSection[] {
  /**
   * Rows write to the project document when the project already has one, and to
   * the global defaults otherwise. The panel offers no scope switch: a project
   * that wants its own file creates it, and every other project stays global.
   */
  const scope: CodexConversionConfigScope = hasFolderCodexConversionConfig(
    ctx.cwd,
    ctx.isProjectTrusted(),
  )
    ? "folder"
    : "global";

  const scopePath = (): string =>
    scope === "folder"
      ? getProjectCodexConversionConfigPath(ctx.cwd)
      : getCodexConversionConfigPath();

  /**
   * The config the rows edit. The folder scope is read layered so a project file
   * that overrides only a few keys still shows complete rows, while the runtime
   * value of `cacheKeepalive` always comes from the effective config because it
   * is stored per project rather than in the edited document.
   */
  const readDraft = (): CodexConversionConfig => {
    const selected =
      scope === "folder"
        ? readLayeredCodexConversionConfig({ cwd: ctx.cwd, projectTrusted: true })
        : readCodexConversionConfig();
    return {
      ...selected,
      openai: {
        ...selected.openai,
        cacheKeepalive: deps.effectiveConfig(ctx).openai.cacheKeepalive,
      },
    };
  };

  let draft = readDraft();

  const buildSettings = (): ConfigSetting[] => {
    const theme = ctx.ui.theme;
    return [
      {
        item: {
          id: EXECUTION_MODE_ITEM_ID,
          label: "Execution mode",
          currentValue: draft.executionMode,
          values: ["normal", "code"],
        },
        update: (value: string, current: CodexConversionConfig) => ({
          ...current,
          // SAFETY: This selector emits only the adjacent "normal" and "code" values.
          executionMode: value as ExecutionMode,
        }),
      },
      ...buildConfigSettings("adapter", draft, theme, scopePath()).map((setting) =>
        setting.action === "edit-config" ? withInPlaceEditor(setting, scopePath()) : setting,
      ),
      ...buildConfigSettings("tools", draft, theme, scopePath()),
      ...buildConfigSettings("openai", draft, theme, scopePath()),
      ...buildConfigSettings("display", draft, theme, scopePath()),
    ];
  };

  const handleChange = (id: string, newValue: string): CodexSectionChange => {
    const definition = buildSettings().find(({ item }) => item.id === id);
    if (definition?.action === "edit-config") {
      return { kind: "outcome", outcome: CODEX_EDIT_CONFIG_OUTCOME };
    }
    if (definition?.action === "project-cache-keepalive") {
      const previousConfig = deps.getRunningConfig();
      const result = setProjectCodexCacheKeepalive(
        ctx.cwd,
        ctx.isProjectTrusted(),
        newValue === "on",
      );
      if (result.ok) deps.applyEffectiveConfig(ctx, previousConfig);
      else ctx.ui.notify(`Failed to save project cache keepalive: ${result.error}`, "error");
      draft = readDraft();
      return { kind: "rebuild" };
    }
    if (!definition?.update) return { kind: "update" };

    const nextConfig = definition.update(newValue, draft);
    deps.saveAndApply(ctx, scope, nextConfig);
    draft = readDraft();
    return { kind: "rebuild" };
  };

  const rowsFor = (section: string): SettingItem[] => {
    draft = readDraft();
    const wanted = CODEX_ROW_LAYOUT.find((entry) => entry.section === section)?.rows ?? [];
    const byId = new Map(buildSettings().map(({ item }) => [item.id, item]));
    const placed: SettingItem[] = [];
    for (const id of wanted) {
      const item = byId.get(id);
      if (item) placed.push(item);
    }
    return placed.length > 0 ? [sourceHeader(section, ctx.ui.theme), ...placed] : [];
  };

  const unclaimedRows = (): SettingItem[] => {
    draft = readDraft();
    const claimed = new Set(CODEX_ROW_LAYOUT.flatMap((entry) => entry.rows));
    return buildSettings()
      .map(({ item }) => item)
      .filter((item) => !claimed.has(item.id));
  };

  const merged = CODEX_ROW_LAYOUT.map(({ section }) => ({
    id: `${CODEX_SECTION_ID}:${section}`,
    label: "Codex",
    mergeInto: section,
    buildItems: () => rowsFor(section),
    handleChange,
  }));

  const fallback: CodexPreferencesSection = {
    id: CODEX_SECTION_ID,
    label: "Codex",
    buildItems: unclaimedRows,
    handleChange,
  };

  return [...merged, ...(unclaimedRows().length > 0 ? [fallback] : [])];
}

/**
 * Edits the active Codex config document in Pi's own multi-line editor. This
 * replaces the `$EDITOR` hand-off `/codex` used, which cannot run while the host
 * dialog owns the terminal.
 */
async function runEditConfigOutcome(
  ctx: ExtensionContext,
  deps: CodexPreferencesDeps,
): Promise<void> {
  const scope: CodexConversionConfigScope = hasFolderCodexConversionConfig(
    ctx.cwd,
    ctx.isProjectTrusted(),
  )
    ? "folder"
    : "global";
  const filePath =
    scope === "folder"
      ? getProjectCodexConversionConfigPath(ctx.cwd)
      : getCodexConversionConfigPath();
  let current: string;
  try {
    current = readFileSync(filePath, "utf8");
  } catch {
    current = `${JSON.stringify(readCodexConversionConfig(filePath), null, 2)}\n`;
  }
  const edited = await ctx.ui.editor(`Codex settings (${filePath})`, current);
  if (edited === undefined) {
    ctx.ui.notify("Codex settings unchanged (edit canceled)", "info");
    return;
  }
  try {
    JSON.parse(edited);
  } catch (error) {
    ctx.ui.notify(
      `Codex settings not saved, the document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  try {
    writeFileSync(filePath, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8");
  } catch (error) {
    ctx.ui.notify(
      `Could not write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  if (deps.saveAndApply(ctx, scope, readCodexConversionConfig(filePath))) {
    ctx.ui.notify("Codex settings saved", "info");
  }
}

/**
 * Publishes the Codex rows on the global registry so the choco-pi profile can host
 * them as a section of its settings dialog. The package registers no command for
 * them; without the profile host the sections are simply unused.
 */
export function registerCodexPreferencesProvider(deps: CodexPreferencesDeps): void {
  const provider: CodexPreferencesProvider = {
    buildSections: (ctx) => buildCodexPreferencesSections(ctx, deps),
    runOutcome: async (outcome, ctx) => {
      if (outcome !== CODEX_EDIT_CONFIG_OUTCOME) return undefined;
      await runEditConfigOutcome(ctx, deps);
      return { section: "agent", focusId: "editConfig" };
    },
  };
  Object.defineProperty(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL, {
    configurable: true,
    writable: true,
    value: provider,
  });
}
