import { isBoolean, isObject, isString, type RuntimeValue } from "../../lib/runtime-values.ts";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_HIGHLIGHT } from "../../lib/changes/render/highlight.ts";
import type { EditorConfig, ResolvedReviewConfig, ReviewConfig } from "./types.ts";

export { DEFAULT_HIGHLIGHT };

export const REVIEW_CONFIG_FILE = "review.json";

export const DEFAULT_EDITOR: EditorConfig = {
  command: ["zed", "--wait", "{path}:{line}"],
  mode: "gui",
};

export type ReviewConfigEnv = Record<string, string | undefined>;

export type EditorAvailabilityProbe = (command: string) => Promise<boolean>;

async function executableOnPath(command: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export const defaultEditorAvailabilityProbe: EditorAvailabilityProbe = (command) =>
  executableOnPath(command);

export type LoadReviewConfigOptions = {
  cwd: string;
  agentDir?: string;
  env?: ReviewConfigEnv;
  isEditorAvailable?: EditorAvailabilityProbe;
};

function plainObject(
  value: RuntimeValue,
  field: string,
  source: string,
): Record<string, RuntimeValue> | undefined {
  if (value === undefined) return undefined;
  if (!value || !isObject(value) || Array.isArray(value)) {
    throw new Error(`${source}: ${field} must be a JSON object`);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return value as Record<string, RuntimeValue>;
}

function booleanField(value: RuntimeValue, field: string, source: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (!isBoolean(value)) throw new Error(`${source}: ${field} must be a boolean`);
  return value;
}

function positiveInteger(value: RuntimeValue, field: string, source: string): number | undefined {
  if (value === undefined) return undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${source}: ${field} must be a positive integer`);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return value as number;
}

function stringArray(value: RuntimeValue, field: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !isString(entry))) {
    throw new Error(`${source}: ${field} must be an array of strings`);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return [...(value as string[])];
}

function editorField(value: RuntimeValue, source: string): EditorConfig | undefined {
  const editor = plainObject(value, "editor", source);
  if (!editor) return undefined;
  const command = stringArray(editor.command, "editor.command", source);
  if (!command || command.length === 0) {
    throw new Error(`${source}: editor.command must be a non-empty array of strings`);
  }
  if (editor.mode !== "gui" && editor.mode !== "terminal") {
    throw new Error(`${source}: editor.mode must be "gui" or "terminal"`);
  }
  return { command, mode: editor.mode };
}

export function parseReviewConfig(content: string, source: string): ReviewConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${source} must contain valid JSON`, { cause: error });
  }
  if (!parsed || !isObject(parsed) || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const root = parsed as Record<string, RuntimeValue>;
  const highlight = plainObject(root.highlight, "highlight", source);
  const heuristics = plainObject(root.heuristics, "heuristics", source);
  return {
    editor: editorField(root.editor, source),
    highlight: highlight && {
      enabled: booleanField(highlight.enabled, "highlight.enabled", source),
      maxFileBytes: positiveInteger(highlight.maxFileBytes, "highlight.maxFileBytes", source),
      maxDiffLines: positiveInteger(highlight.maxDiffLines, "highlight.maxDiffLines", source),
    },
    heuristics: heuristics && {
      riskPatterns: stringArray(heuristics.riskPatterns, "heuristics.riskPatterns", source),
      collapsePatterns: stringArray(
        heuristics.collapsePatterns,
        "heuristics.collapsePatterns",
        source,
      ),
    },
  };
}

export async function resolveEditor(
  configured: EditorConfig | undefined,
  env: ReviewConfigEnv,
  isEditorAvailable: EditorAvailabilityProbe = defaultEditorAvailabilityProbe,
): Promise<EditorConfig> {
  if (configured) return { command: [...configured.command], mode: configured.mode };
  if (await isEditorAvailable(DEFAULT_EDITOR.command[0]!)) {
    return { command: [...DEFAULT_EDITOR.command], mode: DEFAULT_EDITOR.mode };
  }
  const fromEnv = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (fromEnv) return { command: [...fromEnv.split(/\s+/), "{path}"], mode: "terminal" };
  return { command: [...DEFAULT_EDITOR.command], mode: DEFAULT_EDITOR.mode };
}

export async function resolveReviewConfig(
  config: ReviewConfig,
  env: ReviewConfigEnv,
  isEditorAvailable: EditorAvailabilityProbe = defaultEditorAvailabilityProbe,
): Promise<ResolvedReviewConfig> {
  return {
    editor: await resolveEditor(config.editor, env, isEditorAvailable),
    highlight: {
      enabled: config.highlight?.enabled ?? DEFAULT_HIGHLIGHT.enabled,
      maxFileBytes: config.highlight?.maxFileBytes ?? DEFAULT_HIGHLIGHT.maxFileBytes,
      maxDiffLines: config.highlight?.maxDiffLines ?? DEFAULT_HIGHLIGHT.maxDiffLines,
    },
    heuristics: {
      riskPatterns: config.heuristics?.riskPatterns ?? [],
      collapsePatterns: config.heuristics?.collapsePatterns ?? [],
    },
  };
}

export async function loadReviewConfig(
  options: LoadReviewConfigOptions,
): Promise<ResolvedReviewConfig> {
  const env = options.env ?? process.env;
  const isEditorAvailable = options.isEditorAvailable ?? defaultEditorAvailabilityProbe;
  const configPaths = [
    join(options.cwd, ".pi", "extensions", REVIEW_CONFIG_FILE),
    join(options.agentDir ?? getAgentDir(), "extensions", REVIEW_CONFIG_FILE),
  ];
  for (const configPath of configPaths) {
    let content: string;
    try {
      content = await readFile(configPath, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      continue;
    }
    return resolveReviewConfig(parseReviewConfig(content, configPath), env, isEditorAvailable);
  }
  return resolveReviewConfig({}, env, isEditorAvailable);
}
