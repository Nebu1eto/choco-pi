import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export type AdvisorEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: AdvisorEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export interface AdvisorSettings {
  enabled: boolean;
  model: string;
  effort: AdvisorEffort;
  maxUses?: number;
}
export const DEFAULT_SETTINGS: AdvisorSettings = {
  enabled: false,
  model: "anthropic/claude-fable-5-1",
  effort: "low",
};
const effortSchema = Type.Union(EFFORTS.map((effort) => Type.Literal(effort)));
const layerSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String({ minLength: 1 })),
  effort: Type.Optional(effortSchema),
  maxUses: Type.Optional(Type.Integer({ minimum: 1 })),
});
const missingSchema = Type.Object({ code: Type.Literal("ENOENT") });
const jsonObjectSchema = Type.Object({}, { additionalProperties: Type.Unknown() });
type JsonObject = Static<typeof jsonObjectSchema>;

export interface SettingsLayer {
  settings: Partial<AdvisorSettings>;
  warnings: string[];
}
export interface LoadedSettings {
  settings: AdvisorSettings;
  warnings: string[];
}

async function readSettingsFile(path: string): Promise<SettingsLayer> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Value.Check(layerSchema, parsed)) throw new Error("invalid settings");
    return { settings: parsed, warnings: [] };
  } catch (error) {
    if (Value.Check(missingSchema, error)) return { settings: {}, warnings: [] };
    return {
      settings: { ...DEFAULT_SETTINGS, maxUses: undefined },
      warnings: [`Could not read advisor settings at ${path}; using defaults for this layer.`],
    };
  }
}

export async function readSettingsLayer(path: string): Promise<SettingsLayer> {
  const layer = await readSettingsFile(path);
  const settings: Partial<AdvisorSettings> = {};
  if (layer.settings.enabled !== undefined) settings.enabled = layer.settings.enabled;
  if (layer.settings.model !== undefined) settings.model = layer.settings.model;
  if (layer.settings.effort !== undefined) settings.effort = layer.settings.effort;
  if ("maxUses" in layer.settings) settings.maxUses = layer.settings.maxUses;
  return { settings, warnings: layer.warnings };
}

export async function loadAdvisorSettings(agentDir: string, cwd: string): Promise<LoadedSettings> {
  const [global, project] = await Promise.all([
    readSettingsLayer(join(agentDir, "advisor.json")),
    readSettingsLayer(join(cwd, ".pi", "advisor.json")),
  ]);
  const { maxUses, ...rest } = { ...DEFAULT_SETTINGS, ...global.settings, ...project.settings };
  const settings: AdvisorSettings = rest;
  if (maxUses !== undefined) settings.maxUses = maxUses;
  return { settings, warnings: [...global.warnings, ...project.warnings] };
}

async function readRawSettingsForWrite(path: string): Promise<JsonObject> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Value.Check(jsonObjectSchema, parsed))
      throw new Error("advisor settings must be a JSON object");
    return parsed;
  } catch (error) {
    if (Value.Check(missingSchema, error)) return { ...DEFAULT_SETTINGS };
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not update advisor settings at ${path}: ${detail}`);
  }
}

export async function writeGlobalAdvisorSettings(
  agentDir: string,
  partial: Partial<AdvisorSettings>,
): Promise<void> {
  const path = join(agentDir, "advisor.json");
  const previous = await readRawSettingsForWrite(path);
  if (!Value.Check(layerSchema, partial)) throw new Error("Invalid advisor settings update");
  const next = { ...previous, ...partial };
  await mkdir(agentDir, { recursive: true });
  const temporary = join(agentDir, `.advisor-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
