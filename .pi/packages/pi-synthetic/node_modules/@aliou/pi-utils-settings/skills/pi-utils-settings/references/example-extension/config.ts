/**
 * Configuration for the example extension.
 *
 * Demonstrates:
 * - Partial (user-facing) vs resolved (internal) config types
 * - Multiple scopes (global + local)
 * - Migrations for schema evolution
 * - afterMerge hook for custom merge logic
 * - JSON Schema generation via ts-json-schema-generator
 * - $schema injection via buildSchemaUrl
 */

import {
  buildSchemaUrl,
  ConfigLoader,
  type Migration,
} from "@aliou/pi-utils-settings";

// --- User-facing config (all optional, stored on disk) ---
// JSDoc comments become `description` fields in the generated JSON Schema.

/** User-facing configuration for the example extension. */
export interface ExampleConfig {
  /** Visual appearance settings. */
  appearance?: {
    /** Color theme name (e.g. "dark", "light", "solarized"). */
    theme?: string;
    /** Editor font size in pixels. */
    fontSize?: number;
    /** Show line numbers in the gutter. */
    showLineNumbers?: boolean;
  };
  /** Editor behavior settings. */
  editor?: {
    /** Automatically save files after changes. */
    autoSave?: boolean;
    /** Run formatter on save. */
    formatOnSave?: boolean;
    /** Number of spaces per tab. */
    tabSize?: number;
  };
  /** List of favorite file paths. */
  favorites?: string[];
  /** Glob patterns for paths to ignore. */
  ignorePaths?: string[];
  /** Named configuration profiles. */
  profiles?: Array<{
    /** Profile display name. */
    name?: string;
    /** Theme override for this profile. */
    theme?: string;
    /** Whether this profile is active. */
    enabled?: boolean;
  }>;
}

// --- Resolved config (all required, defaults applied) ---

export interface ResolvedExampleConfig {
  appearance: {
    theme: string;
    fontSize: number;
    showLineNumbers: boolean;
  };
  editor: {
    autoSave: boolean;
    formatOnSave: boolean;
    tabSize: number;
  };
  favorites: string[];
  ignorePaths: string[];
  profiles: Array<{
    name: string;
    theme: string;
    enabled: boolean;
  }>;
}

// --- Defaults ---

const DEFAULT_CONFIG: ResolvedExampleConfig = {
  appearance: {
    theme: "dark",
    fontSize: 14,
    showLineNumbers: true,
  },
  editor: {
    autoSave: false,
    formatOnSave: true,
    tabSize: 2,
  },
  favorites: [],
  ignorePaths: [],
  profiles: [
    { name: "Primary", theme: "dark", enabled: true },
    { name: "Preview", theme: "light", enabled: false },
  ],
};

// --- Migrations ---

const migrations: Migration<ExampleConfig>[] = [
  {
    name: "rename-font-size",
    shouldRun: (config) => "fontsize" in (config.appearance ?? {}),
    run: (config) => {
      const appearance = config.appearance ?? {};
      const fontSize = (appearance as Record<string, unknown>).fontsize;
      const { fontsize: _, ...rest } = appearance as Record<string, unknown>;
      return {
        ...config,
        appearance: { ...rest, fontSize } as ExampleConfig["appearance"],
      };
    },
  },
];

// --- Schema URL ---
// In a real extension, import name and version from package.json:
//   import pkg from "../package.json";
//   const schemaUrl = buildSchemaUrl(pkg.name, pkg.version);
const schemaUrl = buildSchemaUrl("@aliou/example-extension", "1.0.0");

// --- Loader ---

export const configLoader = new ConfigLoader<
  ExampleConfig,
  ResolvedExampleConfig
>("example-extension", DEFAULT_CONFIG, {
  scopes: ["global", "local"],
  migrations,
  schemaUrl,
  afterMerge: (resolved, _global, local) => {
    // Example: local ignorePaths replace global rather than merge
    if (local?.ignorePaths) {
      resolved.ignorePaths = local.ignorePaths;
    }
    return resolved;
  },
});
