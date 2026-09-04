import { isAbsolute, resolve } from "node:path";

import {
  type BoundaryRecord,
  type BoundaryValue,
  isBoundaryArray,
  isBoundaryRecord,
  isNumber,
  isString,
} from "../boundary.ts";
import { type PiToolArguments, type PiToolResult, recordField } from "../pi-rpc/protocol.ts";

const MAX_STREAMED_TEXT = 32 * 1024;
const MAX_TERMINAL_CALLS = 8_192;
const MAX_PATCH_INPUT = 256 * 1024;
const MAX_PATCH_FILES = 256;
const MAX_PATCH_PATH = 4_096;
const MAX_PATCH_DIFF_TEXT = 32 * 1024;
const TRUNCATION_INDICATOR = "\n…[truncated]";

export interface EditorToolPresentation {
  title?: string;
  summary?: string;
  locations?: Array<{ path: string; line?: number; column?: number }>;
  diff?: { path: string; oldText: string; newText: string };
  diffs?: Array<{ path: string; oldText: string; newText: string; line?: number }>;
  terminal?: { command?: string; cwd?: string; exitCode?: number };
}

type EditorLocation = NonNullable<EditorToolPresentation["locations"]>[number];

export interface ToolPresentationResult {
  toolCallId: string;
  toolName: string;
  kind: "read" | "write" | "edit" | "terminal" | "generic";
  status: "running" | "completed" | "failed";
  text?: string;
  presentation: EditorToolPresentation;
}

type StartInput = {
  toolCallId: string;
  toolName: string;
  args?: PiToolArguments;
  cwd?: string;
};

type UpdateInput = { toolCallId: string; result?: PiToolResult };
type EndInput = UpdateInput & { isError?: boolean };

type Tracked = {
  result: ToolPresentationResult;
  terminal: boolean;
  cwd: string;
};

function nonEmptyString(value: BoundaryValue): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}

function absolutePath(value: BoundaryValue, cwd: string): string | undefined {
  const path = nonEmptyString(value);
  if (path === undefined) return undefined;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function positiveSafeInteger(value: BoundaryValue): number | undefined {
  return isNumber(value) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function streamedText(value: BoundaryValue): string | undefined {
  let text: string | undefined;
  if (isString(value)) {
    text = value;
  } else {
    const object = isBoundaryRecord(value) ? value : undefined;
    text =
      nonEmptyString(object?.text) ??
      nonEmptyString(object?.output) ??
      nonEmptyString(object?.stdout);
  }
  if (text === undefined) return undefined;
  if (text.length <= MAX_STREAMED_TEXT) return text;
  return `${text.slice(0, MAX_STREAMED_TEXT - TRUNCATION_INDICATOR.length)}${TRUNCATION_INDICATOR}`;
}

type EditValues = { oldText?: string; newText?: string };

function editValues(args: BoundaryRecord): EditValues {
  let source = args;
  if (isBoundaryArray(args.edits)) {
    const firstEdit = args.edits[0];
    source = isBoundaryRecord(firstEdit) ? firstEdit : args;
  }
  return {
    oldText: isString(source.oldText) ? source.oldText : undefined,
    newText: isString(source.newText) ? source.newText : undefined,
  };
}

type ParsedPatchFile = {
  path: string;
  oldText?: string;
  newText?: string;
  line?: number;
};

type ReconstructedUpdate = {
  oldText?: string;
  newText?: string;
  line?: number;
};

function joinedPatchLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function reconstructUpdate(lines: string[]): ReconstructedUpdate | undefined {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let sawContent = false;
  let firstChangedLine: number | undefined;
  let hunkStart = 1;
  let leadingContext = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      hunkStart = match ? Number(match[1]) : oldLines.length + 1;
      leadingContext = 0;
      continue;
    }
    if (line === "*** End of File") continue;
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") return undefined;
    sawContent = true;
    const content = line.slice(1);
    if (firstChangedLine === undefined) {
      if (prefix === " ") leadingContext += 1;
      else firstChangedLine = hunkStart + leadingContext;
    }
    if (prefix !== "+") oldLines.push(content);
    if (prefix !== "-") newLines.push(content);
  }
  if (!sawContent) return undefined;
  const oldText = joinedPatchLines(oldLines);
  const newText = joinedPatchLines(newLines);
  if (oldText.length > MAX_PATCH_DIFF_TEXT || newText.length > MAX_PATCH_DIFF_TEXT)
    return firstChangedLine ? { line: firstChangedLine } : {};
  // Absolute hunk anchors win; a bare @@ treats the reconstructed region as
  // starting at line 1, then advances past leading unchanged context.
  const reconstructed: ReconstructedUpdate = { oldText, newText };
  if (firstChangedLine) reconstructed.line = firstChangedLine;
  return reconstructed;
}

