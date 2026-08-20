import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { logExtension } from "./extension-log.js";
import { notifyUserDegradation } from "./user-notify.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assignFlagConfigSection,
  flagConfigSectionKeys,
  flagValueFromConfig,
  getLensFlagSpec,
  GLOBAL_NON_FLAG_CONFIG_SECTIONS,
  LENS_FLAGS,
  readFlagConfigValue,
} from "./lsp-flag-registry.js";
import { findNestedProjectMutationValue, type PiLensProjectConfig } from "./project-lsp-config.js";

const LspBoundaryValueSchema = Type.Unknown();
type LspBoundaryValue = Static<typeof LspBoundaryValueSchema>;
const LspDictionaryValueSchema = Type.Unknown();
type LspDictionaryValue = Static<typeof LspDictionaryValueSchema>;

interface MutableConfigDictionary extends Record<string, LspDictionaryValue> {}

export type PiLensFormatMode = "deferred" | "immediate";

/** The `{ enabled?: boolean }` section every registry flag key lives under. */
export interface PiLensToggleConfig {
  enabled?: boolean;
}

export interface PiLensGlobalConfig {
  /**
   * Gitignore-style patterns excluded from choco-pi-lsp scans across ALL projects.
   * Merged at LOWEST precedence: a project `.gitignore` or `.choco-pi-lsp.json`
   * `ignore` (including `!negation`) overrides these. See #252.
   */
  ignore?: string[];
  dispatch?: {
    /**
     * Minimum wall-clock budget (ms) for every dispatch runner.
     * Acts as a floor: effective timeout = max(runner.timeoutMs ?? 30_000, runnerTimeoutFloorMs).
     * Useful for large monorepos where slow toolchains (e.g. cargo clippy) exceed
     * any runner's declared budget. Also overridable via CHOCO_PI_LSP_RUNNER_TIMEOUT_FLOOR_MS.
     */
    runnerTimeoutFloorMs?: number;
  };
  widget?: {
    /** Whether the diagnostics widget is visible when a session starts. */
    visible?: boolean;
  };
  /** Whether choco-pi-lsp runs at all this session (`--no-lens`). */
  lens?: PiLensToggleConfig;
  /** Whether unified LSP diagnostics run (`--no-lsp`). */
  lsp?: PiLensToggleConfig;
  /** Whether the test runner fires on write (`--no-tests`). */
  tests?: PiLensToggleConfig;
  /** Whether delta mode limits diagnostics to new ones (`--no-delta`). */
  delta?: PiLensToggleConfig;
  /** Whether the experimental commit/push blocker runs (`--lens-guard`). */
  guard?: PiLensToggleConfig;
  /** Whether the Opengrep auxiliary LSP attaches (`--no-opengrep`). */
  opengrep?: PiLensToggleConfig;
  /** Whether the read-before-edit behavior monitor runs (`--no-read-guard`). */
  readGuard?: PiLensToggleConfig;
  format?: {
    /** Whether auto-formatting is enabled. */
    enabled?: boolean;
    /** When to run auto-formatting after write/edit tool results. */
    mode?: PiLensFormatMode;
  };
  autofix?: {
    /**
     * Whether the pipeline may apply deterministic linter fixes (Biome,
     * Ruff, ESLint, ...). Defaults true. A project `.choco-pi-lsp.json`
     * `autofix.enabled` overrides this in either direction (#792).
     */
    enabled?: boolean;
  };
  actionableWarnings?: {
    /** Write turn-delta fixable warning reports and inject a short advisory. */
    enabled?: boolean;
    /** Enrich warning reports with LSP code-action titles. */
    includeLspCodeActions?: boolean;
    /** Restrict reporting to warnings introduced by this turn. */
    deltaOnly?: boolean;
    autoFix?: {
      /** Experimental conservative agent_end warning autofix. Defaults false. */
      enabled?: boolean;
      /**
       * Cap on quickfixes applied per turn. Defaults 5. `0` keeps the report
       * but applies nothing. Documented since #792 but only wired up in #166.
       */
      maxFixes?: number;
    };
  };
  contextInjection?: {
    /**
     * Whether choco-pi-lsp prepends automatic findings (session-start guidance,
     * turn-end findings, test findings) into the next model turn via the
     * `context` hook. Defaults true. Set false to keep tools/LSP/read-guard/
     * formatting running while avoiding prompt-cache invalidation from injected
     * messages. Findings are still cached for `diagnostics_report` / `/lens-health`.
     */
    enabled?: boolean;
  };
  turnSummary?: {
    /**
     * Opt-in, transcript-persistent per-turn summary of diagnostics found,
     * autofixes applied, and autoformats applied (#484). Defaults false —
     * absence of this key means off. One collapsed/expandable entry per turn,
     * only emitted when the turn's collection is non-empty.
     */
    enabled?: boolean;
  };
}

