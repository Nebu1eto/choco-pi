/**
 * Tool-boundary guard for the review's side chat: defence in depth for the
 * sensitive files the review keeps hidden.
 *
 * The chat is told which files are hidden and asked not to read them
 * (`buildReviewChatPrompt`), and it keeps Pi's full default toolset on
 * purpose (see `createDefaultReviewSession` in ask.ts). This guard backs the
 * instruction up: before any tool call of the chat session runs, Pi's
 * `tool_call` event lets it refuse calls that target a file the reviewer has
 * kept hidden. The hidden set is read live from the open view, so a file the
 * reviewer reveals with `v` is allowed from then on, and it is hidden again
 * when the review reopens (the chat session ends with the view).
 *
 * Every string in a tool call's arguments is inspected, at any depth and any
 * length, object keys included, for every tool: Pi's file tools, shell and
 * code tools (`command`, `cmd`, `chars`, `code`, `script`), prompts and
 * messages to other agents, and tools of unknown purpose alike.
 *
 * What it refuses: a call with any string that
 * - resolves to a hidden file the way Pi's file tools resolve a path, or any
 *   way close to it (erring towards refusing): as given, without its leading
 *   or trailing white space, with Unicode spaces as plain spaces, without a
 *   leading `@`, with `~` as the home directory, as a `file://` URL; against
 *   the review root, with `..` and trailing slashes resolved; compared with
 *   Unicode normalisation (NFC/NFD), curly and straight apostrophes alike, and
 *   letter case ignored where the file system ignores it; and by device and
 *   inode, so a symbolic or hard link to the file counts too;
 * - or names the hidden path or its base name anywhere in its text, not
 *   joined to other name characters (letters and digits of any script,
 *   combining marks, `_`, `.`, `-`) on
 *   either side, with the same normalisation and case rule; also after
 *   removing the quote and escape characters `"`, `'`, `\`, `` ` `` and `^` from
 *   the text and from the name alike, after decoding `%XX` escapes, and with
 *   `\` read as a directory separator. That covers a name written quoted or
 *   escaped in a POSIX shell, fish, PowerShell or cmd (`cat .e"n"v`,
 *   `cat .\env`, `cat o\'key.txt`, `cat $'o\'key.txt'`, `type .e^nv`,
 *   `file:///repo/%2eenv`). Without a shell parser it over-refuses: a
 *   different file whose name differs from a hidden one only by those
 *   characters (`okey.txt` while `o'key.txt` is hidden) is refused too.
 *   The line between the two lists: a form is refused when every character
 *   of the name appears in the text as itself (only quote and escape
 *   characters between them) or percent-encoded; a form that writes a
 *   character by its code or builds it at run time is not stopped.
 * The text written by `write` (`content`) and `edit` (`oldText`, `newText`)
 * is only checked as a path: writing text that mentions the name cannot read
 * the file.
 *
 * What it does NOT stop (said plainly, because this is not a sandbox):
 * - a command or script that reaches the file without naming it: a glob
 *   (`cat .e*`, `cat *`), brace expansion (`cat .{e,}nv`), a variable or a
 *   name assembled at run time, an escape that writes a character by its
 *   code (`$'\x2e'`, `$'\n'`, `\056`, `printf`), a recursive
 *   search over its directory (`grep -r TOKEN .`), environment dumps, or a
 *   script or program, written earlier, that opens it;
 * - content the chat already holds: anything read before the file was hidden
 *   or before this review opened, or pasted into the conversation.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isObject, isString, type RuntimeValue } from "../../lib/runtime-values.ts";

/** Repository-relative paths (forward slashes) the review currently keeps hidden. */
export type HiddenPaths = () => readonly string[];

/** A character that continues a file name; a match next to one names a different file. */
const NAME_CHARACTER = /[\p{L}\p{N}\p{M}_.-]/u;

/**
 * Quoting and escaping a shell can use to write a name's own characters:
 * POSIX shells and fish (`'…'`, `"…"`, `\`, and `$'…'` around plain
 * characters), PowerShell (`` ` ``, and `''` inside `'…'`), cmd (`^`, `"…"`).
 * Removing them from the text yields the name with the same characters
 * removed, wherever the name is written that way.
 */
const ESCAPES = /[\\`^]/gu;
const QUOTES_AND_ESCAPES = /["'\\`^]/gu;

/**
 * The folds compared, each applied to text and name alike: none; every quote
 * and escape removed (the general case: `o\'key`, `"o'key"`, `.e"n"v`); and
 * escapes only, or with one kind of quote, so that a name made of quote
 * characters (which the general fold empties) is still compared; and `\` as
 * a directory separator with the other quotes and escapes removed.
 */