function parseApplyPatch(value: BoundaryValue, cwd: string): ParsedPatchFile[] | undefined {
  if (!isString(value) || value.length === 0 || value.length > MAX_PATCH_INPUT) return undefined;
  const lines = value.trim().split(/\r?\n/);
  if (
    lines.length < 3 ||
    !lines[0]?.startsWith("*** Begin Patch") ||
    lines.at(-1) !== "*** End Patch"
  )
    return undefined;

  const files: ParsedPatchFile[] = [];
  const seenPaths = new Set<string>();
  let index = 1;
  while (index < lines.length - 1) {
    const header = /^(?:\*\*\* )(Update|Add|Delete) File: (.+)$/.exec(lines[index] ?? "");
    if (!header) return undefined;
    const operation = header[1];
    const rawPath = header[2];
    if (rawPath === undefined || rawPath.length > MAX_PATCH_PATH) return undefined;
    const path = absolutePath(rawPath, cwd);
    if (path === undefined) return undefined;
    index += 1;

    let movePath: string | undefined;
    const possibleMoveHeader = lines[index];
    if (operation === "Update" && possibleMoveHeader?.startsWith("*** Move to: ")) {
      const rawMovePath = possibleMoveHeader.slice("*** Move to: ".length);
      if (rawMovePath.length === 0 || rawMovePath.length > MAX_PATCH_PATH) return undefined;
      movePath = absolutePath(rawMovePath, cwd);
      if (movePath === undefined) return undefined;
      index += 1;
    }

    const bodyStart = index;
    while (
      index < lines.length - 1 &&
      !/^\*\*\* (?:Update|Add|Delete) File: /.test(lines[index] ?? "")
    )
      index += 1;
    const body = lines.slice(bodyStart, index);
    let reconstructed: ReconstructedUpdate | undefined;
    if (operation === "Update") {
      reconstructed = reconstructUpdate(body);
      if (reconstructed === undefined) return undefined;
    } else if (operation === "Add") {
      if (!body.every((line) => line.startsWith("+"))) return undefined;
      const newText = joinedPatchLines(body.map((line) => line.slice(1)));
      if (newText.length <= MAX_PATCH_DIFF_TEXT) reconstructed = { oldText: "", newText, line: 1 };
      else reconstructed = { line: 1 };
    } else if (operation === "Delete" && body.length !== 0) {
      return undefined;
    }

    for (const touchedPath of movePath === undefined ? [path] : [path, movePath]) {
      if (seenPaths.has(touchedPath)) continue;
      if (files.length >= MAX_PATCH_FILES) return undefined;
      seenPaths.add(touchedPath);
      const file: ParsedPatchFile = { path: touchedPath };
      if (
        touchedPath === path &&
        reconstructed?.oldText !== undefined &&
        reconstructed.newText !== undefined
      ) {
        file.oldText = reconstructed.oldText;
        file.newText = reconstructed.newText;
      }
      if (touchedPath === path && reconstructed?.line !== undefined) file.line = reconstructed.line;
      files.push(file);
    }
  }
  return files.length === 0 ? undefined : files;
}

const PATCH_ARGUMENT_KEYS = ["code", "input", "source", "script", "cmd", "command"] as const;

function* extractPatchRegions(value: string): Generator<string> {
  const begin = "*** Begin Patch";
  const end = "*** End Patch";
  let cursor = 0;
  let count = 0;
  while (count < MAX_PATCH_FILES) {
    const start = value.indexOf(begin, cursor);
    if (start < 0) break;
    const endStart = value.indexOf(end, start + begin.length);
    if (endStart < 0) break;
    const regionEnd = endStart + end.length;
    if (regionEnd - start <= MAX_PATCH_INPUT) yield value.slice(start, regionEnd);
    count += 1;
    cursor = regionEnd;
  }
}