export function getPiLensGlobalConfigPath(homeDir = os.homedir()): string {
  const override = process.env.CHOCO_PI_LSP_CONFIG_PATH;
  if (override) return path.resolve(override);
  return path.join(homeDir, ".choco-pi-lsp", "config.json");
}

const warnedInvalidGlobalConfigs = new Set<string>();

/**
 * Same warn-once-per-(path, reason) contract as project-lsp-config.ts's
 * `warnInvalidConfigOnce` — a malformed global config value is logged once
 * and then treated as absent, rather than silently dropped (#792).
 */
function warnInvalidGlobalConfigOnce(configPath: string, reason: string): void {
  const key = `${configPath}:${reason}`;
  if (warnedInvalidGlobalConfigs.has(key)) return;
  warnedInvalidGlobalConfigs.add(key);
  const message = `ignoring invalid global config ${configPath}: ${reason}`;
  logExtension({
    subsystem: "lens-config",
    level: "warn",
    message,
    metadata: { configPath, reason },
  });
  // HUMAN-audience too: a config the user wrote is being ignored. Routed
  // through the host's own render path (#1333), never a raw write.
  notifyUserDegradation(`choco-pi-lsp: ${message}`);
}

/** For tests that need to force the warn-once cache to reset between cases. */
export function resetGlobalConfigWarnCache(): void {
  warnedInvalidGlobalConfigs.clear();
}

/**
 * choco-pi fork: session-scoped runtime overrides set by user commands
 * (today only `/lsp on|off` → the `no-lsp` flag). Consulted FIRST in
 * `resolvePiLensFlagWithSource`, above env/CLI/config — an explicit runtime
 * command is the most recent, most deliberate user decision, so it outranks
 * the flags the session was launched with. Cleared only by another override
 * call; process-lifetime, never persisted (persistence goes through
 * `persistPiLensGlobalConfigKey`).
 */
const runtimeFlagOverrides = new Map<string, boolean | string>();

export function setRuntimeLensFlagOverride(
  name: string,
  value: boolean | string | undefined,
): void {
  if (value === undefined) runtimeFlagOverrides.delete(name);
  else runtimeFlagOverrides.set(name, value);
}

export function getRuntimeLensFlagOverride(name: string): boolean | string | undefined {
  return runtimeFlagOverrides.get(name);
}

/**
 * choco-pi fork: persist one dotted `configKey` (e.g. `lsp.enabled`) into
 * `~/.choco-pi-lsp/config.json` so a runtime toggle survives the session. Creates
 * the directory/file when absent, preserves every other key, and returns
 * false (never throws) on any read/parse/write failure — the caller reports
 * that persistence failed while the in-memory override still applies.
 */
