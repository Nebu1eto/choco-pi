import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isObject, isString, type RuntimeValue } from "../../lib/runtime-values.ts";

export type HiddenPaths = () => readonly string[];

const NAME_CHARACTER = /[\p{L}\p{N}\p{M}_.-]/u;

const ESCAPES = /[\\`^]/gu;
const QUOTES_AND_ESCAPES = /["'\\`^]/gu;

const FOLDS: ReadonlyArray<(text: string) => string> = [
  (text) => text,
  (text) => text.replace(QUOTES_AND_ESCAPES, ""),
  (text) => text.replace(ESCAPES, ""),
  (text) => text.replace(ESCAPES, "").replaceAll('"', ""),
  (text) => text.replace(ESCAPES, "").replaceAll("'", ""),
  (text) => text.replaceAll("\\", "/").replace(/["'`^]/gu, ""),
];

function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const WRITE_TEXT = new Set(["content"]);
const EDIT_TEXT = new Set(["oldText", "newText"]);

function writtenFields(toolName: string): ReadonlySet<string> | undefined {
  if (toolName === "write") return WRITE_TEXT;
  if (toolName === "edit") return EDIT_TEXT;
  return undefined;
}

type Identity = { dev: number; ino: number };

type HiddenFile = {
  path: string;
  key: string;
  identity: Identity | undefined;
  caseInsensitive: boolean;
  names: readonly string[];
};

type StringArgument = { text: string; written: boolean };

async function identityOf(path: string): Promise<Identity | undefined> {
  try {
    const found = await stat(path);
    return { dev: found.dev, ino: found.ino };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: Identity | undefined, right: Identity | undefined): boolean {
  return (
    left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino
  );
}

function swapCase(text: string): string {
  let result = "";
  for (const character of text) {
    const upper = character.toUpperCase();
    result += upper === character ? character.toLowerCase() : upper;
  }
  return result;
}

function comparisonKey(text: string, caseInsensitive: boolean): string {
  const folded = text.normalize("NFC").replace(UNICODE_SPACES, " ").replaceAll("\u2019", "'");
  return caseInsensitive ? folded.toLowerCase() : folded;
}

async function describeHidden(root: string, path: string): Promise<HiddenFile> {
  const absolute = resolve(root, path);
  const identity = await identityOf(absolute);
  const name = basename(absolute);
  const swapped = swapCase(name);
  const caseInsensitive =
    swapped !== name && sameIdentity(identity, await identityOf(resolve(absolute, "..", swapped)));
  const relative = path.replaceAll("\\", "/");
  const names = relative === name ? [name] : [relative, name];
  return {
    path,
    key: comparisonKey(absolute, caseInsensitive),
    identity,
    caseInsensitive,
    names: names.map((entry) => comparisonKey(entry, caseInsensitive)),
  };
}

function stringArguments(input: RuntimeValue, toolName: string): StringArgument[] {
  const written = writtenFields(toolName);
  const out: StringArgument[] = [];
  const seen = new Set<object>();
  const pending: Array<{ value: RuntimeValue; field: string }> = [{ value: input, field: "" }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, field } = next;
    if (isString(value)) {
      out.push({ text: value, written: written?.has(field) === true });
      continue;
    }
    if (!isObject(value) || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) pending.push({ value: entry, field });
      continue;
    }
    for (const [key, entry] of Object.entries(value)) {
      out.push({ text: key, written: false });
      pending.push({ value: entry, field: key });
    }
  }
  return out;
}

function pathForms(text: string): string[] {
  const forms = new Set<string>();
  for (const base of new Set([text, text.trim()])) {
    const spaced = base.replace(UNICODE_SPACES, " ");
    for (const form of [base, spaced]) {
      forms.add(form);
      if (form.startsWith("@")) forms.add(form.slice(1));
    }
  }
  const expanded: string[] = [];
  for (const form of forms) {
    if (form === "~") expanded.push(homedir());
    else if (form.startsWith("~/")) expanded.push(resolve(homedir(), form.slice(2)));
    if (form.startsWith("file://")) {
      try {
        expanded.push(fileURLToPath(form));
      } catch {}
    }
  }
  for (const form of expanded) forms.add(form);
  return [...forms].filter((form) => form.length > 0);
}

function namesInText(text: string, file: HiddenFile): boolean {
  const keyed = comparisonKey(text, file.caseInsensitive);
  const texts = new Set([keyed, comparisonKey(percentDecoded(text), file.caseInsensitive)]);
  for (const fold of FOLDS) {
    if (fold(file.names.at(-1) ?? "").length === 0) continue;
    const needles = file.names.map(fold);
    for (const source of texts) {
      const haystack = fold(source);
      for (const needle of needles) {
        if (namedAt(haystack, needle)) return true;
      }
    }
  }
  return false;
}

function namedAt(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? "";
    const after = haystack[at + needle.length] ?? "";
    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
  }
  return false;
}

export async function hiddenTargetOf(
  root: string,
  input: RuntimeValue,
  hidden: readonly string[],
  toolName = "",
): Promise<string | undefined> {
  if (hidden.length === 0) return undefined;
  const values = stringArguments(input, toolName);
  if (values.length === 0) return undefined;
  const files = await Promise.all(hidden.map((path) => describeHidden(root, path)));
  const identities = new Map<string, Promise<Identity | undefined>>();
  const identity = (path: string) => {
    let found = identities.get(path);
    if (!found) {
      found = identityOf(path);
      identities.set(path, found);
    }
    return found;
  };
  for (const value of values) {
    const candidates = pathForms(value.text).map((form) =>
      isAbsolute(form) ? resolve(form) : resolve(root, form),
    );
    for (const file of files) {
      if (!value.written && namesInText(value.text, file)) return file.path;
      for (const candidate of candidates) {
        if (comparisonKey(candidate, file.caseInsensitive) === file.key) return file.path;
        if (file.identity && sameIdentity(file.identity, await identity(candidate))) {
          return file.path;
        }
      }
    }
  }
  return undefined;
}

export function hiddenFileRefusal(path: string, toolName: string): string {
  return `Refused: ${JSON.stringify(path)} is a sensitive file the reviewer has kept hidden in this review, so this ${toolName} call was not run. Do not try to reach it another way. If you need its contents, ask the reviewer to press v on it in the review to show it.`;
}

export function chatToolGuard(root: string, hidden: HiddenPaths): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const path = await hiddenTargetOf(root, event.input, hidden(), event.toolName);
      if (path === undefined) return undefined;
      return { block: true, reason: hiddenFileRefusal(path, event.toolName) };
    });
  };
}
