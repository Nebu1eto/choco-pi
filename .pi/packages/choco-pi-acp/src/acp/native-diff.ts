import { isAbsolute } from "node:path";
import type { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import {
  type BoundaryValue,
  isBoundaryArray,
  isBoundaryRecord,
  isFiniteNumber,
  isString,
  parseJsonLine,
} from "../boundary.ts";

/**
 * Environment marker set on every Pi child. It tells choco-pi's `/diff`
 * extension that this RPC client renders a versioned diff notification as
 * native ACP diff content instead of text.
 */
export const NATIVE_DIFF_ENV = "CHOCO_PI_ACP_NATIVE_DIFF";
/** A notify message starting with this line carries a native diff payload. */
export const NATIVE_DIFF_NOTIFY_PREFIX = "choco-pi-native-diff/v1\n";
export const NATIVE_DIFF_MAX_FILES = 30;
export const NATIVE_DIFF_MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SKIPPED = 200;
const MAX_LABEL_LENGTH = 1_000;

/** Change kinds the extension reports; anything else makes the payload malformed. */
const FILE_STATUSES = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "type-changed",
] as const;
export type NativeDiffFileStatus = (typeof FILE_STATUSES)[number];

export type NativeDiffFile = {
  path: string;
  /**
   * On the wire, the extension's repository-relative name for `path`, used
   * only to shorten it (see `shortName`). After decoding, the adapter's own
   * bounded name for `path`; it is never tested as a path.
   */
  displayPath: string;
  /** The previous absolute path of a rename or copy; validated like `path`. */
  oldPath?: string;
  /** After decoding: the adapter's bounded name for `oldPath`. */
  oldDisplayPath?: string;
  oldText: string | null;
  newText: string;
  /** Optional: an older extension sends none of these. */
  status?: NativeDiffFileStatus;
  additions?: number | null;
  deletions?: number | null;
};

export type NativeDiffSkip = { path: string; reason: string };

export type NativeDiffPresentation = {
  title: string;
  files: NativeDiffFile[];
  skipped: NativeDiffSkip[];
  omitted: number;
};

const SENSITIVE_NAMES: readonly RegExp[] = [
  /^\.env$/u,
  /^\.env\..+$/u,
  /\.pem$/u,
  /\.key$/u,
  /\.p12$/u,
  /\.pfx$/u,
  /^id_rsa/u,
  /^id_ed25519/u,
  /\.keystore$/u,
  /^auth\.json$/u,
  /^\.npmrc$/u,
  /^\.netrc$/u,
];

/**
 * Second line of defence behind the extension's own filter: a sensitive name
 * never reaches the client with contents, whatever the payload claims.
 */
export function isSensitiveDiffPath(path: string): boolean {
  const lower = path.toLowerCase().replaceAll("\\", "/");
  if (lower.includes("secret") || lower.includes("credential")) return true;
  const name = lower.split("/").at(-1) ?? lower;
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

function label(value: string): string {
  return value.length > MAX_LABEL_LENGTH ? `${value.slice(0, MAX_LABEL_LENGTH - 1)}…` : value;
}

function isFileStatus(value: string): value is NativeDiffFileStatus {
  return FILE_STATUSES.some((status) => status === value);
}

/** A decoded optional line count: absent, null (not counted), a count, or malformed. */
type LineCountField =
  | { kind: "absent" }
  | { kind: "present"; count: number | null }
  | { kind: "malformed" };

function lineCount(value: BoundaryValue): LineCountField {
  if (value === undefined) return { kind: "absent" };
  if (value === null) return { kind: "present", count: null };
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0
    ? { kind: "present", count: value }
    : { kind: "malformed" };
}

function decodeFile(value: BoundaryValue): NativeDiffFile | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const { path, displayPath, oldPath, oldText, newText, status, additions, deletions } = value;
  if (!isString(path) || !isAbsolute(path) || !isString(displayPath) || !isString(newText)) {
    return undefined;
  }
  if (oldText !== null && !isString(oldText)) return undefined;
  const file: NativeDiffFile = { path, displayPath, oldText, newText };
  if (status !== undefined) {
    if (!isString(status) || !isFileStatus(status)) return undefined;
    file.status = status;
  }
  if (oldPath !== undefined) {
    // Only a rename or copy has a previous path, and it must be absolute like `path`.
    const moved = file.status === "renamed" || file.status === "copied";
    if (!moved || !isString(oldPath) || !isAbsolute(oldPath)) return undefined;
    file.oldPath = oldPath;
  }
  const added = lineCount(additions);
  const deleted = lineCount(deletions);
  if (added.kind === "malformed" || deleted.kind === "malformed") return undefined;
  if (added.kind === "present") file.additions = added.count;
  if (deleted.kind === "present") file.deletions = deleted.count;
  return file;
}

/** A path's shown name, and the directory prefix the name was cut from (empty when not cut). */
type ShortName = { name: string; root: string };