function parseExtractedPatch(region: string, cwd: string): ParsedPatchFile[] | undefined {
  const direct = parseApplyPatch(region, cwd);
  if (direct || region.includes("\n") || !region.includes("\\n")) return direct;
  try {
    const decoded: BoundaryValue = JSON.parse(`"${region}"`);
    if (isString(decoded) && decoded.length <= MAX_PATCH_INPUT)
      return parseApplyPatch(decoded, cwd);
  } catch {
    // A non-JSON JavaScript string can still use escaped line endings.
  }
  const decodedLines = region.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
  return decodedLines.length <= MAX_PATCH_INPUT ? parseApplyPatch(decodedLines, cwd) : undefined;
}

function parsedPatchesFromArgs(args: BoundaryRecord, cwd: string): ParsedPatchFile[] | undefined {
  const files: ParsedPatchFile[] = [];
  for (const key of PATCH_ARGUMENT_KEYS) {
    const value = args[key];
    if (!isString(value)) continue;
    for (const region of extractPatchRegions(value)) {
      const parsed = parseExtractedPatch(region, cwd);
      if (!parsed || files.length + parsed.length > MAX_PATCH_FILES) continue;
      files.push(...parsed);
    }
  }
  return files.length > 0 ? files : undefined;
}

function applyParsedPatchPresentation(
  presentation: EditorToolPresentation,
  files: ParsedPatchFile[],
): void {
  const locations = new Map<string, EditorLocation>();
  const diffs: NonNullable<EditorToolPresentation["diffs"]> = [];
  for (const file of files.slice(0, MAX_PATCH_FILES)) {
    if (!locations.has(file.path)) {
      const location: EditorLocation = { path: file.path };
      if (file.line) location.line = file.line;
      locations.set(file.path, location);
    }
    if (file.oldText !== undefined && file.newText !== undefined) {
      const diff: NonNullable<EditorToolPresentation["diffs"]>[number] = {
        path: file.path,
        oldText: file.oldText,
        newText: file.newText,
      };
      if (file.line) diff.line = file.line;
      diffs.push(diff);
    }
  }
  presentation.locations = [...locations.values()];
  if (diffs.length > 0) presentation.diffs = diffs;
  const [diff] = diffs;
  if (files.length === 1 && diffs.length === 1 && diff !== undefined) {
    presentation.diff = { path: diff.path, oldText: diff.oldText, newText: diff.newText };
  } else if (files.length > 1) {
    presentation.summary = `Patch touches ${files.length} files`;
  }
}

