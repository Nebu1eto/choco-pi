import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import {
  cacheableSegments,
  canonicalJson,
  prefixAttribution,
  providerPrefixMetricsFromPayload,
  systemRegionHashes,
  systemText,
} from "../../.pi/extensions/cache-probe.ts";
import { isJsonRecord, type JsonRecord } from "../../.pi/extensions/lib/runtime-values.ts";
import { parseJson, validateValue } from "./io.ts";
import {
  CaptureRecordSchema,
  type AuditReport,
  type CaptureRecord,
  type JsonValue,
  type SessionUsage,
  type TokenMeasurement,
  type ToolNameDiff,
} from "./types.ts";

const CountTokensResponseSchema = Type.Object(
  { input_tokens: Type.Number() },
  { additionalProperties: true },
);

const anthropicApiHost = process.env.CHOCO_PI_ANTHROPIC_API_HOST ?? "api.anthropic.com";

interface NamedSection {
  name: string;
  text: string;
}

interface CountTokensClient {
  count(system: JsonValue, tools: JsonValue[]): Promise<number>;
}

export function bearerTokenFromOutput(output: string): string | undefined {
  const nonEmptyLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = nonEmptyLines.at(-1);
  return lastLine && !/\s/.test(lastLine) ? lastLine : undefined;
}