/** The adapter's own names for one file: `label` is used where both sides share one line. */
type FileNames = { name: string; oldName?: string; label: string };

/**
 * A short name for an absolute path: the extension's relative name when it is
 * literally the end of that path, else the path itself. The hint can only
 * shorten the name of the path it belongs to; it is never trusted as a path.
 */
function shortName(absolute: string, hint: string): ShortName {
  const tail = hint.startsWith("/") ? "" : hint;
  if (tail !== "" && absolute.endsWith(`/${tail}`)) {
    return { name: tail, root: absolute.slice(0, absolute.length - tail.length) };
  }
  return { name: absolute, root: "" };
}

/** The adapter's own names for a file, built from its validated paths. */
function namesOf(file: NativeDiffFile): FileNames {
  const { name, root } = shortName(file.path, file.displayPath);
  if (file.oldPath === undefined || file.oldPath === file.path) {
    return { name: label(name), label: label(name) };
  }
  const oldName =
    root !== "" && file.oldPath.startsWith(root) ? file.oldPath.slice(root.length) : file.oldPath;
  return { name: label(name), oldName: label(oldName), label: label(`${oldName} -> ${name}`) };
}

/**
 * Why a file's contents may not be forwarded, judged only from validated
 * paths and the change kind: either side sensitive, or a side unknown (a
 * rename or copy without its previous path, or no change kind at all with old
 * text that could be another file's). Undefined when they may be forwarded.
 */
function withheldReason(file: NativeDiffFile): string | undefined {
  const sensitive =
    isSensitiveDiffPath(file.path) ||
    (file.oldPath !== undefined && isSensitiveDiffPath(file.oldPath));
  if (sensitive) return "sensitive file; contents not sent";
  const moved = file.status === "renamed" || file.status === "copied";
  if (moved && file.oldPath === undefined) return "previous path unknown; contents not sent";
  if (file.status === undefined && file.oldText !== null) {
    return "change kind unknown; contents not sent";
  }
  return undefined;
}

function decodeSkip(value: BoundaryValue): NativeDiffSkip | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const { path, reason } = value;
  return isString(path) && isString(reason)
    ? { path: label(path), reason: label(reason) }
    : undefined;
}

/**
 * Decode a native diff notification and enforce the caps again: at most 30
 * files and 1 MiB of old plus new text, no sensitive contents. Returns
 * undefined for a malformed payload.
 */
export function decodeNativeDiff(message: string): NativeDiffPresentation | undefined {
  if (!message.startsWith(NATIVE_DIFF_NOTIFY_PREFIX)) return undefined;
  const value = parseJsonLine(message.slice(NATIVE_DIFF_NOTIFY_PREFIX.length));
  if (!isBoundaryRecord(value)) return undefined;
  const { title, files, skipped, omitted } = value;
  if (!isString(title) || !isBoundaryArray(files) || !isBoundaryArray(skipped)) return undefined;
  if (!isFiniteNumber(omitted) || omitted < 0) return undefined;

  const decodedSkips: NativeDiffSkip[] = [];
  let extraOmitted = 0;
  const skip = (entry: NativeDiffSkip): void => {
    if (decodedSkips.length < MAX_SKIPPED) decodedSkips.push(entry);
    else extraOmitted += 1;
  };
  for (const entry of skipped) {
    const decoded = decodeSkip(entry);
    if (!decoded) return undefined;
    skip(decoded);
  }

  const kept: NativeDiffFile[] = [];
  let used = 0;
  for (const entry of files) {
    const file = decodeFile(entry);
    if (!file) return undefined;
    const names = namesOf(file);
    const shown = names.label;
    const withheld = withheldReason(file);
    if (withheld !== undefined) {
      skip({ path: shown, reason: withheld });
      continue;
    }
    if (kept.length >= NATIVE_DIFF_MAX_FILES) {
      skip({ path: shown, reason: `over the ${NATIVE_DIFF_MAX_FILES}-file limit` });
      continue;
    }
    const bytes =
      Buffer.byteLength(file.oldText ?? "", "utf8") + Buffer.byteLength(file.newText, "utf8");
    if (used + bytes > NATIVE_DIFF_MAX_TEXT_BYTES) {
      skip({ path: shown, reason: `too large for the remaining text budget (${bytes} bytes)` });
      continue;
    }
    used += bytes;
    const decoded: NativeDiffFile = { ...file, displayPath: names.name };
    if (names.oldName !== undefined) decoded.oldDisplayPath = names.oldName;
    kept.push(decoded);
  }
  return {
    title: label(title),
    files: kept,
    skipped: decodedSkips,
    omitted: Math.floor(omitted) + extraOmitted,
  };
}

function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * One line of visible text, the adapter's counterpart of choco-pi's
 * `sanitizeTerminalText`: C0 controls (newline and tab included) become their
 * Control Picture, DEL becomes `␡`, C1 and bidirectional controls become
 * `\uFFFD`. A file name can then neither break a line, carry an escape
 * sequence, nor reorder the text around it.
 */
