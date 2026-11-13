// Strict JSON for agent- and file-supplied documents. JSON.parse keeps the last of two equal keys, so a document such
// as {"verdict":"INCOMPLETE","verdict":"NO_FINDINGS"} would silently read as the second value. These helpers reject a
// duplicate key in any object at any depth, comparing keys after unescaping ("a" equals "\u0061").
import type { RuntimeValue } from "./runtime-values.ts";

export type StrictJsonParse = { ok: true; value: RuntimeValue } | { ok: false; error: string };

type Frame = { keys: Set<string>; expectKey: boolean } | undefined;

/**
 * Returns the first duplicate object key in `text`, or undefined when there is none. `text` must already be valid
 * JSON (call JSON.parse first): the scan only tracks strings and structure, so it stays linear and never recurses.
 */
export function findDuplicateKey(text: string): string | undefined {
  // An array frame is undefined; an object frame records its keys and whether the next string is a key.
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

/** JSON.parse that also rejects a duplicate key at any depth. Never throws. */
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
