import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { isString } from "./schema-check.ts";
import { assistantMessage, STEP_TOOL } from "./fake-sse.ts";
import type { EntryMarker } from "./transport-capture.ts";

export class MarkerBook {
  readonly #managers = new Map<string, SessionManager>();
  readonly #lists = new Map<string, EntryMarker[]>();
  readonly #isCurrent: () => boolean;
  constructor(isCurrent: () => boolean) {
    this.#isCurrent = isCurrent;
  }
  attach(manager: SessionManager): EntryMarker[] {
    const sessionId = manager.getSessionId();
    this.#managers.set(sessionId, manager);
    const list = this.#lists.get(sessionId) ?? [];
    this.#lists.set(sessionId, list);
    return list;
  }
  detach(sessionId: string): void {
    this.#managers.delete(sessionId);
  }
  manager(sessionId: string): SessionManager | undefined {
    return this.#managers.get(sessionId);
  }
  sync(sessionId: string): readonly EntryMarker[] {
    if (!this.#isCurrent()) throw new Error("Capture requested after harness disposal");
    const manager = this.#managers.get(sessionId);
    if (!manager) return [];
    const list = this.#lists.get(sessionId) ?? [];
    for (const entry of manager.getBranch()) addEntryTexts(list, entry);
    return list;
  }
}

function messageTexts(entry: SessionEntry): string[] {
  if (entry.type !== "message" || !("content" in entry.message)) return [];
  const content = entry.message.content;
  if (isString(content)) return content.length > 0 ? [content] : [];
  return content.flatMap((block) =>
    block.type === "text" && block.text.length > 0 ? [block.text] : [],
  );
}

function isKnown(list: readonly EntryMarker[], entry: SessionEntry, text: string): boolean {
  const stringContent =
    entry.type === "message" && "content" in entry.message && isString(entry.message.content);
  return list.some((item) => item.entryId === entry.id && (stringContent || item.text === text));
}

function addEntryTexts(list: EntryMarker[], entry: SessionEntry): void {
  for (const text of messageTexts(entry))
    if (!isKnown(list, entry, text)) list.push({ entryId: entry.id, text });
}

export interface SeedToolResults {
  readonly count: number;
  readonly chars: number;
}

export interface SeedOptions {
  readonly namespace?: string;
  readonly bytes?: number;
  readonly toolResults?: SeedToolResults;
  readonly model: Model<Api>;
}

const SEED_WORDS = [
  "the",
  "build",
  "step",
  "compiled",
  "module",
  "and",
  "wrote",
  "a",
  "cache",
  "entry",
  "for",
  "each",
  "source",
  "file",
  "after",
  "checking",
  "its",
  "imports",
  "against",
  "lock",
  "manifest",
  "while",
  "reporter",
  "counted",
  "warnings",
  "in",
  "parser",
  "output",
  "table",
  "row",
  "value",
  "changed",
  "between",
  "runs",
  "so",
  "index",
  "was",
  "rebuilt",
  "from",
  "scratch",
];
const WORDS_PER_LINE = 14;

export function seedToolResultText(namespace: string, index: number, chars: number): string {
  const header = `HARNESS-${namespace}-SEED-RESULT-${String(index).padStart(3, "0")}\n`;
  const parts = [header];
  let length = header.length;
  let state = Math.imul(index + 1, 0x9e_37_79_b1) >>> 0;
  let line = 0;
  while (length < chars) {
    const words: string[] = [`line ${index}.${line}:`];
    for (let word = 0; word < WORDS_PER_LINE; word++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      words.push(SEED_WORDS[(state >>> 16) % SEED_WORDS.length] ?? "the");
    }
    const text = `${words.join(" ")}.\n`;
    parts.push(text);
    length += text.length;
    line++;
  }
  return parts.join("").slice(0, chars);
}

function seedToolCall(namespace: string, index: number, model: Model<Api>): AssistantMessage {
  const base = assistantMessage("", model);
  return {
    ...base,
    content: [
      {
        type: "toolCall",
        id: `seed_call_${index}`,
        name: STEP_TOOL,
        arguments: { label: `HARNESS-${namespace}-SEED-STEP-${index}` },
      },
    ],
    stopReason: "toolUse",
  };
}

function seedToolExchanges(
  manager: SessionManager,
  namespace: string,
  options: SeedOptions,
): EntryMarker[] {
  const spec = options.toolResults;
  if (!spec) return [];
  const markers: EntryMarker[] = [];
  for (let index = 0; index < spec.count; index++) {
    manager.appendMessage(seedToolCall(namespace, index, options.model));
    const text = seedToolResultText(namespace, index, spec.chars);
    const entryId = manager.appendMessage({
      role: "toolResult",
      toolCallId: `seed_call_${index}`,
      toolName: STEP_TOOL,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    });
    markers.push({ entryId, text });
  }
  return markers;
}

export function seedPrefix(manager: SessionManager, options: SeedOptions): EntryMarker[] {
  const namespace = options.namespace ?? "SEED";
  const padding = options.bytes
    ? `\n${"offline-prefix-fact\n".repeat(Math.ceil(options.bytes / 20))}`
    : "";
  const [a, b, c] = ["A", "B", "C"].map((part) => `HARNESS-${namespace}-PREFIX-${part}`);
  if (a === undefined || b === undefined || c === undefined)
    throw new Error("Seed markers missing");
  const user = (text: string) =>
    manager.appendMessage({ role: "user", content: text + padding, timestamp: Date.now() });
  const seeded: EntryMarker[] = [
    { entryId: user(a), text: a },
    { entryId: manager.appendMessage(assistantMessage(b + padding, options.model)), text: b },
    { entryId: user(c), text: c },
    ...seedToolExchanges(manager, namespace, options),
  ];
  if (!options.bytes && !options.toolResults) return seeded;
  const complete = `HARNESS-${namespace}-SEED-COMPLETE`;
  seeded.push({
    entryId: manager.appendMessage(assistantMessage(complete, options.model)),
    text: complete,
  });
  return seeded;
}
