import {
  isBoolean,
  isObjectRecord,
  type LspBoundaryValue,
  type LspDictionaryValue,
} from "./runtime-guards.ts";

export type LensFlagScope = "global" | "project";

export interface LensFlagSpec {
  name: string;
  description: string;
  configKey: string;
  negated: boolean;
  default: boolean;
  scope: LensFlagScope;
  env?: string;

  readGlobal?: (config: Record<string, LspDictionaryValue>) => boolean | undefined;
}

export const LENS_FLAGS: readonly LensFlagSpec[] = [
  {
    name: "no-lens",
    description:
      "Start choco-pi-lsp disabled for this session. Re-enable with /lens-toggle. Also via lens.enabled=false in ~/.choco-pi-lsp/config.json.",
    configKey: "lens.enabled",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "no-lsp",
    description:
      "Disable unified LSP diagnostics and use language-specific fallbacks (for example pyright). Also via lsp.enabled=false in ~/.choco-pi-lsp/config.json.",
    configKey: "lsp.enabled",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "lsp-warmup",
    description:
      "Opt in to pre-starting a language server during session startup. Also via warmup.enabled=true in ~/.choco-pi-lsp/config.json or CHOCO_PI_LSP_WARMUP=1.",
    configKey: "warmup.enabled",
    negated: false,
    default: false,
    scope: "global",
    env: "CHOCO_PI_LSP_WARMUP",
  },
  {
    name: "no-autoformat",
    description:
      "Disable automatic formatting entirely (deferred format runs at agent_end by default). Also via format.enabled=false in config.",
    configKey: "format.enabled",
    negated: true,
    default: false,
    scope: "project",
  },
  {
    name: "immediate-format",
    description:
      'Run automatic formatting immediately after each write/edit instead of deferring to agent_end. Also via format.mode="immediate" in config.',
    configKey: "format.mode",
    negated: false,
    default: false,
    scope: "global",
    readGlobal: (config) => {
      const format = config.format;

      if (!format || !isObjectRecord(format)) return undefined;

      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const mode = (format as Record<string, LspDictionaryValue>).mode;
      if (mode !== "immediate" && mode !== "deferred") return undefined;
      return mode === "immediate";
    },
  },
  {
    name: "no-autofix",
    description:
      "Disable auto-fixing of lint issues (Biome, Ruff, ESLint). Also via autofix.enabled=false in config.",
    configKey: "autofix.enabled",
    negated: true,
    default: false,
    scope: "project",
  },
  {
    name: "no-tests",
    description:
      "Disable test runner on write. Also via tests.enabled=false in ~/.choco-pi-lsp/config.json.",
    configKey: "tests.enabled",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "no-delta",
    description:
      "Disable delta mode (show all diagnostics, not just new ones). Also via delta.enabled=false in ~/.choco-pi-lsp/config.json.",
    configKey: "delta.enabled",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "lens-guard",
    description:
      "Experimental: block git commit/push when unresolved choco-pi-lsp blockers exist. Also via guard.enabled=true in ~/.choco-pi-lsp/config.json.",
    configKey: "guard.enabled",
    negated: false,
    default: false,
    scope: "global",
  },
  {
    name: "no-opengrep",
    description:
      "Disable the Opengrep security scanner (a default-on auxiliary LSP; auto-installs, uses repo rules if present else the login-free 'auto' ruleset). Also via opengrep.enabled=false in ~/.choco-pi-lsp/config.json.",
    configKey: "opengrep.enabled",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "no-read-guard",
    description:
      "Disable read-before-edit behavior monitor. Also via readGuard.enabled=false in ~/.choco-pi-lsp/config.json.",
    configKey: "readGuard.enabled",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "no-lens-context",
    description:
      "Disable automatic context injection (session-start guidance, turn-end & test findings) while keeping tools, LSP, read-guard, and formatting active. Toggle with /lens-context-toggle. Also via contextInjection.enabled=false in config or CHOCO_PI_LSP_NO_CONTEXT_INJECTION=1.",
    configKey: "contextInjection.enabled",
    negated: true,
    default: false,
    scope: "global",
    env: "CHOCO_PI_LSP_NO_CONTEXT_INJECTION",
  },
  {
    name: "lens-turn-summary",
    description:
      "Opt-in: persist a per-turn transcript entry summarizing diagnostics found, autofixes applied, and autoformats applied this turn (#484). Collapsed one-line, expandable in place. Default off. Also via turnSummary.enabled=true in ~/.choco-pi-lsp/config.json.",
    configKey: "turnSummary.enabled",
    negated: false,
    default: false,
    scope: "global",
  },
  {
    name: "lens-actionable-warnings",
    description:
      "Write turn-delta fixable warning reports and inject a short advisory. Also via actionableWarnings.enabled=true in ~/.choco-pi-lsp/config.json.",
    configKey: "actionableWarnings.enabled",
    negated: false,
    default: false,
    scope: "global",
  },
  {
    name: "lens-actionable-warning-actions",
    description:
      "Enrich actionable-warning reports with LSP code-action titles (requires an active language server). Also via actionableWarnings.includeLspCodeActions=true in ~/.choco-pi-lsp/config.json.",
    configKey: "actionableWarnings.includeLspCodeActions",
    negated: false,
    default: false,
    scope: "global",
  },
  {
    name: "lens-actionable-warning-autofix",
    description:
      "Experimental: apply conservative LSP quickfixes for actionable warnings at agent_end. Also via actionableWarnings.autoFix.enabled=true in config.",
    configKey: "actionableWarnings.autoFix.enabled",
    negated: false,
    default: false,
    scope: "project",
  },
  {
    name: "lens-actionable-warning-all",
    description:
      "Report every actionable warning, not just those introduced this turn. Also via actionableWarnings.deltaOnly=false in ~/.choco-pi-lsp/config.json.",
    configKey: "actionableWarnings.deltaOnly",
    negated: true,
    default: false,
    scope: "global",
  },
  {
    name: "lens-compact-tool-line",
    description:
      "Opt-in (#1327): collapse a choco-pi-lsp tool's call+result rows into ONE theme-aware line (status glyph + name + summary) instead of two. Preserves expand-to-view-full-output. Default off. Also via ui.compactToolLine=true in ~/.choco-pi-lsp/config.json.",
    configKey: "ui.compactToolLine",
    negated: false,
    default: false,
    scope: "global",
  },
  {
    name: "no-lazy-tools",
    description:
      "Keep all choco-pi-lsp tools active to avoid tool-list cache changes. Also via tools.lazy=false in ~/.choco-pi-lsp/config.json.",
    configKey: "tools.lazy",
    negated: true,
    default: false,
    scope: "global",
  },
];

