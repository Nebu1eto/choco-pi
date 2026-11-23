import { readFile } from "node:fs/promises";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  JsonValue,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  arr,
  bool,
  compile,
  map,
  nul,
  num,
  recursive,
  str,
  union,
} from "@earendil-works/pi-schema";
import { FALLBACK_CATALOG } from "../../../src/catalog/group.ts";
import type { CatalogModel } from "../../../src/catalog/group.ts";
import { DEFAULT_ANTIGRAVITY_ENDPOINT, PROVIDER_ID } from "../../../src/config.ts";
import type { StreamResponse } from "../../../src/stream/chunks.ts";
import type { FakeFetch } from "../../helpers.ts";

const JsonValueSchema = recursive<JsonValue>("HarnessJsonValue", (self) =>
  union([nul(), bool(), num(), str(), arr(self), map(self)]),
);
const isJsonValue = compile(JsonValueSchema).check;
const isJsonObject = compile(map(JsonValueSchema)).check;
const isJsonArray = compile(arr(JsonValueSchema)).check;
const isString = compile(str()).check;

export function at(
  value: JsonValue | undefined,
  ...path: (string | number)[]
): JsonValue | undefined {
  let current = value;
  for (const step of path) {
    if (isJsonArray(current) && Number.isInteger(step)) current = current[Number(step)];
    else if (isJsonObject(current)) current = current[String(step)];
    else return undefined;
  }
  return current;
}

export function stringAt(value: JsonValue | undefined, ...path: (string | number)[]): string {
  const found = at(value, ...path);
  if (!isString(found)) throw new Error(`no string at ${path.join(".")}`);
  return found;
}

export function keysAt(value: JsonValue | undefined, ...path: (string | number)[]): string[] {
  const found = at(value, ...path);
  return isJsonObject(found) ? Object.keys(found).sort() : [];
}

export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (!isJsonValue(value)) throw new Error("not JSON");
  return value;
}

export const PROJECT_ID = "aicode-consumers";
export const FAKE_TOKEN = "fake-access-token";
export const API_KEY = JSON.stringify({ token: FAKE_TOKEN, project_id: PROJECT_ID });
export const SIG_A = "RkFLRS1TSUctQQ==";
export const SIG_B = "RkFLRS1TSUctQg==";
export const CAPTURE_SIGNATURE = "RkFLRS1USE9VR0hULVNJR05BVFVSRS0wMDE=";

export function streamFixture(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

function catalogModel(id: string): CatalogModel {
  const model = FALLBACK_CATALOG.models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`fallback catalog has no ${id}`);
  return model;
}

export function testModel(id = "gemini-3.8-flash"): Model<"google-generative-ai"> {
  const model = catalogModel(id);
  const levels = new Set(model.variants.map((variant) => variant.level));
  const level = (name: "minimal" | "low" | "medium" | "high" | "xhigh" | "max") =>
    levels.has(name) ? name : null;
  return {
    id: model.id,
    name: model.name,
    api: "google-generative-ai",
    provider: PROVIDER_ID,
    baseUrl: DEFAULT_ANTIGRAVITY_ENDPOINT,
    reasoning: model.reasoning,
    input: model.images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: {
      off: null,
      minimal: level("minimal"),
      low: level("low"),
      medium: level("medium"),
      high: level("high"),
      xhigh: level("xhigh"),
      max: level("max"),
    },
  };
}

export function transcript(context: Context): TranscriptContext {
  return normalizeContext(context);
}

export function piFetch(fake: FakeFetch): typeof globalThis.fetch {
  return (input, init) =>
    fake.fetch(input instanceof Request ? input.url : String(input), init ?? {});
}

export function sseResponse(pieces: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

export function sseEvent(response: StreamResponse): string {
  return `data: ${JSON.stringify({ response })}\r\n\r\n`;
}

export function hangingSseResponse(
  first: string,
  signal: AbortSignal | null | undefined,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export interface Collected {
  events: AssistantMessageEvent[];
  result: AssistantMessage;
}

export async function collect(stream: AssistantMessageEventStream): Promise<Collected> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

export function terminalEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
  return events.filter((event) => event.type === "done" || event.type === "error");
}

export function sentBodies(fake: FakeFetch): JsonValue[] {
  return fake.calls.map((call) => parseJson(call.body));
}

export function keyPaths(value: JsonValue | undefined, depth: number, prefix = ""): string[] {
  if (depth === 0 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return keyPaths(value[0], depth, `${prefix}[]`);
  if (!isJsonObject(value)) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path, ...keyPaths(child, depth - 1, path));
  }
  return paths.sort();
}