function executeFile(file: string, argumentsToPass: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, argumentsToPass, { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function anthropicCountTokensClient(model: string): Promise<CountTokensClient | undefined> {
  if (!model.startsWith("anthropic/")) return undefined;
  let output: string;
  try {
    output = await executeFile("pi", ["auth", "print-bearer-token", "--provider", "anthropic"]);
  } catch {
    return undefined;
  }
  const token = bearerTokenFromOutput(output);
  if (!token) return undefined;

  return {
    async count(system, tools) {
      const countTokensUrl = new URL("/v1/messages/count_tokens", `https://${anthropicApiHost}`);
      const response = await fetch(countTokensUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model.slice("anthropic/".length),
          system,
          tools,
          messages: [{ role: "user", content: "ok" }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Anthropic count_tokens returned HTTP ${response.status}`);
      const value = validateValue(
        CountTokensResponseSchema,
        parseJson(await response.text()),
        "Anthropic count_tokens response",
      );
      return value.input_tokens;
    },
  };
}

function requestObject(payload: JsonValue): JsonRecord {
  return isJsonRecord(payload) ? payload : {};
}

export function countStructuralRewrites(records: readonly CaptureRecord[]): number {
  let rewrites = 0;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (!previous || !current) continue;
    if (previous.systemHash !== current.systemHash || previous.toolsHash !== current.toolsHash) {
      rewrites += 1;
    }
  }
  return rewrites;
}

function commonToolOrder(names: readonly string[], otherNames: readonly string[]): string[] {
  const otherSet = new Set(otherNames);
  return names.filter((name) => otherSet.has(name));
}

export function diffToolNames(records: readonly CaptureRecord[]): ToolNameDiff[] {
  return records.map((record, index) => {
    const previous = records[index - 1];
    if (!previous) {
      return {
        requestIndex: record.requestIndex,
        systemChanged: false,
        toolsChanged: false,
        added: [],
        removed: [],
        orderChanged: false,
      };
    }
    const previousSet = new Set(previous.toolNames);
    const currentSet = new Set(record.toolNames);
    const previousCommonOrder = commonToolOrder(previous.toolNames, record.toolNames);
    const currentCommonOrder = commonToolOrder(record.toolNames, previous.toolNames);
    return {
      requestIndex: record.requestIndex,
      systemChanged: previous.systemHash !== record.systemHash,
      toolsChanged: previous.toolsHash !== record.toolsHash,
      added: record.toolNames.filter((name) => !previousSet.has(name)),
      removed: previous.toolNames.filter((name) => !currentSet.has(name)),
      orderChanged: canonicalJson(previousCommonOrder) !== canonicalJson(currentCommonOrder),
    };
  });
}

export function splitSystemSections(system: string): NamedSection[] {
  const markerPattern = /^(?:# [^\n]+|<[a-z][a-z0-9_]*>)\s*$/gm;
  const markers = [...system.matchAll(markerPattern)].flatMap((match) =>
    match.index === undefined ? [] : [{ name: match[0].trim(), index: match.index }],
  );
  const boundaries = markers[0]?.index === 0 ? markers : [{ name: "base", index: 0 }, ...markers];
  return boundaries.map((boundary, index) => ({
    name: boundary.name,
    text: system.slice(boundary.index, boundaries[index + 1]?.index ?? system.length),
  }));
}

async function measuredSections(
  sections: readonly NamedSection[],
  counter: CountTokensClient | undefined,
  emptyRequestTokens: number | undefined,
): Promise<TokenMeasurement[]> {
  const measurements: TokenMeasurement[] = [];
  for (const section of sections) {
    if (counter && emptyRequestTokens !== undefined) {
      measurements.push({
        name: section.name,
        chars: section.text.length,
        tokens: (await counter.count(section.text, [])) - emptyRequestTokens,
        method: "Anthropic count_tokens marginal versus an empty request",
      });
    } else {
      measurements.push({
        name: section.name,
        chars: section.text.length,
        tokens: Math.ceil(section.text.length / 4),
        method: "chars/4 estimate",
      });
    }
  }
  return measurements;
}

async function measuredTools(
  tools: readonly JsonValue[],
  names: readonly string[],
  counter: CountTokensClient | undefined,
  emptyRequestTokens: number | undefined,
): Promise<TokenMeasurement[]> {
  const measurements: TokenMeasurement[] = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (tool === undefined) continue;
    const serialized = canonicalJson(tool);
    const name = names[index] ?? `tool-${index + 1}`;
    if (counter && emptyRequestTokens !== undefined) {
      measurements.push({
        name,
        chars: serialized.length,
        tokens: (await counter.count("", [tool])) - emptyRequestTokens,
        method: "Anthropic count_tokens marginal versus an empty request; values are non-additive",
      });
    } else {
      measurements.push({
        name,
        chars: serialized.length,
        tokens: Math.ceil(serialized.length / 4),
        method: "chars/4 estimate",
      });
    }
  }
  return measurements;
}

export async function readCaptureRecords(path: string): Promise<CaptureRecord[]> {
  const contents = await readFile(path, "utf8");
  return contents.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    return [validateValue(CaptureRecordSchema, parseJson(line), "prefix capture record")];
  });
}

async function readPayloads(
  capturePath: string,
  records: readonly CaptureRecord[],
): Promise<JsonValue[]> {
  const payloads: JsonValue[] = [];
  for (const record of records) {
    payloads.push(
      parseJson(await readFile(`${capturePath}.${record.requestIndex}.payload.json`, "utf8")),
    );
  }
  return payloads;
}

function attributionForPayloads(records: readonly CaptureRecord[], payloads: readonly JsonValue[]) {
  let previousSegments: ReturnType<typeof cacheableSegments> | undefined;
  let previousRegions: ReturnType<typeof systemRegionHashes> | undefined;
  let previousModel: string | undefined;
  return payloads.map((payload, index) => {
    const currentSegments = cacheableSegments(payload);
    const currentRegions = systemRegionHashes(systemText(payload));
    const model = records[index]?.model ?? "unknown";
    const attribution = prefixAttribution({
      previous: previousSegments?.segments,
      current: currentSegments.segments,
      previousRegions,
      currentRegions,
      previousModel,
      currentModel: model,
    });
    previousSegments = currentSegments;
    previousRegions = currentRegions;
    previousModel = model;
    return {
      requestIndex: records[index]?.requestIndex ?? index + 1,
      state: attribution.state,
      firstDivergence: attribution.firstDivergence,
      systemRegions: attribution.systemRegions,
    };
  });
}

export async function buildPrefixReport(input: {
  model: string;
  thinking: string;
  cwd: string;
  capturePath: string;
  usage: SessionUsage;
  wallMs: number;
}): Promise<AuditReport> {
  const records = await readCaptureRecords(input.capturePath);
  const payloads = await readPayloads(input.capturePath, records);
  const firstPayload = payloads[0] ?? {};
  const firstRequest = requestObject(firstPayload);
  const systemValue = firstRequest.system ?? firstRequest.instructions ?? "";
  const system = systemText(firstPayload);
  const tools = Array.isArray(firstRequest.tools) ? firstRequest.tools : [];
  const notes = ["Noninteractive -p mode does not expose interactive UI tools."];

  let counter: CountTokensClient | undefined;
  let emptyRequestTokens: number | undefined;
  try {
    counter = await anthropicCountTokensClient(input.model);
    if (counter) emptyRequestTokens = await counter.count("", []);
  } catch (error) {
    notes.push(error instanceof Error ? error.message : "Anthropic count_tokens failed");
    counter = undefined;
    emptyRequestTokens = undefined;
  }

  const systemSections = await measuredSections(
    splitSystemSections(system),
    counter,
    emptyRequestTokens,
  );
  const toolMeasurements = await measuredTools(
    tools,
    records[0]?.toolNames ?? [],
    counter,
    emptyRequestTokens,
  );

  let prefixTokens: AuditReport["prefixTokens"];
  if (counter && emptyRequestTokens !== undefined) {
    const systemOnly = await counter.count(systemValue, []);
    const total = await counter.count(systemValue, tools);
    prefixTokens = {
      total,
      system: systemOnly - emptyRequestTokens,
      tools: total - systemOnly,
      method: "Anthropic count_tokens; total includes the fixed user message 'ok'",
    };
  } else {
    const estimates = providerPrefixMetricsFromPayload(firstPayload);
    prefixTokens = {
      total: estimates.systemTokens + estimates.toolsTokens,
      system: estimates.systemTokens,
      tools: estimates.toolsTokens,
      method: "chars/4 estimate; provider has no count_tokens endpoint or counting was unavailable",
    };
  }

  return {
    model: input.model,
    thinking: input.thinking,
    cwd: input.cwd,
    requests: records,
    rewrites: countStructuralRewrites(records),
    changes: diffToolNames(records),
    attribution: attributionForPayloads(records, payloads),
    systemSections,
    tools: toolMeasurements,
    prefixTokens,
    usage: input.usage,
    wallMs: input.wallMs,
    toolNames: records[0]?.toolNames ?? [],
    notes,
  };
}
