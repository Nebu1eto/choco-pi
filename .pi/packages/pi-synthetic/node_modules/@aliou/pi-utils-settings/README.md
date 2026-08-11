![banner](https://assets.aliou.me/pi-extensions/banners/pi-utils-settings.png)

# @aliou/pi-utils-settings

Shared settings infrastructure for [pi](https://github.com/mariozechner/pi-coding-agent) extensions. Provides config loading, a settings UI command with scope tabs plus optional extra tabs, and reusable TUI components.

This is a utility library, not a pi extension. It is meant to be used as a dependency by extensions that need a settings UI or JSON config management.

## Install

```bash
pnpm add @aliou/pi-utils-settings
```

## API

### ConfigLoader

Generic JSON config loader with global + project scopes, deep merge, and versioned migrations.

```typescript
import { ConfigLoader, type Migration } from "@aliou/pi-utils-settings";

interface MyConfig {
  features?: { darkMode?: boolean };
}

interface ResolvedConfig {
  features: { darkMode: boolean };
}

const migrations: Migration<MyConfig>[] = [
  {
    name: "v1-upgrade",
    shouldRun: (config) => !config.features,
    run: (config) => ({ ...config, features: {} }),
  },
];

const configLoader = new ConfigLoader<MyConfig, ResolvedConfig>(
  "my-extension", // reads ~/.pi/agent/extensions/my-extension.json + .pi/extensions/my-extension.json
  { features: { darkMode: false } }, // defaults
  { migrations },
);

await configLoader.load();
const config = configLoader.getConfig(); // ResolvedConfig (defaults merged with global + project)
```

#### JSON Schema support

`ConfigLoader` can inject a `$schema` field into settings files, giving editors autocomplete and validation. Pair it with `buildSchemaUrl` and auto-generated schemas from `ts-json-schema-generator`.

```typescript
import { ConfigLoader, buildSchemaUrl } from "@aliou/pi-utils-settings";
import pkg from "./package.json";

const schemaUrl = buildSchemaUrl(pkg.name, pkg.version);

const loader = new ConfigLoader<MyConfig, ResolvedConfig>(
  "my-extension",
  defaults,
  { schemaUrl },
);
```

When `schemaUrl` is set, `save()` writes `$schema` as the first key in the JSON file and `load()` strips it before returning config to callers.

To generate the schema from your `TConfig` type, add these scripts to your extension's `package.json`:

```json
{
  "gen:schema": "ts-json-schema-generator --path src/config.ts --type MyConfig --no-type-check -o schema.json",
  "check:schema": "ts-json-schema-generator --path src/config.ts --type MyConfig --no-type-check -o /tmp/schema-check.json && diff -q schema.json /tmp/schema-check.json"
}
```

Run `pnpm gen:schema` to produce `schema.json`, commit it, and add `"schema.json"` to `files` in `package.json` so it ships with your npm package. Add `check:schema` to CI to catch drift.

An optional `afterMerge` hook runs after the deep merge for logic that can't be expressed as a simple merge (e.g., one field replacing another):

```typescript
new ConfigLoader("my-ext", defaults, {
  afterMerge: (resolved, global, project) => {
    if (project?.customField) {
      resolved.derivedField = project.customField;
    }
    return resolved;
  },
});
```

### registerSettingsCommand

Creates a `/name:settings` command with scope tabs (Global/Local/Memory), draft-based editing, and Ctrl+S to save.

All changes (boolean toggles, enum cycling, submenu edits) are held in memory as drafts. Nothing is written to disk until the user presses Ctrl+S. Esc exits without saving. Dirty tabs show a `*` marker.

```typescript
import { registerSettingsCommand, type SettingsSection } from "@aliou/pi-utils-settings";

registerSettingsCommand<MyConfig, ResolvedConfig>(pi, {
  commandName: "my-ext:settings",
  title: "My Extension Settings",
  configStore: configLoader, // implements ConfigStore interface
  buildSections: (tabConfig, resolved, { setDraft, theme }) => [
    {
      label: "General",
      items: [
        {
          id: "features.darkMode",
          label: "Dark mode",
          description: theme.fg("dim", "Enable dark mode"),
          currentValue: (tabConfig?.features?.darkMode ?? resolved.features.darkMode) ? "on" : "off",
          values: ["on", "off"],
        },
      ],
    },
  ],
  // --- Optional: Custom change handler ---
  // The default handler stores all values as raw strings ("on"/"off", "pnpm", etc).
  // Use onSettingChange to convert display values to the correct storage types:
  // - Booleans: newValue === "on" -> true
  // - Numbers: Number.parseInt(newValue, 10)
  // Return null to fall through to the default string storage.
  onSettingChange: (id, newValue, config) => {
    const updated = structuredClone(config);
    if (id === "features.darkMode") {
      updated.features = { ...updated.features, darkMode: newValue === "on" };
      return updated;
    }
    return null; // Fall through for other fields
  },
});
```

You can also add non-scope top-level tabs with `extraTabs`:

```typescript
import { registerSettingsCommand, type ExtraSettingsTab } from "@aliou/pi-utils-settings";

const extraTabs: ExtraSettingsTab<MyConfig, ResolvedConfig>[] = [
  {
    id: "examples",
    label: "Examples",
    buildSections: ({ resolved, getRawForScope, enabledScopes }) => {
      const globalConfig = getRawForScope("global");
      return [
        {
          label: "Examples",
          items: [
            {
              id: "example.enabledScopes",
              label: "Enabled scopes",
              currentValue: enabledScopes.join(", "),
            },
            {
              id: "example.darkModeDefault",
              label: "Dark mode default",
              currentValue: resolved.features.darkMode ? "on" : "off",
            },
            {
              id: "example.globalPresent",
              label: "Global config",
              currentValue: globalConfig ? "present" : "missing",
              description: "Read-only info tab not tied to a scope.",
            },
          ],
        },
      ];
    },
  },
];
```

`Ctrl+S` behavior stays the same: only dirty scope drafts are saved. Extra tabs can still update drafts by calling `setDraftForScope(...)` from submenu callbacks.

`buildSections` ctx now includes `theme`, which is both a `SettingsListTheme` and full pi `Theme`. This means you can use list helpers (`label`, `value`, `hint`, ...) and pass the same object to components that require full `Theme`.

```typescript
import { Wizard } from "@aliou/pi-utils-settings";

buildSections: (_tabConfig, _resolved, ctx) => [
  {
    label: "Setup",
    items: [
      {
        id: "setup.wizard",
        label: "Run setup",
        currentValue: ctx.theme.fg("accent", "open"),
        submenu: (_value, done) =>
          new Wizard({
            title: "Setup",
            theme: ctx.theme,
            steps: [{ label: "Step", build: () => ({ render: () => [ctx.theme.hint("Ready")], handleInput: () => {} }) }],
            onComplete: () => done("done"),
            onCancel: () => done(undefined),
          }),
      },
    ],
  },
];
```

### Submenu support

Items can open submenus by providing a `submenu` factory. Use `setDraft` inside submenu `onSave` to keep changes in the draft (same save model as simple values):

```typescript
import { ArrayEditor, setNestedValue } from "@aliou/pi-utils-settings";

{
  id: "tags",
  label: "Tags",
  currentValue: `${tags.length} items`,
  submenu: (_val, done) => {
    let latest = [...tags];
    return new ArrayEditor({
      label: "Tags",
      items: [...tags],
      theme: ctx.theme,
      onSave: (items) => {
        latest = items;
        const updated = structuredClone(tabConfig ?? {}) as MyConfig;
        setNestedValue(updated, "tags", items);
        setDraft(updated);
      },
      onDone: () => done(`${latest.length} items`),
    });
  },
}
```

### SectionedSettings vs SettingsDetailEditor

Use **SectionedSettings** alone when each row can be edited in one step (toggle, enum cycle, or a simple submenu).

Use **SectionedSettings + SettingsDetailEditor** when a selected row needs a focused second-level panel with multiple editable fields.

`SettingsDetailEditor` is data-driven. You pass field descriptors with getters/setters and optional nested submenu callbacks. The component owns keyboard navigation and rendering only.

```typescript
import {
  ArrayEditor,
  SettingsDetailEditor,
  type SettingsDetailField,
} from "@aliou/pi-utils-settings";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";

const fields: SettingsDetailField[] = [
  {
    id: "autoSave",
    type: "boolean",
    label: "Auto save",
    getValue: () => editor.autoSave,
    setValue: (next) => {
      editor.autoSave = next;
    },
  },
  {
    id: "tabSize",
    type: "enum",
    label: "Tab size",
    getValue: () => String(editor.tabSize),
    setValue: (next) => {
      editor.tabSize = Number.parseInt(next, 10);
    },
    options: ["2", "4", "8"],
  },
  {
    id: "favorites",
    type: "submenu",
    label: "Favorites",
    getValue: () => `${favorites.length} items`,
    submenu: (done) =>
      new ArrayEditor({
        label: "Favorites",
        items: [...favorites],
        theme: getSettingsListTheme(),
        onSave: (items) => {
          favorites = items;
        },
        onDone: () => done(`${favorites.length} items`),
      }),
  },
  {
    id: "clear",
    type: "action",
    label: "Clear favorites",
    getValue: () => "destructive",
    onConfirm: () => {
      favorites = [];
    },
    confirmMessage: "Clear all favorites? This cannot be undone.",
  },
];

const detail = new SettingsDetailEditor({
  title: "Editor details",
  fields,
  theme: getSettingsListTheme(),
  onDone: (summary) => done(summary),
  getDoneSummary: () => `${favorites.length} items`,
});
```

### ConfigStore interface

Extensions with custom config loaders can implement `ConfigStore` directly instead of using `ConfigLoader`:

```typescript
interface ConfigStore<TConfig, TResolved> {
  getConfig(): TResolved;
  getRawConfig(scope: "global" | "project"): TConfig | null;
  hasConfig(scope: "global" | "project"): boolean;
  save(scope: "global" | "project", config: TConfig): Promise<void>;
}
```

### Components

- **SectionedSettings**: Grouped settings list with search filtering and cursor preservation on update.
- **SettingsDetailEditor**: Focused second-level editor for one selected item (text, enum, boolean, nested submenu, destructive action).
- **ArrayEditor**: String array editor with add/remove/reorder.
- **PathArrayEditor**: Path-focused array editor with Tab completion in add/edit mode.

### Helpers

- `setNestedValue(obj, "a.b.c", value)`: Set a deeply nested value by dot-separated path.
- `getNestedValue(obj, "a.b.c")`: Get a deeply nested value by dot-separated path.
- `getSettingsTheme(theme)`: Build a combined settings theme (`SettingsTheme`) usable by both settings-list components and full-theme components like `Wizard`.

## Exports

```typescript
export { ConfigLoader, type ConfigStore, type Migration } from "./config-loader";
export { registerSettingsCommand, type SettingsCommandOptions } from "./settings-command";
export { SectionedSettings, type SectionedSettingsOptions, type SettingsSection } from "./components/sectioned-settings";
export {
  SettingsDetailEditor,
  type SettingsDetailActionField,
  type SettingsDetailBooleanField,
  type SettingsDetailEditorOptions,
  type SettingsDetailEnumField,
  type SettingsDetailField,
  type SettingsDetailSubmenuField,
  type SettingsDetailTextField,
} from "./components/settings-detail-editor";
export { ArrayEditor, type ArrayEditorOptions } from "./components/array-editor";
export { PathArrayEditor, type PathArrayEditorOptions } from "./components/path-array-editor";
export { setNestedValue, getNestedValue } from "./helpers";
export { buildSchemaUrl } from "./schema";
export { getSettingsTheme, type SettingsTheme } from "./theme";
```