const FOLDS: ReadonlyArray<(text: string) => string> = [
  (text) => text,
  (text) => text.replace(QUOTES_AND_ESCAPES, ""),
  (text) => text.replace(ESCAPES, ""),
  (text) => text.replace(ESCAPES, "").replaceAll('"', ""),
  (text) => text.replace(ESCAPES, "").replaceAll("'", ""),
  // cmd and PowerShell paths: `\` separates directories there and is not an escape.
  (text) => text.replaceAll("\\", "/").replace(/["'`^]/gu, ""),
];

/** `text` with each run of `%XX` escapes decoded as UTF-8 where it decodes (`file://` URLs). */
function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
/** Pi's file tools turn these into plain spaces before resolving a path. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const WRITE_TEXT = new Set(["content"]);
const EDIT_TEXT = new Set(["oldText", "newText"]);

/** Fields of the built-in file tools whose text is written, not opened: checked as a path only. */
function writtenFields(toolName: string): ReadonlySet<string> | undefined {
  if (toolName === "write") return WRITE_TEXT;
  if (toolName === "edit") return EDIT_TEXT;
  return undefined;
}

type Identity = { dev: number; ino: number };

type HiddenFile = {
  /** As the review lists it, for the refusal text. */
  path: string;
  /** Comparison key of its absolute path. */
  key: string;
  identity: Identity | undefined;
  caseInsensitive: boolean;
  /** Comparison keys of the names text may use: the path, then its base name (always last). */
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

/**
 * Folds the differences Pi's read tool tries when a path does not exist as
 * given (NFD form, curly apostrophe, narrow no-break space before AM/PM) and
 * the ones the file system may ignore (normalisation, case).
 */
function comparisonKey(text: string, caseInsensitive: boolean): string {
  const folded = text.normalize("NFC").replace(UNICODE_SPACES, " ").replaceAll("\u2019", "'");
  return caseInsensitive ? folded.toLowerCase() : folded;
}

async function describeHidden(root: string, path: string): Promise<HiddenFile> {
  const absolute = resolve(root, path);
  const identity = await identityOf(absolute);
  const name = basename(absolute);
  const swapped = swapCase(name);
  // The file system ignores case when the same file answers to another case of its name.
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

/**
 * Every string in the arguments, object keys included, at any depth. Iterative,
 * so deep nesting cannot overflow the stack or end the walk early.
 */
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

/** The forms a file tool might open for `text` (a superset of Pi's resolution). */
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
      } catch {
        // Not a file URL a tool could open either.
      }
    }
  }
  for (const form of expanded) forms.add(form);
  return [...forms].filter((form) => form.length > 0);
}

function namesInText(text: string, file: HiddenFile): boolean {
  const keyed = comparisonKey(text, file.caseInsensitive);
  const texts = new Set([keyed, comparisonKey(percentDecoded(text), file.caseInsensitive)]);
  // Each fold is applied to the text and to the name alike, so a quote or backslash that
  // belongs to the name is removed from both sides and the two still compare.
  for (const fold of FOLDS) {
    // A fold that empties the base name (a name made of quotes) would leave only its
    // directory to match; that fold is skipped for this file and another one applies.
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

/** `needle` occurs in `haystack` with no name character joined to it on either side. */
function namedAt(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? "";
    const after = haystack[at + needle.length] ?? "";
    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
  }
  return false;
}

/** The hidden file a tool call targets, or undefined when it targets none. */
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
        // Another name of the same file: a symbolic link, a hard link, another case or form.
        if (file.identity && sameIdentity(file.identity, await identity(candidate))) {
          return file.path;
        }
      }
    }
  }
  return undefined;
}

/** What the model reads when a call is refused. Names the file; never contains any of its content. */
export function hiddenFileRefusal(path: string, toolName: string): string {
  return `Refused: ${JSON.stringify(path)} is a sensitive file the reviewer has kept hidden in this review, so this ${toolName} call was not run. Do not try to reach it another way. If you need its contents, ask the reviewer to press v on it in the review to show it.`;
}

/**
 * The extension the chat session loads: refuses each tool call that targets a
 * file in `hidden()`, read at the time of the call. See the module comment
 * for what this does not stop.
 */
export function chatToolGuard(root: string, hidden: HiddenPaths): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const path = await hiddenTargetOf(root, event.input, hidden(), event.toolName);
      if (path === undefined) return undefined;
      return { block: true, reason: hiddenFileRefusal(path, event.toolName) };
    });
  };
}
