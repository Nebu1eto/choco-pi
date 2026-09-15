import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { isJsonRecord, isNumber, isString } from "../../.pi/extensions/lib/runtime-values.ts";
import { parseJson, validateValue } from "./io.ts";
import { JsonSchema, type JsonValue, type SessionUsage, type TokenUsage } from "./types.ts";

const UsagePayloadSchema = Type.Object(
  {
    input: Type.Optional(Type.Number()),
    output: Type.Optional(Type.Number()),
    cacheRead: Type.Optional(Type.Number()),
    cacheWrite: Type.Optional(Type.Number()),
    cost: Type.Optional(
      Type.Union([
        Type.Number(),
        Type.Object({ total: Type.Optional(Type.Number()) }, { additionalProperties: true }),
      ]),
    ),
  },
  { additionalProperties: true },
);

const MessageBlockSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    arguments: Type.Optional(JsonSchema),
  },
  { additionalProperties: true },
);

const SessionRecordSchema = Type.Object(
  {
    message: Type.Optional(
      Type.Object(
        {
          role: Type.Optional(Type.String()),
          toolName: Type.Optional(Type.String()),
          isError: Type.Optional(Type.Boolean()),
          content: Type.Optional(Type.Array(MessageBlockSchema)),
          usage: Type.Optional(UsagePayloadSchema),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export type SessionRecord = Static<typeof SessionRecordSchema>;
type UsagePayload = Static<typeof UsagePayloadSchema>;

interface MessageUsageMeasurement {
  tokens: TokenUsage;
  cost: number;
}

interface SessionAccumulator {
  tokens: TokenUsage;
  perTurn: TokenUsage[];
  directToolCalls: string[];
  inExecToolCalls: string[];
  assistantMessages: string[];
  cost: number;
}

function finiteNumber(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function usageForMessage(usage: UsagePayload | undefined): MessageUsageMeasurement {
  const cost = usage?.cost;
  const totalCost = isJsonRecord(cost) ? cost.total : cost;
  return {
    tokens: {
      input: finiteNumber(usage?.input),
      cacheRead: finiteNumber(usage?.cacheRead),
      cacheWrite: finiteNumber(usage?.cacheWrite),
      output: finiteNumber(usage?.output),
    },
    cost: isNumber(totalCost) ? finiteNumber(totalCost) : 0,
  };
}

function addUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input += addition.input;
  total.cacheRead += addition.cacheRead;
  total.cacheWrite += addition.cacheWrite;
  total.output += addition.output;
}

function execSource(argumentsValue: JsonValue | undefined): string {
  if (!isJsonRecord(argumentsValue)) return "";
  return isString(argumentsValue.code) ? argumentsValue.code : "";
}

function recordAssistantMessage(
  message: NonNullable<SessionRecord["message"]>,
  accumulator: SessionAccumulator,
): void {
  const messageUsage = usageForMessage(message.usage);
  accumulator.perTurn.push(messageUsage.tokens);
  addUsage(accumulator.tokens, messageUsage.tokens);
  accumulator.cost += messageUsage.cost;

  const textBlocks: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" && block.text) textBlocks.push(block.text);
    if (block.type !== "toolCall" || !block.name) continue;

    accumulator.directToolCalls.push(block.name);
    if (block.name !== "exec") continue;
    const source = execSource(block.arguments);
    for (const match of source.matchAll(/tools\.([A-Za-z_][A-Za-z_0-9]*)\s*\(/g)) {
      const calledTool = match[1];
      if (calledTool) accumulator.inExecToolCalls.push(calledTool);
    }
  }
  if (textBlocks.length > 0) accumulator.assistantMessages.push(textBlocks.join("\n"));
}

export function parseSessionRecords(records: readonly SessionRecord[]): SessionUsage {
  const tokens: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const perTurn: TokenUsage[] = [];
  const directToolCalls: string[] = [];
  const inExecToolCalls: string[] = [];
  const toolErrors: string[] = [];
  const assistantMessages: string[] = [];
  let turns = 0;
  const accumulator: SessionAccumulator = {
    tokens,
    perTurn,
    directToolCalls,
    inExecToolCalls,
    assistantMessages,
    cost: 0,
  };

  for (const record of records) {
    const message = record.message;
    if (!message) continue;
    if (message.role === "user") turns += 1;
    if (message.role === "toolResult" && message.isError === true && message.toolName) {
      toolErrors.push(message.toolName);
    }
    if (message.role !== "assistant") continue;
    recordAssistantMessage(message, accumulator);
  }

  const assistantText = assistantMessages.join("\n");
  const discoveryFailures = [
    ...assistantText.matchAll(/tool not found|no such tool|cannot find (?:a )?tool/gi),
  ].length;
  return {
    turns,
    perTurn,
    tokens,
    cost: accumulator.cost,
    finalMessage: assistantMessages.at(-1) ?? "",
    assistantText,
    directToolCalls,
    inExecToolCalls,
    toolErrors,
    discoveryFailures,
  };
}

export async function readSessionUsage(sessionDirectory: string): Promise<SessionUsage> {
  const directoryEntries = await readdir(sessionDirectory);
  const fileNames = directoryEntries
    .filter((name) => name.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));
  const records: SessionRecord[] = [];
  for (const fileName of fileNames) {
    const contents = await readFile(join(sessionDirectory, fileName), "utf8");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      const value = validateValue(SessionRecordSchema, parseJson(line), "session JSONL record");
      records.push(value);
    }
  }
  return parseSessionRecords(records);
}
