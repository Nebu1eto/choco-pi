import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type BoundaryValue, isObjectValue, parseBoundaryValue } from "../runtime-values.ts";
import { configPath } from "./defaults.ts";
import { type ConfigRecord, isRecord } from "./parse.ts";
import {
  mergeConfig,
  recordValue,
  resolveComponents,
  unsupportedSelectedStyleId,
} from "./resolve.ts";
import type { ComponentStyleOwner, ComponentsConfig, PolishedTuiConfig } from "./types.ts";
type ConfigFileState =
  | { kind: "missing"; record: ConfigRecord; writePath: string }
  | { kind: "valid"; record: ConfigRecord; writePath: string; mode: number }
  | { kind: "corrupt"; error: BoundaryValue };

function errorCode(error: BoundaryValue): string | undefined {
  return isObjectValue(error) && error !== null && "code" in error ? String(error.code) : undefined;
}

function readConfigFileState(path: string): ConfigFileState {
  let writePath = path;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink()) writePath = realpathSync(path);
    const targetStat = statSync(writePath);
    const parsed = JSON.parse(readFileSync(writePath, "utf8"));
    return isRecord(parsed)
      ? { kind: "valid", record: parsed, writePath, mode: targetStat.mode & 0o7777 }
      : { kind: "corrupt", error: new Error("top-level value must be a JSON object") };
  } catch (error) {
    const caughtError = parseBoundaryValue(error);
    if (errorCode(caughtError) === "ENOENT") {
      try {
        lstatSync(path);
      } catch (pathError) {
        if (errorCode(parseBoundaryValue(pathError)) === "ENOENT")
          return { kind: "missing", record: {}, writePath: path };
      }
    }
    return { kind: "corrupt", error: caughtError };
  }
}

function writeConfigAtomically(path: string, record: ConfigRecord, mode?: number): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let file: number | undefined;
  try {
    file = openSync(tempPath, "wx", mode ?? 0o666);
    if (mode !== undefined) fchmodSync(file, mode);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(tempPath, path);
  } catch (error) {
    if (file !== undefined) {
      try {
        closeSync(file);
      } catch {}
    }
    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      if (errorCode(parseBoundaryValue(cleanupError)) !== "ENOENT") {
      }
    }
    throw error;
  }
}

export function mutateConfig(
  path: string,
  mutate: (record: ConfigRecord) => void,
): PolishedTuiConfig {
  const state = readConfigFileState(path);
  if (state.kind === "corrupt") {
    const detail = state.error instanceof Error ? ` (${state.error.message})` : "";
    throw new Error(
      `Refusing to save choco-ui config because ${path} is corrupt or unreadable; fix or remove it first.${detail}`,
    );
  }
  mutate(state.record);
  writeConfigAtomically(
    state.writePath,
    state.record,
    state.kind === "valid" ? state.mode : undefined,
  );
  return mergeConfig(state.record);
}

export function ensureConfigExists(_path = configPath): void {}

export function loadConfig(): PolishedTuiConfig {
  try {
    if (!existsSync(configPath)) return mergeConfig({});
    return mergeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return mergeConfig({});
  }
}

function overlayKnown(raw: BoundaryValue, known: BoundaryValue): BoundaryValue {
  if (!isRecord(known)) return known;
  const output: ConfigRecord = isRecord(raw) ? { ...raw } : {};
  for (const [key, value] of Object.entries(known)) {
    Object.defineProperty(output, key, {
      value: overlayKnown(output[key], value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

type PreservedStyleIds = {
  editor?: string;
  userMessages?: string;
  selectorBorders?: string;
  footer?: string;
};

function unknownSelectedStyleIds(record: ConfigRecord): PreservedStyleIds {
  return {
    editor: unsupportedSelectedStyleId(record, "editor"),
    userMessages: unsupportedSelectedStyleId(record, "userMessages"),
    selectorBorders: unsupportedSelectedStyleId(record, "selectorBorders"),
    footer: unsupportedSelectedStyleId(record, "footer"),
  };
}

function restoreUnknownSelectedStyleIds(
  record: ConfigRecord,
  preserved: PreservedStyleIds,
  replacedStyle?: ComponentStyleOwner,
): void {
  const components = recordValue(record.components);
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  for (const [owner, style] of Object.entries(preserved) as [ComponentStyleOwner, string][]) {
    if (style === undefined || owner === replacedStyle) continue;
    const component = recordValue(components[owner]);
    component.style = style;
    components[owner] = component;
  }
  record.components = components;
}

export function saveComponentsMutation(
  update: (components: ComponentsConfig) => void,
  path: string,
  cleanupRaw?: (record: ConfigRecord) => void,
  replacedStyle?: ComponentStyleOwner,
): PolishedTuiConfig {
  return mutateConfig(path, (record) => {
    const preservedStyles = unknownSelectedStyleIds(record);
    const components = mergeConfig(record).components;
    update(components);
    const normalized = resolveComponents({ components });
    record.components = overlayKnown(record.components, normalized);
    restoreUnknownSelectedStyleIds(record, preservedStyles, replacedStyle);
    cleanupRaw?.(record);
  });
}

export function deleteLegacyEditorCopyFriendly(record: ConfigRecord): void {
  const components = record.components;
  if (!isRecord(components)) return;
  const editor = components.editor;
  if (!isRecord(editor)) return;
  const styles = editor.styles;
  if (!isRecord(styles)) return;
  const polished = styles.polished;
  if (isRecord(polished)) delete polished.copyFriendly;
}

export function deleteLegacyFooterEnabled(record: ConfigRecord): void {
  const components = record.components;
  if (!isRecord(components)) return;
  const footer = components.footer;
  if (isRecord(footer)) delete footer.enabled;
}

export function deleteLegacyMessageCopyFriendly(record: ConfigRecord): void {
  const components = record.components;
  if (!isRecord(components)) return;
  const userMessages = components.userMessages;
  if (!isRecord(userMessages)) return;
  const styles = userMessages.styles;
  if (!isRecord(styles)) return;
  const framed = styles.framed;
  if (isRecord(framed)) delete framed.copyFriendly;
}
