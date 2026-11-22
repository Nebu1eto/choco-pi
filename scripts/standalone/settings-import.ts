/**
 * `choco-pi self setup --import-pi-settings [--from <settings.json>]`: an
 * opt-in, one-time copy of preferences from Pi's settings into a standalone
 * choco-pi agent directory.
 *
 * It is the only standalone path that reads `~/.pi`, and it reads exactly one
 * file: `--from`, else `$HOME/.pi/agent/settings.json` (HOME from the
 * environment, never PI_CODING_AGENT_DIR, which the launcher points at
 * choco-pi's own agent directory). Nothing else under `~/.pi` is opened,
 * listed, stat'ed or written: no auth.json, sessions, trust.json, mcp.json,
 * models, skills or extensions.
 *
 * Only keys in IMPORTABLE_SETTINGS are copied, each validated against the
 * schema of the code that reads it. Precedence: a value changed in choco-pi
 * always wins. A key is imported when choco-pi lacks it, or when it still holds
 * exactly the value the standalone seed wrote. modelThinkingLevels merges per
 * model: a Pi entry replaces an entry that is absent or still equals the
 * installed profile default.
 *
 * At most once: `<agentDir>/choco-pi/settings-import.json` records the run and
 * is written before settings.json, both atomically. A second run refuses
 * without `--force`; even `--force` treats every key an earlier run imported
 * (or was about to) as the user's, so it never replaces or re-adds one.
 */
import path from "node:path";

