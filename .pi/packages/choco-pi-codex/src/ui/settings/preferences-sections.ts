import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import {
  clearFolderCodexConversionConfig,
  getCodexConversionConfigPath,
  getProjectCodexConversionConfigPath,
  hasFolderCodexConversionConfig,
  materializeFolderCodexConversionConfig,
  readCodexConversionConfig,
  readLayeredCodexConversionConfig,
  setProjectCodexCacheKeepalive,
  type CodexConversionConfigScope,
} from "../../adapter/activation/config-store.ts";
import type { ExecutionMode } from "../../adapter/activation/execution-mode.ts";
import { buildConfigSettings, type ConfigSetting } from "./config-items.ts";
import { CHANGELOG_URL, DISCORD_URL, GITHUB_URL, ISSUE_URL, openExternalUrl } from "./links.ts";

/** Registry key the choco-pi profile reads to host Codex rows in its preferences panel. */
export const CODEX_PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.codex-preferences-provider");
export const CODEX_SECTION_ID = "codex";
export const CODEX_OUTCOME_PREFIX = "codex:";
export const CODEX_EDIT_CONFIG_OUTCOME = `${CODEX_OUTCOME_PREFIX}edit-config`;

const SCOPE_ITEM_ID = "codexConfigScope";
const EXECUTION_MODE_ITEM_ID = "executionMode";
const DEFAULTS_LABEL = "Defaults";
const PROJECT_LABEL = "Project";
const OPEN_LABEL = "Open";

const ABOUT_LINKS: ReadonlyArray<{ id: string; label: string; url: string; message: string }> = [
  { id: "codexAboutGithub", label: "GitHub", url: GITHUB_URL, message: "Opened GitHub" },
  {
    id: "codexAboutChangelog",
    label: "Changelog",
    url: CHANGELOG_URL,
    message: "Opened changelog",
  },
  { id: "codexAboutDiscord", label: "Discord", url: DISCORD_URL, message: "Opened Discord" },
  { id: "codexAboutIssue", label: "Report an issue", url: ISSUE_URL, message: "Opened issue form" },
];

/** What the host panel does after a Codex row changed. Mirrors the panel's own section contract. */
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

function headerItem(id: string, label: string, theme: Theme): SettingItem {
  return { id, label: theme.fg("dim", label), currentValue: "" };
}

function scopeLabel(scope: CodexConversionConfigScope): string {
  return scope === "folder" ? PROJECT_LABEL : DEFAULTS_LABEL;
}

/**
 * Builds the Codex section of the preferences panel: every row `/codex` showed
 * across its General, Tools, OpenAI, Display, and About tabs, flattened into one
 * scrollable list with dim group headers.
 *
 * The Usage tab is deliberately left out: the host dialog already reports Codex
 * usage on its own Usage tab.
 */
export function buildCodexPreferencesSection(
  ctx: ExtensionContext,
  deps: CodexPreferencesDeps,
): CodexPreferencesSection {
  let scope: CodexConversionConfigScope = hasFolderCodexConversionConfig(
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
          id: SCOPE_ITEM_ID,
          label: "Settings",
          description:
            scope === "folder"
              ? "Changes update this project only and leave global defaults unchanged."
              : "Changes update global defaults. Projects with their own .pi/choco-pi-codex.json keep their settings.",
          currentValue: scopeLabel(scope),
          values: ctx.isProjectTrusted() ? [DEFAULTS_LABEL, PROJECT_LABEL] : [DEFAULTS_LABEL],
        },
      },
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
      ...buildConfigSettings("adapter", draft, theme, scopePath()),
      { item: headerItem("codexToolsHeader", "Tools", theme) },
      ...buildConfigSettings("tools", draft, theme, scopePath()),
      { item: headerItem("codexOpenAIHeader", "OpenAI", theme) },
      ...buildConfigSettings("openai", draft, theme, scopePath()),
      { item: headerItem("codexDisplayHeader", "Display", theme) },
      ...buildConfigSettings("display", draft, theme, scopePath()),
      { item: headerItem("codexAboutHeader", "About", theme) },
      ...ABOUT_LINKS.map(({ id, label, url }) => ({
        item: {
          id,
          label,
          description: url,
          currentValue: OPEN_LABEL,
          values: [OPEN_LABEL],
        },
      })),
    ];
  };

  const changeScope = (value: string): CodexSectionChange => {
    const next: CodexConversionConfigScope = value === PROJECT_LABEL ? "folder" : "global";
    if (next === scope) return { kind: "rebuild" };
    const previousConfig = deps.getRunningConfig();
    const result =
      next === "folder"
        ? materializeFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted())
        : clearFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted());
    if (!result.ok) {
      ctx.ui.notify(`Could not change Codex settings scope: ${result.error}`, "error");
      return { kind: "rebuild" };
    }
    scope = next;
    deps.applyEffectiveConfig(ctx, previousConfig);
    draft = readDraft();
    return { kind: "rebuild" };
  };

  return {
    id: CODEX_SECTION_ID,
    label: "Codex",
    buildItems(): SettingItem[] {
      draft = readDraft();
      return buildSettings().map(({ item }) => item);
    },
    handleChange(id, newValue): CodexSectionChange {
      if (id === SCOPE_ITEM_ID) return changeScope(newValue);

      const link = ABOUT_LINKS.find((candidate) => candidate.id === id);
      if (link) {
        openExternalUrl(link.url);
        ctx.ui.notify(link.message, "info");
        return { kind: "update" };
      }

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
    },
  };
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
    buildSections: (ctx) => [buildCodexPreferencesSection(ctx, deps)],
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
