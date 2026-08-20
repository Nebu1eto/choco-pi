/**
 * Settings command for the example extension.
 *
 * Demonstrates:
 * - Multiple sections with different item types
 * - Simple toggle items (on/off, boolean)
 * - Enum items (cycle through values)
 * - Numeric items (cycle through string representations)
 * - Submenu items with ArrayEditor (string arrays)
 * - Submenu items with PathArrayEditor (filesystem paths + tab completion)
 * - Submenu items with FuzzySelector (single-select from large list)
 * - Submenu items with SettingsDetailEditor (focused second-level panel)
 * - Array-of-objects editing pattern using nested SettingsDetailEditor panels
 * - Custom onSettingChange handler for non-string values
 * - onSave callback for reloading runtime state
 */

import {
  ArrayEditor,
  FuzzySelector,
  PathArrayEditor,
  registerSettingsCommand,
  SettingsDetailEditor,
} from "@aliou/pi-utils-settings";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  configLoader,
  type ExampleConfig,
  type ResolvedExampleConfig,
} from "../config";

const AVAILABLE_THEMES = [
  "dark",
  "light",
  "solarized-dark",
  "solarized-light",
  "monokai",
  "nord",
  "dracula",
  "gruvbox",
  "catppuccin",
  "tokyo-night",
];