import {
  arr,
  bool,
  compile,
  equal,
  int,
  lit,
  map,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";

import {
  AGENT_LANGUAGE_KEY,
  AGENT_ON_USAGE_LIMIT_KEY,
  AGENT_PERSONA_KEY,
  AGENT_STYLE_KEY,
  AUTO_COMPACTION_POINT_KEY,
  CONTEXT_PRESET_VALUES,
  CONTEXT_SOFT_CAP_KEY,
  DAYBREAK_DEFAULT_KEY,
  ON_USAGE_LIMIT_VALUES,
  PERSONA_VALUES,
  PROMPT_SUGGESTION_KEY,
  SESSION_AUTO_NAME_KEY,
  SESSION_AUTO_NAME_MODEL_KEY,
} from "../../profile/extensions/lib/agent-preferences.ts";
import {
  isJsonRecord,
  isString,
  type JsonRecord,
  type JsonValue,
} from "../../profile/extensions/lib/runtime-values.ts";
import {
  ANTHROPIC_COMPACTION_MODE_KEY,
  OPAQUE_HISTORY_KEY,
} from "../../packages/choco-pi-compaction/src/anthropic/mode.ts";
import { XAI_COMPACTION_MODE_KEY } from "../../packages/choco-pi-compaction/src/xai/mode.ts";
import { DEFAULT_PROFILE_MODEL_THINKING_LEVELS } from "../install-profile.ts";
import {
  jsonText,
  readAgentSettings,
  readOptional,
  readSettingsSeed,
  seededValues,
  writeTextAtomically,
} from "./settings-seed.ts";

/** Pi 1.6.0's ModelThinkingLevelSchema (pi-ai providers/model-schema). */
const THINKING_LEVEL = oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const NON_NEGATIVE_INT = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const TIMEOUT = union([num({ minimum: 0 }), lit("disabled")]);
const NAME = str({ minLength: 1 });

/**
 * Every key the import may copy, with the values its reader accepts. Pi keys
 * mirror Pi 1.6.0's SettingsSchema (pi-coding-agent dist/core/settings-schema.js)
 * as closed objects; choco-pi keys mirror their readers in
 * profile/extensions/lib/agent-preferences.ts, profile/extensions/prompt-editor.ts
 * and packages/choco-pi-compaction/src/{anthropic,xai}/mode.ts. No key here is
 * path-valued, an identity, a trust decision, a command, or a credential;
 * tests/standalone-settings-import.test.ts checks that every Pi 1.6.0 key is
 * either here or in EXCLUDED_SETTINGS.
 */
export const IMPORTABLE_SETTINGS = {
  // Pi 1.6.0
  defaultProvider: NAME,
  defaultModel: NAME,
  defaultThinkingLevel: THINKING_LEVEL,
  modelThinkingLevels: map(THINKING_LEVEL),
  transport: oneOf(["auto", "sse", "websocket", "websocket-cached"]),
  sessionShareDestination: oneOf(["auto", "gist", "radius"]),
  steeringMode: oneOf(["all", "one-at-a-time"]),
  followUpMode: oneOf(["all", "one-at-a-time"]),
  theme: NAME,
  compaction: obj({
    enabled: opt(bool()),
    reserveTokens: opt(NON_NEGATIVE_INT),
    keepRecentTokens: opt(NON_NEGATIVE_INT),
    modelOverrides: opt(
      map(obj({ reserveTokens: opt(NON_NEGATIVE_INT), keepRecentTokens: opt(NON_NEGATIVE_INT) })),
    ),
  }),
  branchSummary: obj({ reserveTokens: opt(num()), skipPrompt: opt(bool()) }),
  retry: obj({
    enabled: opt(bool()),
    maxRetries: opt(num()),
    baseDelayMs: opt(num()),
    maxAgentDelayMs: opt(num()),
    provider: opt(
      obj({ timeoutMs: opt(num()), maxRetries: opt(num()), maxRetryDelayMs: opt(num()) }),
    ),
    maxDelayMs: opt(num()),
  }),
  hideThinkingBlock: bool(),
  showCacheMissNotices: bool(),
  quietStartup: union([bool(), lit("header")]),
  collapseChangelog: bool(),
  enableInstallTelemetry: bool(),
  enableSkillCommands: bool(),
  terminal: obj({
    showImages: opt(bool()),
    imageWidthCells: opt(num()),
    clearOnShrink: opt(bool()),
    showTerminalProgress: opt(bool()),
    hyperlinks: opt(union([bool(), lit("auto")])),
    images: opt(union([lit("kitty"), lit("iterm2"), lit("auto"), lit(false)])),
    trueColor: opt(union([bool(), lit("auto")])),
  }),
  images: obj({ autoResize: opt(bool()), blockImages: opt(bool()) }),
  enabledModels: arr(NAME),
  defaultTools: arr(NAME),
  doubleEscapeAction: oneOf(["fork", "tree", "none"]),
  treeFilterMode: oneOf(["default", "no-tools", "user-only", "labeled-only", "all"]),
  thinkingBudgets: obj({
    minimal: opt(num()),
    low: opt(num()),
    medium: opt(num()),
    high: opt(num()),
  }),
  editorPaddingX: num(),
  outputPad: union([lit(0), lit(1)]),
  autocompleteMaxVisible: num(),
  showHardwareCursor: bool(),
  markdown: obj({
    codeBlockIndent: opt(str()),
    mermaid: opt(oneOf(["off", "final", "streaming"])),
  }),
  warnings: obj({ anthropicExtraUsage: opt(bool()) }),
  codemode: obj({ mode: opt(oneOf(["on", "only"])), inlineBudget: opt(num({ minimum: 0 })) }),
  httpIdleTimeoutMs: TIMEOUT,
  cacheWarming: oneOf(["off", "streaming", "idle"]),
  websocketConnectTimeoutMs: TIMEOUT,
  tuiMode: oneOf(["regular", "fullscreen"]),
  fullscreenExitOutput: oneOf(["transcript", "resume-hint"]),
  fullscreenScrollbar: oneOf(["auto", "always", "hidden"]),
  fullscreenCopyOnSelect: bool(),
  fullscreenWheelScrollLines: union([num(), lit("auto")]),
  // choco-pi readers
  [AGENT_LANGUAGE_KEY]: NAME,
  [AGENT_STYLE_KEY]: NAME,
  [AGENT_PERSONA_KEY]: oneOf(PERSONA_VALUES),
  [AGENT_ON_USAGE_LIMIT_KEY]: oneOf(ON_USAGE_LIMIT_VALUES),
  [DAYBREAK_DEFAULT_KEY]: union([bool(), lit("auto")]),
  [CONTEXT_SOFT_CAP_KEY]: oneOf(CONTEXT_PRESET_VALUES),
  [AUTO_COMPACTION_POINT_KEY]: oneOf(CONTEXT_PRESET_VALUES),
  [SESSION_AUTO_NAME_KEY]: bool(),
  [SESSION_AUTO_NAME_MODEL_KEY]: NAME,
  [PROMPT_SUGGESTION_KEY]: bool(),
  fuzzyFileMentions: bool(),
  [ANTHROPIC_COMPACTION_MODE_KEY]: oneOf(["server-side", "choco-pi"]),
  [XAI_COMPACTION_MODE_KEY]: oneOf(["server-side", "choco-pi"]),
  [OPAQUE_HISTORY_KEY]: oneOf(["preserve", "allow-loss"]),
} satisfies Record<string, Schema<unknown>>;

/** Known keys that are never imported, with the reason the report prints. */
export const EXCLUDED_SETTINGS = {
  $schema: "a schema reference, not a preference",
  lastChangelogVersion: "a changelog marker",
  extensionChangelogVersions: "a changelog marker",
  packages: "installer-owned paths",
  extensions: "installer-owned paths",
  skills: "installer-owned paths",
  prompts: "installer-owned paths",
  themes: "local paths",
  sessionDir: "a local path",
  shellPath: "an executable path",
  externalEditor: "a command",
  shellCommandPrefix: "a command",
  npmCommand: "a command",
  selfUpdateCommand: "a command",
  hooks: "personal commands (Rex's hook already reaches choco-pi through ~/.claude)",
  defaultProjectTrust: "a trust decision",
  scratchGrants: "a trust decision",
  deviceId: "an identity",
  trackingId: "an identity",
  enableAnalytics: "data-sharing consent that creates an identity",
  httpProxy: "a URL that can carry credentials",
  queueMode: "a deprecated setting",
  websockets: "a deprecated setting",
} satisfies Record<string, string>;
const excludedReasons = new Map(Object.entries(EXCLUDED_SETTINGS));

const checks = new Map(
  Object.entries(IMPORTABLE_SETTINGS).map(([key, schema]) => [key, compile(schema)]),
);
const profileThinkingLevels = new Map(Object.entries(DEFAULT_PROFILE_MODEL_THINKING_LEVELS));

/** True when `key` names an importable preference. */
export function isImportableSetting(key: string): boolean {
  return checks.has(key);
}

/**
 * A string that reads as a secret: a URL with user info, a known token
 * prefix, a bearer header, or a long unbroken token-like run.
 */
const CREDENTIAL_TEXT =
  /:\/\/[^/\s@]*@|^(?:sk|pk|rk)-|^(?:ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat)[-_]|^AKIA[0-9A-Z]{12}|^AIza|^bearer\s|[A-Za-z0-9_+=-]{40,}/i;
const CREDENTIAL_NAME = /secret|password|passwd|credential|api[-_]?key|auth|cookie|token$/i;

/** True when any string or object key inside `value` looks like a credential. */
export function looksLikeCredential(value: JsonValue): boolean {
  if (isString(value)) return CREDENTIAL_TEXT.test(value);
  if (Array.isArray(value)) return value.some(looksLikeCredential);
  if (isJsonRecord(value))
    return Object.entries(value).some(
      ([key, nested]) => CREDENTIAL_NAME.test(key) || looksLikeCredential(nested),
    );
  return false;
}

const ImportRecordSchema = obj({
  schema: lit(1),
  source: str(),
  imported_at: str(),
  imported: arr(str()),
  imported_model_thinking_levels: arr(str()),
  skipped: arr(obj({ key: str(), reason: str() })),
  kept: arr(str()),
});
const isImportRecord = compile(ImportRecordSchema).check;
export type ImportRecord = Static<typeof ImportRecordSchema>;

export function importRecordPath(agentDir: string): string {
  return path.join(agentDir, "choco-pi", "settings-import.json");
}

export async function readImportRecord(agentDir: string): Promise<ImportRecord | null> {
  const file = importRecordPath(agentDir);
  const text = await readOptional(file);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error });
  }
  if (!isImportRecord(parsed)) throw new Error(`${file} does not match the import record schema`);
  return parsed;
}

