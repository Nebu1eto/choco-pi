import type { RuntimeValue } from "./runtime-values.ts";

export type StrictJsonParse = { ok: true; value: RuntimeValue } | { ok: false; error: string };

type Frame = { keys: Set<string>; expectKey: boolean } | undefined;

export function findDuplicateKey(text: string): string | undefined {
  const stack: Frame[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      const frame = stack.at(-1);
      if (frame?.expectKey) {
        const raw = text.slice(start, index + 1);
        const key = raw.includes("\\") ? String(JSON.parse(raw)) : raw.slice(1, -1);
        if (frame.keys.has(key)) return key;
        frame.keys.add(key);
        frame.expectKey = false;
      }
    } else if (char === "{") {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (char === "[") {
      stack.push(undefined);
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ",") {
      const frame = stack.at(-1);
      if (frame) frame.expectKey = true;
    }
    index += 1;
  }
  return undefined;
}

export function parseStrictJson(text: string): StrictJsonParse {
  let value: RuntimeValue;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "parse failure" };
  }
  try {
    const duplicate = findDuplicateKey(text);
    if (duplicate !== undefined) {
      return { ok: false, error: `duplicate key ${JSON.stringify(duplicate)}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "parse failure" };
  }
  return { ok: true, value };
}