const byName = new Map(LENS_FLAGS.map((spec) => [spec.name, spec]));

export function getLensFlagSpec(name: string): LensFlagSpec | undefined {
  return byName.get(name);
}

export const PROJECT_SCOPED_LENS_FLAGS: readonly LensFlagSpec[] = LENS_FLAGS.filter(
  (spec) => spec.scope === "project",
);

export const GLOBAL_NON_FLAG_CONFIG_SECTIONS: readonly string[] = [
  "ignore",
  "dispatch",
  "widget",
  "typeAcquisition",
  "$schema",
];

export const PROJECT_FOREIGN_CONFIG_NAMESPACES: readonly string[] = [
  "servers",
  "serverOverrides",
  "disabledServers",
  "warmFiles",
  "$schema",
];

export function flagConfigSectionKeys(flags: readonly LensFlagSpec[]): string[] {
  return [...new Set(flags.map((spec) => spec.configKey.split(".")[0]))];
}

function asConfigObject(value: LspBoundaryValue): Record<string, LspDictionaryValue> | undefined {
  if (!value || !isObjectRecord(value) || Array.isArray(value)) return undefined;
  // SAFETY: TypeBox established a non-array object, so string-key access preserves its runtime values.
  return value as Record<string, LspDictionaryValue>;
}

interface FlagConfigPath {
  source: Record<string, LspDictionaryValue>;
  segments: string[];
}

function resolveFlagConfigPath(
  raw: Record<string, LspDictionaryValue>,
  configKey: string,
  warnInvalid?: (reason: string) => void,
): FlagConfigPath | undefined {
  const segments = configKey.split(".");
  let source = raw;
  for (let i = 0; i < segments.length - 1; i++) {
    const object = asConfigObject(source);
    if (!object) return undefined;

    const segment = segments[i];
    if (!(segment in object)) return undefined;

    const next = asConfigObject(object[segment]);
    if (!next) {
      if (warnInvalid) {
        warnInvalid(`${segments.slice(0, i + 1).join(".")} must be an object`);
      }
      return undefined;
    }

    source = next;
  }

  const finalSource = asConfigObject(source);
  if (!finalSource) return undefined;
  return { source: finalSource, segments };
}

export function readFlagConfigValue(
  config: LspBoundaryValue,
  configKey: string,
): boolean | undefined {
  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const path = resolveFlagConfigPath(config as Record<string, LspDictionaryValue>, configKey);
  if (!path) return undefined;

  const leaf = path.segments[path.segments.length - 1];
  const value = path.source[leaf];

  return isBoolean(value) ? value : undefined;
}

export function flagValueFromConfig(spec: LensFlagSpec, configValue: boolean): boolean {
  return spec.negated ? !configValue : configValue;
}

export function assignFlagConfigSection(
  raw: Record<string, LspDictionaryValue>,

  out: Record<string, LspDictionaryValue>,
  configKey: string,
  warnInvalid: (reason: string) => void,
): void {
  const path = resolveFlagConfigPath(raw, configKey, warnInvalid);
  if (!path) return;

  let target = out;
  for (const segment of path.segments.slice(0, -1)) {
    target[segment] ??= {};

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    target = target[segment] as Record<string, LspDictionaryValue>;
  }

  const leaf = path.segments[path.segments.length - 1];

  if (leaf in path.source && !isBoolean(path.source[leaf])) {
    warnInvalid(`${configKey} must be a boolean`);
    target[leaf] = undefined;
    return;
  }
  target[leaf] = path.source[leaf];
}