export function visibleText(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20) result += String.fromCodePoint(0x2400 + code);
    else if (code === 0x7f) result += "\u2421";
    else if ((code >= 0x80 && code <= 0x9f) || isBidiControl(code)) result += "\uFFFD";
    else result += character;
  }
  return result;
}

/**
 * Markdown inline text that renders as `text` itself: every ASCII punctuation
 * character is backslash-escaped, so nothing in it forms a heading, list,
 * link, autolink, emphasis, code span, or HTML, and leading spaces cannot
 * start an indented code block. `text` must already be one visible line.
 */
export function markdownText(text: string): string {
  const escaped = text.replace(/[!-/:-@[-`{-~]/gu, (character) => `\\${character}`);
  return escaped.replace(/^ +/u, (spaces) => "&#32;".repeat(spaces.length));
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const each of text) {
    current = each === character ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * An untrusted file name as a Markdown code span: sanitised once with
 * {@link visibleText}, delimited by one more backtick than its longest
 * backtick run, and padded so a leading or trailing backtick stays inside.
 */
export function markdownName(name: string): string {
  const visible = visibleText(name);
  const delimiter = "`".repeat(longestRun(visible, "`") + 1);
  return `${delimiter} ${visible} ${delimiter}`;
}

/**
 * "modified, +3 -1" from the optional facts; empty when the extension sent
 * none. Built only from a validated status and integers, so it needs no escaping.
 */
function fileFacts(file: NativeDiffFile): string {
  const facts: string[] = [];
  if (file.status !== undefined) facts.push(file.status);
  const { additions, deletions } = file;
  if (
    additions !== undefined &&
    additions !== null &&
    deletions !== undefined &&
    deletions !== null
  ) {
    facts.push(`+${additions} -${deletions}`);
  }
  return facts.join(", ");
}

function fileLine(file: NativeDiffFile): string {
  const facts = fileFacts(file);
  const name =
    file.oldDisplayPath === undefined
      ? markdownName(file.displayPath)
      : `${markdownName(file.oldDisplayPath)} → ${markdownName(file.displayPath)}`;
  return facts === "" ? name : `${name} — ${facts}`;
}

/**
 * Markdown shown above the diffs: the files in the order of the diff blocks
 * below, what was not shown and why, and the display-only notice. Zed draws a
 * diff block without its file name, so this list is where the names are.
 * `sanitize` is the adapter's text sanitiser, applied to the title as it is
 * to the tool call's title; names and reasons are sanitised by
 * {@link visibleText} and nothing is sanitised twice.
 */
export function nativeDiffSummary(
  presentation: NativeDiffPresentation,
  sanitize: (text: string) => string,
): string {
  const blocks = [markdownText(visibleText(sanitize(presentation.title)))];
  const empty =
    presentation.files.length === 0 &&
    presentation.skipped.length === 0 &&
    presentation.omitted === 0;
  if (empty) blocks.push("No changed files.");
  const count = presentation.files.length;
  if (count > 0) {
    const lines = [
      count === 1 ? "The file shown below:" : `The ${count} files shown below, in order:`,
    ];
    presentation.files.forEach((file, index) => lines.push(`${index + 1}. ${fileLine(file)}`));
    blocks.push(lines.join("\n"));
  }
  if (presentation.skipped.length > 0) {
    const lines = ["Not shown (listed by name only):"];
    for (const entry of presentation.skipped) {
      lines.push(`- ${markdownName(entry.path)}: ${markdownText(visibleText(entry.reason))}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (presentation.omitted > 0) {
    blocks.push(`${presentation.omitted} more changed files not listed.`);
  }
  blocks.push(
    "Display only: this view is not part of the conversation and was not sent to the model.",
  );
  return blocks.join("\n\n");
}

/** Content and locations of the display-only `/diff` tool call. */
export type NativeDiffToolCallBody = {
  content: ToolCallContent[];
  locations: ToolCallLocation[];
};

/**
 * The ACP tool call content: the summary, then for each shown file a name line
 * followed by its diff, whose text is unchanged.
 */
export function nativeDiffContent(
  presentation: NativeDiffPresentation,
  sanitize: (text: string) => string,
): NativeDiffToolCallBody {
  const content: ToolCallContent[] = [
    {
      type: "content",
      content: { type: "text", text: nativeDiffSummary(presentation, sanitize) },
    },
  ];
  const count = presentation.files.length;
  presentation.files.forEach((file, index) => {
    const text = `File ${index + 1} of ${count}: ${fileLine(file)}`;
    content.push({ type: "content", content: { type: "text", text } });
    content.push({ type: "diff", path: file.path, oldText: file.oldText, newText: file.newText });
  });
  return { content, locations: presentation.files.map((file) => ({ path: file.path })) };
}
