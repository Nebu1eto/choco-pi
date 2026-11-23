import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export const CODEX_PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.codex-preferences-provider");
export const CODEX_SECTION_ID = "codex";
export const CODEX_OUTCOME_PREFIX = "codex:";
export const CODEX_EDIT_CONFIG_OUTCOME = `${CODEX_OUTCOME_PREFIX}edit-config`;

const EXECUTION_MODE_ITEM_ID = "executionMode";
const OPEN_LABEL = "Open";

export type CodexSectionChange =
  | { kind: "update" }
  | { kind: "rebuild" }
  | { kind: "outcome"; outcome: string };

export interface CodexPreferencesSection {
  id: string;
  label: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => CodexSectionChange;
}

export interface CodexPreferencesProvider {
  buildSections: (ctx: ExtensionContext) => CodexPreferencesSection[];
  runOutcome: (
    outcome: string,
    ctx: ExtensionContext,
  ) => Promise<{ section?: string; focusId?: string } | undefined>;
}

export interface CodexPreferencesDeps {
  effectiveConfig: (ctx: ExtensionContext) => CodexConversionConfig;
  saveAndApply: (
    ctx: ExtensionContext,
    scope: CodexConversionConfigScope,
    nextConfig: CodexConversionConfig,
  ) => boolean;
  applyEffectiveConfig: (ctx: ExtensionContext, previousConfig: CodexConversionConfig) => void;
  getRunningConfig: () => CodexConversionConfig;
}

const SCREEN_HEADER_ROW_IDS: ReadonlySet<string> = new Set([
  "transportHeader",
  "compactionHeader",
  "diagnosticsHeader",
  "activateOnlyHeader",
]);

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

export function buildCodexPreferencesSections(
  ctx: ExtensionContext,
  deps: CodexPreferencesDeps,
): CodexPreferencesSection[] {
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

  const rows = (): SettingItem[] => {
    draft = readDraft();
    return buildSettings()
      .map(({ item }) => item)
      .filter((item) => !SCREEN_HEADER_ROW_IDS.has(item.id));
  };

  return [{ id: CODEX_SECTION_ID, label: "Codex", buildItems: rows, handleChange }];
}

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

export function registerCodexPreferencesProvider(deps: CodexPreferencesDeps): void {
  const provider: CodexPreferencesProvider = {
    buildSections: (ctx) => buildCodexPreferencesSections(ctx, deps),
    runOutcome: async (outcome, ctx) => {
      if (outcome !== CODEX_EDIT_CONFIG_OUTCOME) return undefined;
      await runEditConfigOutcome(ctx, deps);
      return { section: CODEX_SECTION_ID, focusId: "editConfig" };
    },
  };
  Object.defineProperty(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL, {
    configurable: true,
    writable: true,
    value: provider,
  });
}