/**
 * The one file the import reads: `from` resolved against `cwd`, else
 * `$HOME/.pi/agent/settings.json` with HOME from `environment`.
 */
export function importSourcePath(
  from: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (from !== undefined) return path.resolve(cwd, from);
  const home = environment.HOME;
  if (home === undefined || !path.isAbsolute(home))
    throw new Error("HOME is not an absolute path; name the Pi settings file with --from");
  return path.join(home, ".pi", "agent", "settings.json");
}

/**
 * Refuses a second import unless `force`; call before any other setup step so
 * a refused run changes nothing.
 */
export async function assertImportAllowed(agentDir: string, force: boolean): Promise<void> {
  const record = await readImportRecord(agentDir);
  if (record !== null && !force)
    throw new Error(
      `Pi settings were already imported on ${record.imported_at} from ${record.source} (recorded in ${importRecordPath(agentDir)}); rerun with --force to import keys that are still unset or seeded defaults`,
    );
}

export type ImportResult = ImportRecord & { record_path: string; settings_changed: boolean };

/**
 * Imports `source` into `<agentDir>/settings.json` (see the module comment).
 * Run it after the profile install and the seed, so seeded keys are known.
 */
export async function importPiSettings(
  agentDir: string,
  source: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<ImportResult> {
  const settingsPath = path.join(agentDir, "settings.json");
  if (path.resolve(source) === path.resolve(settingsPath))
    throw new Error(`${source} is choco-pi's own settings file`);
  const previous = await readImportRecord(agentDir);
  if (previous !== null && options.force !== true)
    throw new Error(`Pi settings were already imported; rerun with --force`);

  const sourceText = await readOptional(source);
  if (sourceText === null) throw new Error(`no Pi settings file at ${source}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`${source} does not contain valid JSON`, { cause: error });
  }
  if (!isJsonRecord(parsed)) throw new Error(`${source} is not a JSON object`);
  const pi: JsonRecord = parsed;

  const settings = await readAgentSettings(agentDir);
  const seeded = await seededValues(agentDir, await readSettingsSeed());
  const earlier = new Set(previous?.imported ?? []);
  const earlierModels = new Set(previous?.imported_model_thinking_levels ?? []);
  const imported: string[] = [];
  const importedModels: string[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const kept: string[] = [];

  for (const [key, value] of Object.entries(pi)) {
    const validator = checks.get(key);
    if (validator === undefined) {
      skipped.push({ key, reason: excludedReasons.get(key) ?? "not an importable preference" });
      continue;
    }
    if (looksLikeCredential(value)) {
      skipped.push({ key, reason: "the value looks like a credential" });
      continue;
    }
    if (!validator.check(value)) {
      skipped.push({ key, reason: "the value is not valid for its reader" });
      continue;
    }
    if (key === "modelThinkingLevels" && isJsonRecord(value)) {
      const existing = settings[key];
      const current: JsonRecord = {};
      if (isJsonRecord(existing)) Object.assign(current, existing);
      for (const [model, level] of Object.entries(value)) {
        const mine = current[model];
        if (equal(mine, level)) continue;
        const replaceable =
          !earlierModels.has(model) &&
          (mine === undefined ||
            (profileThinkingLevels.has(model) && mine === profileThinkingLevels.get(model)));
        if (replaceable) {
          current[model] = level;
          importedModels.push(model);
        } else kept.push(`${key}[${JSON.stringify(model)}]`);
      }
      if (importedModels.length > 0) {
        settings[key] = current;
        imported.push(key);
      }
      continue;
    }
    const present = Object.hasOwn(settings, key);
    const mine = settings[key];
    if (present && equal(mine, value)) continue;
    if (earlier.has(key)) {
      // An earlier run imported this key, or was about to: it is the user's now.
      kept.push(key);
      continue;
    }
    const seededDefault = present && seeded.has(key) && equal(mine, seeded.get(key));
    if (!present || seededDefault) {
      settings[key] = structuredClone(value);
      imported.push(key);
    } else kept.push(key);
  }

  const record: ImportRecord = {
    schema: 1,
    source,
    imported_at: (options.now ?? new Date()).toISOString(),
    imported: [...new Set([...(previous?.imported ?? []), ...imported])],
    imported_model_thinking_levels: [...new Set([...earlierModels, ...importedModels])],
    skipped,
    kept,
  };
  const recordPath = importRecordPath(agentDir);
  // The record first: if the settings write then fails, these keys stay
  // unimported, and no later run adds them (at most once, like the seed).
  await writeTextAtomically(recordPath, jsonText(record));
  if (imported.length > 0) await writeTextAtomically(settingsPath, jsonText(settings));
  return {
    ...record,
    imported,
    imported_model_thinking_levels: importedModels,
    record_path: recordPath,
    settings_changed: imported.length > 0,
  };
}

/** The report lines: key names and reasons only, never a value. */
export function importReport(result: ImportResult): string[] {
  const lines = [`imported Pi settings from ${result.source}`];
  lines.push(`imported: ${result.imported.length > 0 ? result.imported.join(", ") : "(none)"}`);
  if (result.imported_model_thinking_levels.length > 0)
    lines.push(
      `imported modelThinkingLevels for: ${result.imported_model_thinking_levels.join(", ")}`,
    );
  for (const { key, reason } of result.skipped) lines.push(`skipped: ${key} (${reason})`);
  for (const key of result.kept)
    lines.push(`kept: ${key} (choco-pi already has a value you set; it wins)`);
  lines.push(`recorded: ${result.record_path}`);
  return lines;
}