export function persistPiLensGlobalConfigKey(
  configKey: string,
  value: boolean,
  configPath = getPiLensGlobalConfigPath(),
): boolean {
  try {
    let raw: Record<string, LspDictionaryValue> = {};
    try {
      // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;

      if (parsed && Check(Type.Object({}), parsed) && !Array.isArray(parsed)) {
        // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
        raw = parsed as Record<string, LspDictionaryValue>;
      }
    } catch {
      // absent or unreadable — start from an empty config
    }
    const segments = configKey.split(".");

    let target: MutableConfigDictionary = raw;
    for (const segment of segments.slice(0, -1)) {
      const existing = asConfigObject(target[segment]);
      if (existing) {
        target = existing;
      } else {
        const next: Record<string, LspDictionaryValue> = {};
        target[segment] = next;

        target = next;
      }
    }
    target[segments[segments.length - 1]] = value;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function asConfigObject(value: LspBoundaryValue): Record<string, LspDictionaryValue> | undefined {
  if (!value || !Check(Type.Object({}), value) || Array.isArray(value)) return undefined;
  // SAFETY: TypeBox established a non-array object, so string-key access preserves its runtime values.
  return value as Record<string, LspDictionaryValue>;
}

export function loadPiLensGlobalConfig(
  configPath = getPiLensGlobalConfigPath(),
): PiLensGlobalConfig | undefined {
  try {
    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;

    if (!parsed || !Check(Type.Object({}), parsed)) return undefined;

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const raw = parsed as Record<string, LspDictionaryValue>;
    const warnInvalid = (reason: string) => warnInvalidGlobalConfigOnce(configPath, reason);

    const config: Record<string, LspDictionaryValue> = {};

    for (const spec of LENS_FLAGS) {
      if (spec.readGlobal) continue;
      assignFlagConfigSection(raw, config, spec.configKey, warnInvalid);
    }

    const ignore = Array.isArray(raw.ignore)
      ? raw.ignore.filter((p): p is string => Check(Type.String(), p))
      : undefined;
    if (ignore && ignore.length > 0) config.ignore = ignore;

    const dispatch = asConfigObject(raw.dispatch);
    if (dispatch) {
      const floor = dispatch.runnerTimeoutFloorMs;

      if (Check(Type.Number(), floor) && Number.isFinite(floor) && floor > 0) {
        config.dispatch = { runnerTimeoutFloorMs: floor };
      } else {
        // #533: warn only when the key is PRESENT but malformed — an absent
        // key stays silent so a config that never mentions it is not falsely
        // flagged. Same warn-once path as the maxFixes case below.
        if ("runnerTimeoutFloorMs" in dispatch) {
          warnInvalid("dispatch.runnerTimeoutFloorMs must be a positive finite number");
        }
        config.dispatch = { runnerTimeoutFloorMs: undefined };
      }
    }

    const autoFix = asConfigObject(asConfigObject(raw.actionableWarnings)?.autoFix);
    if (autoFix && "maxFixes" in autoFix) {
      if (
        Check(Type.Number(), autoFix.maxFixes) &&
        Number.isFinite(autoFix.maxFixes) &&
        autoFix.maxFixes >= 0
      ) {
        config.actionableWarnings ??= {};

        // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
        const warnings = config.actionableWarnings as Record<string, LspDictionaryValue>;
        warnings.autoFix ??= {};

        // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
        (warnings.autoFix as Record<string, LspDictionaryValue>).maxFixes = Math.floor(
          autoFix.maxFixes,
        );
      } else {
        warnInvalid("actionableWarnings.autoFix.maxFixes must be a non-negative finite number");
      }
    }

    const widget = asConfigObject(raw.widget);
    if (widget) {
      if (Check(Type.Boolean(), widget.visible)) {
        config.widget = { visible: widget.visible };
      } else {
        // #533: present-but-wrong-type warns; absent stays silent.
        if ("visible" in widget) {
          warnInvalid("widget.visible must be a boolean");
        }
        config.widget = { visible: undefined };
      }
    }

    const format = asConfigObject(raw.format);
    if (format) {
      config.format ??= {};

      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const formatSection = config.format as Record<string, LspDictionaryValue>;
      if (format.mode === "immediate" || format.mode === "deferred") {
        formatSection.mode = format.mode;
      } else {
        // #533: a present-but-invalid mode (e.g. "immedaite") warns and
        // falls back; an absent mode stays silent.
        if ("mode" in format) {
          warnInvalid('format.mode must be "immediate" or "deferred"');
        }
        formatSection.mode = undefined;
      }
    }

    // #533 hygiene: a completely unknown top-level key (e.g. a typo like
    // `lps` for `lsp`) is otherwise dropped silently, so a setting the user
    // thought they made does nothing with no signal. Warn once per key. The
    // recognized set is single-sourced (#883): the flag sections derived
    // from the registry plus the declared non-flag global sections
    // (`GLOBAL_NON_FLAG_CONFIG_SECTIONS`, which co-locates `$schema` and the
    // hand-parsed namespaces beside the registry). Adding a flag needs no
    // edit here; adding a namespace is a one-line edit in that one constant.
    const knownGlobalConfigKeys = new Set<string>([
      ...flagConfigSectionKeys(LENS_FLAGS),
      ...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
    ]);
    for (const key of Object.keys(raw)) {
      if (!knownGlobalConfigKeys.has(key)) {
        warnInvalid(
          `unknown key "${key}" is not a recognized choco-pi-lsp setting (check for a typo); ignored`,
        );
      }
    }

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    return config as PiLensGlobalConfig;
  } catch {
    return undefined;
  }
}

export function getGlobalIgnorePatterns(configPath?: string): string[] {
  return loadPiLensGlobalConfig(configPath)?.ignore ?? [];
}

export function getGlobalWidgetDefaultVisible(configPath?: string): boolean {
  return loadPiLensGlobalConfig(configPath)?.widget?.visible !== false;
}

/** Per-turn quickfix cap; undefined means "use the built-in default of 5". */
export function getGlobalActionableWarningMaxFixes(configPath?: string): number | undefined {
  return loadPiLensGlobalConfig(configPath)?.actionableWarnings?.autoFix?.maxFixes;
}

/** Which tier decided a resolved flag's value — for provenance in debug/skip logs (#792). */
export type PiLensFlagSource =
  | "runtime"
  | "env"
  | "cli"
  | "project"
  | `nested-project:${string}`
  | "global"
  | "default";

export interface ResolvedPiLensFlag {
  value: boolean | string | undefined;
  source: PiLensFlagSource;
}

/**
 * Resolve a flag AND report which config tier decided it — same precedence
 * as {@link resolvePiLensFlag} (which now delegates here), just also
 * returning the `source` so callers can log e.g.
 * "(--no-autofix, source=project)" instead of a bare boolean (#792).
 *
 * Every tier is driven by `clients/lsp-flag-registry.ts` (#166): the spec's
 * `configKey` is read out of each config object rather than matched by a
 * per-flag branch, so a new toggle needs no change here at all.
 *
 * Precedence: env → cli → nested-project → project → global → default.
 * Project tiers apply to `scope: "project"` flags only (maintainer decision —
 * project wins over global, including re-enabling; only an explicit CLI
 * disabling flag outranks project config). A name with no registry entry
 * passes its CLI value straight through, which is how untyped string flags
 * like `--lens-opengrep-config` keep working.
 */
export function resolvePiLensFlagWithSource(
  name: string,
  value: boolean | string | undefined,
  config: PiLensGlobalConfig | undefined,
  projectConfig?: PiLensProjectConfig,
  editedFilePath?: string,
  projectRoot?: string,
): ResolvedPiLensFlag {
  const runtimeOverride = runtimeFlagOverrides.get(name);
  if (runtimeOverride !== undefined) {
    return { value: runtimeOverride, source: "runtime" };
  }
  const spec = getLensFlagSpec(name);
  if (spec?.env && process.env[spec.env] === "1") {
    return { value: true, source: "env" };
  }
  if (value) return { value, source: "cli" };
  if (!spec) return { value, source: "default" };

  if (spec.scope === "project") {
    const nested =
      editedFilePath && projectRoot
        ? findNestedProjectMutationValue(spec, editedFilePath, projectRoot)
        : undefined;
    if (nested) {
      return {
        value: flagValueFromConfig(spec, nested.value),
        source:
          // SAFETY: The checked element count and construction order establish this fixed tuple representation.
          path.resolve(nested.dir) === path.resolve(projectRoot as string)
            ? "project"
            : (`nested-project:${nested.dir}` as const),
      };
    }
    const projectValue = readFlagConfigValue(projectConfig, spec.configKey);
    if (projectValue !== undefined) {
      return {
        value: flagValueFromConfig(spec, projectValue),
        source: "project",
      };
    }
  }

  const globalValue = spec.readGlobal
    ? // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      spec.readGlobal((config ?? {}) as Record<string, LspDictionaryValue>)
    : readFlagConfigValue(config, spec.configKey);
  if (globalValue !== undefined) {
    return { value: flagValueFromConfig(spec, globalValue), source: "global" };
  }

  return { value: spec.default, source: "default" };
}

export function resolvePiLensFlag(
  name: string,
  value: boolean | string | undefined,
  config: PiLensGlobalConfig | undefined,
  projectConfig?: PiLensProjectConfig,
  editedFilePath?: string,
  projectRoot?: string,
): boolean | string | undefined {
  return resolvePiLensFlagWithSource(
    name,
    value,
    config,
    projectConfig,
    editedFilePath,
    projectRoot,
  ).value;
}