export function registerExampleSettings(pi: ExtensionAPI): void {
  registerSettingsCommand<ExampleConfig, ResolvedExampleConfig>(pi, {
    commandName: "example:settings",
    commandDescription: "Configure example extension settings",
    title: "Example Settings",
    configStore: configLoader,

    // --- Build sections ---
    // Called on initial render, tab switch, and after save.
    // tabConfig is the raw config for the active scope (null if empty).
    // resolved is the fully merged config with defaults applied.
    buildSections: (tabConfig, resolved, ctx) => {
      // Read values: prefer tab-specific draft, fall back to resolved.
      const theme = tabConfig?.appearance?.theme ?? resolved.appearance.theme;
      const fontSize =
        tabConfig?.appearance?.fontSize ?? resolved.appearance.fontSize;
      const showLineNumbers =
        tabConfig?.appearance?.showLineNumbers ??
        resolved.appearance.showLineNumbers;

      const autoSave = tabConfig?.editor?.autoSave ?? resolved.editor.autoSave;
      const formatOnSave =
        tabConfig?.editor?.formatOnSave ?? resolved.editor.formatOnSave;
      const tabSize = tabConfig?.editor?.tabSize ?? resolved.editor.tabSize;

      const favorites = tabConfig?.favorites ?? resolved.favorites;
      const ignorePaths = tabConfig?.ignorePaths ?? resolved.ignorePaths;
      const profiles = tabConfig?.profiles ?? resolved.profiles;

      return [
        // --- Section 1: Appearance ---
        {
          label: "Appearance",
          items: [
            // FuzzySelector submenu: pick from a large list
            {
              id: "appearance.theme",
              label: "Theme",
              currentValue: theme,
              description: "Color theme. Opens a searchable list.",
              submenu: (_current, done) => {
                return new FuzzySelector({
                  label: "Select Theme",
                  items: AVAILABLE_THEMES,
                  currentValue: theme,
                  theme: ctx.theme,
                  onSelect: (selected) => {
                    const current = tabConfig ?? ({} as ExampleConfig);
                    const updated: ExampleConfig = {
                      ...current,
                      appearance: {
                        ...current.appearance,
                        theme: selected,
                      },
                    };
                    ctx.setDraft(updated);
                    done(selected);
                  },
                  onDone: () => done(undefined),
                });
              },
            },
            // Numeric enum: cycle through string representations
            {
              id: "appearance.fontSize",
              label: "Font size",
              currentValue: String(fontSize),
              values: ["12", "14", "16", "18", "20"],
              description: "Editor font size in pixels.",
            },
            // Boolean toggle: on/off
            {
              id: "appearance.showLineNumbers",
              label: "Line numbers",
              currentValue: showLineNumbers ? "on" : "off",
              values: ["on", "off"],
              description: "Show line numbers in the gutter.",
            },
          ],
        },

        // --- Section 2: Editor ---
        {
          label: "Editor",
          items: [
            {
              id: "editor.autoSave",
              label: "Auto save",
              currentValue: autoSave ? "on" : "off",
              values: ["on", "off"],
              description: "Automatically save files after changes.",
            },
            {
              id: "editor.formatOnSave",
              label: "Format on save",
              currentValue: formatOnSave ? "on" : "off",
              values: ["on", "off"],
              description: "Run formatter when saving a file.",
            },
            {
              id: "editor.tabSize",
              label: "Tab size",
              currentValue: String(tabSize),
              values: ["2", "4", "8"],
              description: "Number of spaces per tab.",
            },
            {
              id: "editor.details",
              label: "Editor details",
              currentValue: `${autoSave ? "auto" : "manual"} · tab ${tabSize}`,
              description:
                "Opens a focused detail panel. Demonstrates text, enum, boolean, nested submenu, and destructive action fields.",
              submenu: (_current, done) => {
                const current = tabConfig ?? ({} as ExampleConfig);
                let nextTheme = theme;
                let nextAutoSave = autoSave;
                let nextFormatOnSave = formatOnSave;
                let nextTabSize = String(tabSize);
                let nextFavorites = [...favorites];

                const syncDraft = () => {
                  const updated: ExampleConfig = {
                    ...current,
                    appearance: {
                      ...current.appearance,
                      theme: nextTheme,
                    },
                    editor: {
                      ...current.editor,
                      autoSave: nextAutoSave,
                      formatOnSave: nextFormatOnSave,
                      tabSize: Number.parseInt(nextTabSize, 10),
                    },
                    favorites: [...nextFavorites],
                  };
                  ctx.setDraft(updated);
                };

                return new SettingsDetailEditor({
                  title: "Editor details",
                  theme: ctx.theme,
                  fields: [
                    {
                      id: "appearance.theme.raw",
                      type: "text",
                      label: "Theme (raw)",
                      description: "Free-form text input.",
                      getValue: () => nextTheme,
                      setValue: (value) => {
                        nextTheme = value;
                        syncDraft();
                      },
                      validate: (value) =>
                        value.trim() ? null : "Theme cannot be empty",
                    },
                    {
                      id: "editor.tabSize.detail",
                      type: "enum",
                      label: "Tab size",
                      description: "Single-select enum picker.",
                      getValue: () => nextTabSize,
                      setValue: (value) => {
                        nextTabSize = value;
                        syncDraft();
                      },
                      options: ["2", "4", "8"],
                    },
                    {
                      id: "editor.autoSave.detail",
                      type: "boolean",
                      label: "Auto save",
                      description: "Boolean toggle field.",
                      getValue: () => nextAutoSave,
                      setValue: (value) => {
                        nextAutoSave = value;
                        syncDraft();
                      },
                    },
                    {
                      id: "editor.formatOnSave.detail",
                      type: "boolean",
                      label: "Format on save",
                      getValue: () => nextFormatOnSave,
                      setValue: (value) => {
                        nextFormatOnSave = value;
                        syncDraft();
                      },
                    },
                    {
                      id: "favorites.nested",
                      type: "submenu",
                      label: "Favorites",
                      description: "Nested submenu field (ArrayEditor).",
                      getValue: () =>
                        nextFavorites.length === 0
                          ? "none"
                          : `${nextFavorites.length} item${nextFavorites.length === 1 ? "" : "s"}`,
                      submenu: (doneNested) =>
                        new ArrayEditor({
                          label: "Favorites",
                          items: [...nextFavorites],
                          theme: ctx.theme,
                          onSave: (items) => {
                            nextFavorites = items;
                            syncDraft();
                          },
                          onDone: () =>
                            doneNested(
                              nextFavorites.length === 0
                                ? "none"
                                : `${nextFavorites.length} item${nextFavorites.length === 1 ? "" : "s"}`,
                            ),
                        }),
                    },
                    {
                      id: "favorites.clear",
                      type: "action",
                      label: "Clear favorites",
                      description: "Destructive action with confirmation.",
                      getValue: () => "destructive",
                      onConfirm: () => {
                        nextFavorites = [];
                        syncDraft();
                      },
                      confirmMessage:
                        "Clear all favorites? This cannot be undone.",
                    },
                  ],
                  getDoneSummary: () =>
                    `${nextAutoSave ? "auto" : "manual"} · tab ${nextTabSize}`,
                  onDone: (summary) => done(summary),
                });
              },
            },
          ],
        },

        // --- Section 3: Arrays ---
        {
          label: "Collections",
          items: [
            // ArrayEditor submenu: edit a string array
            {
              id: "favorites",
              label: "Favorites",
              currentValue:
                favorites.length === 0
                  ? "none"
                  : `${favorites.length} item${favorites.length === 1 ? "" : "s"}`,
              description:
                "A list of favorite items. Opens an array editor (add/edit/delete).",
              submenu: (_current, done) => {
                const current = tabConfig ?? ({} as ExampleConfig);
                const currentArray = current.favorites ?? resolved.favorites;

                return new ArrayEditor({
                  label: "Favorites",
                  items: [...currentArray],
                  theme: ctx.theme,
                  onSave: (items) => {
                    const updated: ExampleConfig = {
                      ...current,
                      favorites: items,
                    };
                    ctx.setDraft(updated);
                    done(
                      items.length === 0
                        ? "none"
                        : `${items.length} item${items.length === 1 ? "" : "s"}`,
                    );
                  },
                  onDone: () => done(undefined),
                });
              },
            },
            // PathArrayEditor submenu: edit filesystem paths with tab completion
            {
              id: "ignorePaths",
              label: "Ignore paths",
              currentValue:
                ignorePaths.length === 0
                  ? "none"
                  : `${ignorePaths.length} path${ignorePaths.length === 1 ? "" : "s"}`,
              description:
                "Paths to ignore. Opens a path editor with Tab completion and validation.",
              submenu: (_current, done) => {
                const current = tabConfig ?? ({} as ExampleConfig);
                const currentArray =
                  current.ignorePaths ?? resolved.ignorePaths;

                return new PathArrayEditor({
                  label: "Ignored Paths",
                  items: [...currentArray],
                  theme: ctx.theme,
                  validatePath: (value) => {
                    if (value.includes("..")) {
                      return "Relative parent paths not allowed";
                    }
                    return null;
                  },
                  onSave: (items) => {
                    const updated: ExampleConfig = {
                      ...current,
                      ignorePaths: items,
                    };
                    ctx.setDraft(updated);
                    done(
                      items.length === 0
                        ? "none"
                        : `${items.length} path${items.length === 1 ? "" : "s"}`,
                    );
                  },
                  onDone: () => done(undefined),
                });
              },
            },
            {
              id: "profiles",
              label: "Profiles",
              currentValue:
                profiles.length === 0
                  ? "none"
                  : `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`,
              description:
                "Array-of-objects example. Opens a detail panel where each profile opens its own object editor.",
              submenu: (_current, done) => {
                const current = tabConfig ?? ({} as ExampleConfig);
                const nextProfiles = profiles.map((profile) => ({
                  ...profile,
                }));

                const saveProfiles = () => {
                  const updated: ExampleConfig = {
                    ...current,
                    profiles: nextProfiles.map((profile) => ({ ...profile })),
                  };
                  ctx.setDraft(updated);
                };

                return new SettingsDetailEditor({
                  title: "Profiles",
                  theme: ctx.theme,
                  fields: nextProfiles.map((_, index) => ({
                    id: `profiles.${index}`,
                    type: "submenu" as const,
                    label: `Profile ${index + 1}`,
                    description: "Edit this profile object.",
                    getValue: () => {
                      const profile = nextProfiles[index];
                      if (!profile) return "(missing)";
                      const status = profile.enabled ? "on" : "off";
                      return `${profile.name ?? "Unnamed"} · ${profile.theme ?? "dark"} · ${status}`;
                    },
                    submenu: (doneNested) =>
                      new SettingsDetailEditor({
                        title: () => {
                          const profile = nextProfiles[index];
                          return profile
                            ? `Profile ${index + 1}: ${profile.name ?? "Unnamed"}`
                            : `Profile ${index + 1}`;
                        },
                        theme: ctx.theme,
                        fields: [
                          {
                            id: `profiles.${index}.name`,
                            type: "text",
                            label: "Name",
                            getValue: () => nextProfiles[index]?.name ?? "",
                            setValue: (value) => {
                              const existing = nextProfiles[index];
                              if (!existing) return;
                              nextProfiles[index] = {
                                ...existing,
                                name: value,
                              };
                              saveProfiles();
                            },
                            validate: (value) =>
                              value.trim() ? null : "Name cannot be empty",
                          },
                          {
                            id: `profiles.${index}.theme`,
                            type: "enum",
                            label: "Theme",
                            getValue: () =>
                              nextProfiles[index]?.theme ?? "dark",
                            setValue: (value) => {
                              const existing = nextProfiles[index];
                              if (!existing) return;
                              nextProfiles[index] = {
                                ...existing,
                                theme: value,
                              };
                              saveProfiles();
                            },
                            options: AVAILABLE_THEMES,
                          },
                          {
                            id: `profiles.${index}.enabled`,
                            type: "boolean",
                            label: "Enabled",
                            getValue: () =>
                              nextProfiles[index]?.enabled ?? false,
                            setValue: (value) => {
                              const existing = nextProfiles[index];
                              if (!existing) return;
                              nextProfiles[index] = {
                                ...existing,
                                enabled: value,
                              };
                              saveProfiles();
                            },
                          },
                        ],
                        getDoneSummary: () => {
                          const profile = nextProfiles[index];
                          if (!profile) return undefined;
                          return `${profile.name ?? "Unnamed"} · ${profile.enabled ? "on" : "off"}`;
                        },
                        onDone: (summary) => doneNested(summary),
                      }),
                  })),
                  getDoneSummary: () =>
                    nextProfiles.length === 0
                      ? "none"
                      : `${nextProfiles.length} profile${nextProfiles.length === 1 ? "" : "s"}`,
                  onDone: (summary) => done(summary),
                });
              },
            },
          ],
        },
      ];
    },

    // --- Extra non-scope tab ---
    extraTabs: [
      {
        id: "examples",
        label: "Examples",
        buildSections: ({ resolved, enabledScopes, getRawForScope, theme }) => [
          {
            label: "Info",
            items: [
              {
                id: "examples.scopes",
                label: "Enabled scopes",
                currentValue: enabledScopes.join(", "),
                description: "Extra tabs are rendered after scope tabs.",
              },
              {
                id: "examples.theme",
                label: "Resolved theme",
                currentValue: theme.fg("accent", resolved.appearance.theme),
              },
              {
                id: "examples.hasGlobal",
                label: "Global config",
                currentValue: getRawForScope("global") ? "present" : "missing",
              },
            ],
          },
        ],
      },
    ],

    // --- Custom change handler ---
    // Needed because:
    // - fontSize and tabSize are numbers, not strings
    // - Boolean fields (showLineNumbers, autoSave, formatOnSave) use "on"/"off"
    //   display values but should store as true/false in the config
    onSettingChange: (id, newValue, config) => {
      const updated = structuredClone(config);

      switch (id) {
        case "appearance.fontSize": {
          updated.appearance = {
            ...updated.appearance,
            fontSize: Number.parseInt(newValue, 10),
          };
          return updated;
        }
        case "editor.tabSize": {
          updated.editor = {
            ...updated.editor,
            tabSize: Number.parseInt(newValue, 10),
          };
          return updated;
        }
        case "appearance.showLineNumbers": {
          updated.appearance = {
            ...updated.appearance,
            showLineNumbers: newValue === "on",
          };
          return updated;
        }
        case "editor.autoSave": {
          updated.editor = {
            ...updated.editor,
            autoSave: newValue === "on",
          };
          return updated;
        }
        case "editor.formatOnSave": {
          updated.editor = {
            ...updated.editor,
            formatOnSave: newValue === "on",
          };
          return updated;
        }
        default:
          // Fall through to default handling for enums (strings stored as-is).
          return null;
      }
    },

    // --- Post-save callback ---
    onSave: (_ctx) => {
      // Reload any cached state here.
      // e.g. re-read configLoader.getConfig() into runtime variables.
    },
  });
}