function resultPatchPaths(value: PiToolResult, cwd: string): string[] {
  const text = streamedText(value);
  const object = isBoundaryRecord(value) ? value : undefined;
  const contentItems: string[] = [];
  if (isBoundaryArray(object?.content)) {
    for (const item of object.content.slice(0, 32)) {
      if (!isBoundaryRecord(item)) continue;
      const itemText = nonEmptyString(item.text);
      if (itemText !== undefined) contentItems.push(itemText);
    }
  }
  const content = contentItems.join("\n");
  if (!`${text ?? ""}\n${content}`.includes("Applied patch successfully")) return [];

  const details = isBoundaryRecord(object?.details) ? object.details : undefined;
  const detailsResult = isBoundaryRecord(details?.result) ? details.result : undefined;
  const paths: string[] = [];
  for (const key of ["changedFiles", "createdFiles", "deletedFiles", "movedFiles"] as const) {
    const values = detailsResult?.[key];
    if (!isBoundaryArray(values)) continue;
    for (const rawPath of values.slice(0, MAX_PATCH_FILES - paths.length)) {
      const path = absolutePath(rawPath, cwd);
      if (path && path.length <= MAX_PATCH_PATH && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

function customPresentation(value: BoundaryValue): EditorToolPresentation | undefined {
  const candidate = isBoundaryRecord(value) ? value : undefined;
  if (!candidate) return undefined;
  const result: EditorToolPresentation = {};
  for (const key of ["title", "summary"] as const) {
    const field = candidate[key];
    if (field !== undefined && !isString(field)) return undefined;
    if (isString(field)) result[key] = field;
  }
  if (candidate.locations !== undefined) {
    if (!isBoundaryArray(candidate.locations)) return undefined;
    result.locations = [];
    for (const item of candidate.locations) {
      if (!isBoundaryRecord(item) || !isString(item.path)) return undefined;
      const line = item.line === undefined ? undefined : positiveSafeInteger(item.line);
      const column = item.column === undefined ? undefined : positiveSafeInteger(item.column);
      if (item.line !== undefined && line === undefined) return undefined;
      if (item.column !== undefined && column === undefined) return undefined;
      const location: NonNullable<EditorToolPresentation["locations"]>[number] = {
        path: item.path,
      };
      if (line !== undefined) location.line = line;
      if (column !== undefined) location.column = column;
      result.locations.push(location);
    }
  }
  if (candidate.diff !== undefined) {
    const value = isBoundaryRecord(candidate.diff) ? candidate.diff : undefined;
    if (!value || !isString(value.path) || !isString(value.oldText) || !isString(value.newText))
      return undefined;
    result.diff = { path: value.path, oldText: value.oldText, newText: value.newText };
  }
  if (candidate.diffs !== undefined) {
    if (!isBoundaryArray(candidate.diffs) || candidate.diffs.length > MAX_PATCH_FILES)
      return undefined;
    result.diffs = [];
    for (const item of candidate.diffs) {
      const value = isBoundaryRecord(item) ? item : undefined;
      if (
        !value ||
        !isString(value.path) ||
        !isString(value.oldText) ||
        !isString(value.newText) ||
        value.oldText.length > MAX_PATCH_DIFF_TEXT ||
        value.newText.length > MAX_PATCH_DIFF_TEXT ||
        (value.line !== undefined && positiveSafeInteger(value.line) === undefined)
      )
        return undefined;
      const line = value.line === undefined ? undefined : positiveSafeInteger(value.line);
      const diff: NonNullable<EditorToolPresentation["diffs"]>[number] = {
        path: value.path,
        oldText: value.oldText,
        newText: value.newText,
      };
      if (line !== undefined) diff.line = line;
      result.diffs.push(diff);
    }
  }
  if (candidate.terminal !== undefined) {
    const value = isBoundaryRecord(candidate.terminal) ? candidate.terminal : undefined;
    if (
      !value ||
      (value.command !== undefined && !isString(value.command)) ||
      (value.cwd !== undefined && !isString(value.cwd)) ||
      (value.exitCode !== undefined &&
        (!isNumber(value.exitCode) || !Number.isSafeInteger(value.exitCode)))
    )
      return undefined;
    result.terminal = {};
    if (isString(value.command)) result.terminal.command = value.command;
    if (isString(value.cwd)) result.terminal.cwd = value.cwd;
    if (isNumber(value.exitCode)) result.terminal.exitCode = value.exitCode;
  }
  return result;
}

function copy(result: ToolPresentationResult): ToolPresentationResult {
  return { ...result, presentation: structuredClone(result.presentation) };
}

export class ToolPresentationTracker {
  readonly #calls = new Map<string, Tracked>();
  readonly #terminalCalls: string[] = [];

  isTerminal(toolCallId: string): boolean {
    return this.#calls.get(toolCallId)?.terminal === true;
  }

  #mergeCustomPresentation(tracked: Tracked, value: PiToolResult): void {
    if (tracked.result.kind !== "generic") return;
    const details = recordField(value, "details");
    const custom = customPresentation(details?.editorToolPresentation);
    if (custom) tracked.result.presentation = { ...tracked.result.presentation, ...custom };
  }

  #retainTerminal(toolCallId: string): void {
    this.#terminalCalls.push(toolCallId);
    if (this.#terminalCalls.length <= MAX_TERMINAL_CALLS) return;
    const evicted = this.#terminalCalls.shift();
    if (evicted !== undefined && this.#calls.get(evicted)?.terminal) this.#calls.delete(evicted);
  }

  start({ toolCallId, toolName, args, cwd }: StartInput): ToolPresentationResult {
    const existing = this.#calls.get(toolCallId);
    if (existing) return copy(existing.result);

    const values = isBoundaryRecord(args) ? args : {};
    const baseCwd = resolve(cwd ?? process.cwd());
    const normalizedName = toolName.toLowerCase();
    const path = absolutePath(values.path ?? values.file_path, baseCwd);
    const line = positiveSafeInteger(values.line);
    const column = positiveSafeInteger(values.column);
    let result: ToolPresentationResult = {
      presentation: { title: toolName },
      kind: "generic",
      status: "running",
      toolCallId,
      toolName,
    };

    if (["read", "write", "edit"].includes(normalizedName)) {
      if (normalizedName === "read") result.kind = "read";
      else if (normalizedName === "write") result.kind = "write";
      else result.kind = "edit";
      if (path) {
        const location: NonNullable<EditorToolPresentation["locations"]>[number] = { path };
        if (line) location.line = line;
        if (column) location.column = column;
        result.presentation.locations = [location];
      }
      if (normalizedName === "edit") {
        const edit = editValues(values);
        if (path && edit.oldText !== undefined && edit.newText !== undefined)
          result.presentation.diff = { path, oldText: edit.oldText, newText: edit.newText };
      }
    } else if (["shell", "bash", "exec"].includes(normalizedName)) {
      const parsedPatch = parsedPatchesFromArgs(values, baseCwd);
      if (parsedPatch) {
        result.kind = "edit";
        result.presentation.title = `${toolName} (apply_patch)`;
        applyParsedPatchPresentation(result.presentation, parsedPatch);
      } else {
        result.kind = "terminal";
        result.presentation.terminal = {
          command: nonEmptyString(values.command ?? values.cmd),
          cwd: absolutePath(values.cwd, baseCwd) ?? baseCwd,
        };
      }
    } else if (["apply_patch", "apply-patch"].includes(normalizedName)) {
      result.kind = "edit";
      const parsedPatch = parsedPatchesFromArgs(values, baseCwd);
      if (parsedPatch) {
        applyParsedPatchPresentation(result.presentation, parsedPatch);
      } else if (path) {
        result.presentation.locations = [{ path }];
        if (isString(values.oldText) && isString(values.newText)) {
          result.presentation.diff = { path, oldText: values.oldText, newText: values.newText };
          const diff: NonNullable<EditorToolPresentation["diffs"]>[number] = {
            path,
            oldText: values.oldText,
            newText: values.newText,
          };
          if (line) diff.line = line;
          result.presentation.diffs = [diff];
        }
      }
    } else {
      const details = isBoundaryRecord(values.details) ? values.details : undefined;
      const custom = customPresentation(details?.editorToolPresentation);
      if (custom) result.presentation = custom;
    }

    this.#calls.set(toolCallId, { result, terminal: false, cwd: baseCwd });
    return copy(result);
  }

  update({ toolCallId, result }: UpdateInput): ToolPresentationResult | undefined {
    const tracked = this.#calls.get(toolCallId);
    if (!tracked || tracked.terminal) return undefined;
    const text = streamedText(result);
    if (text !== undefined) tracked.result.text = text;
    this.#mergeCustomPresentation(tracked, result);
    const resultPaths = resultPatchPaths(result, tracked.cwd);
    if (resultPaths.length > 0) {
      const locations = tracked.result.presentation.locations ?? [];
      const seen = new Set(locations.map((location) => location.path));
      for (const path of resultPaths) {
        if (locations.length >= MAX_PATCH_FILES) break;
        if (!seen.has(path)) {
          seen.add(path);
          locations.push({ path });
        }
      }
      tracked.result.presentation.locations = locations;
    }
    return copy(tracked.result);
  }

  end({ toolCallId, result, isError }: EndInput): ToolPresentationResult | undefined {
    const tracked = this.#calls.get(toolCallId);
    if (!tracked || tracked.terminal) return undefined;
    const text = streamedText(result);
    if (text !== undefined) tracked.result.text = text;
    this.#mergeCustomPresentation(tracked, result);
    const resultPaths = resultPatchPaths(result, tracked.cwd);
    if (resultPaths.length > 0) {
      const locations = tracked.result.presentation.locations ?? [];
      const seen = new Set(locations.map((location) => location.path));
      for (const path of resultPaths) {
        if (locations.length >= MAX_PATCH_FILES) break;
        if (!seen.has(path)) {
          seen.add(path);
          locations.push({ path });
        }
      }
      tracked.result.presentation.locations = locations;
    }
    const resultRecord = isBoundaryRecord(result) ? result : undefined;
    const exitCode = resultRecord?.exitCode ?? resultRecord?.exit_code;
    if (
      isNumber(exitCode) &&
      Number.isSafeInteger(exitCode) &&
      tracked.result.presentation.terminal
    )
      tracked.result.presentation.terminal.exitCode = exitCode;
    tracked.result.status = isError ? "failed" : "completed";
    tracked.terminal = true;
    this.#retainTerminal(toolCallId);
    return copy(tracked.result);
  }
}
