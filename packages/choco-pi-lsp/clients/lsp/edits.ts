import fs from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import {
  arr,
  bool,
  int,
  nul,
  obj,
  opt,
  str,
  union,
  unknown,
  compile,
} from "@earendil-works/pi-schema";
import { isBooleanValue } from "./schema-guards.ts";
import {
  isUnderDir,
  normalizeEphemeralMapKey,
  normalizeMapKey,
  pathsEqual,
  uriToDiskPath,
  uriToPath,
} from "../path-utils.ts";
import { convertCharacterOffset, lineTextAt, type PositionEncoding } from "./position-encoding.ts";
import { recordLspMutation, type LspMutationContext } from "../lsp-mutation.ts";
import { detectLineEnding, normalizeToLF, restoreLineEndings } from "../host-edit-normalize.ts";

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPTextEdit {
  range: LSPRange;
  newText: string;
}

interface TextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LSPTextEdit[];
}

interface NormalizedWorkspaceEdit {
  changes?: Record<string, unknown[]>;
  documentChanges?: unknown[];
}

interface ResourceOptions {
  overwrite?: boolean;
  ignoreIfExists?: boolean;
  ignoreIfNotExists?: boolean;
  recursive?: boolean;
}

interface CreateFileOp {
  kind: "create";
  uri: string;
  options?: ResourceOptions;
}

interface RenameFileOp {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: ResourceOptions;
}

interface DeleteFileOp {
  kind: "delete";
  uri: string;
  options?: ResourceOptions;
}

export interface AppliedWorkspaceFileDetail {
  filePath: string;
  range?: { start: number; end: number };
  importsChanged?: boolean;
}

export interface AppliedWorkspaceEdit {
  descriptions: string[];
  files: string[];
  operationTotal: number;
  appliedOperationTotal: number;
  appliedOperationIndexes: number[];
  operationCounts: {
    textEdits: number;
    create: number;
    rename: number;
    delete: number;
  };
  fileDetails: AppliedWorkspaceFileDetail[];
}

export interface ApplyWorkspaceEditOptions {
  positionEncoding?: PositionEncoding;
  documentVersions?: ReadonlyMap<string, number>;
  mutationContext?: LspMutationContext;
  observe?: boolean;
}

const JsonObjectSchema = obj({}, { open: true });
const isJsonObject = compile(JsonObjectSchema).check;
const PositionSchema = obj(
  {
    line: int({ minimum: 0 }),
    character: int({ minimum: 0 }),
  },
  { open: true },
);
const TextDocumentEditSchema = obj(
  {
    textDocument: obj(
      {
        uri: str(),
        version: opt(union([int({ minimum: 0 }), nul()])),
      },
      { open: true },
    ),
    edits: arr(unknown()),
  },
  { open: true },
);
const isTextDocumentEdit = compile(TextDocumentEditSchema).check;
const ResourceOptionsSchema = obj(
  {
    overwrite: opt(bool()),
    ignoreIfExists: opt(bool()),
    ignoreIfNotExists: opt(bool()),
    recursive: opt(bool()),
  },
  { open: true },
);
const isResourceOptions = compile(ResourceOptionsSchema).check;
const FsErrorSchema = obj({ code: opt(str()) }, { open: true });
const isFsError = compile(FsErrorSchema).check;
const ResourceOperationSchema = obj(
  {
    kind: str(),
    uri: opt(str()),
    oldUri: opt(str()),
    newUri: opt(str()),
    options: opt(JsonObjectSchema),
  },
  { open: true },
);
const isResourceOperation = compile(ResourceOperationSchema).check;

function comparePosition(a: LSPPosition, b: LSPPosition): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

const isWireRange = compile(
  obj({ start: PositionSchema, end: PositionSchema }, { open: true }),
).check;
const isWireTextEdit = compile(obj({ range: unknown(), newText: str() }, { open: true })).check;
const isNonNegativeInteger = compile(int({ minimum: 0 })).check;

function isRange<T>(value: T): value is T & LSPRange {
  if (!isWireRange(value)) return false;
  return comparePosition(value.start, value.end) <= 0;
}

function isTextEdit<T>(value: T): value is T & LSPTextEdit {
  return isWireTextEdit(value) && isRange(value.range);
}

function parseTextEdits<T>(value: T, context: string): LSPTextEdit[] {
  if (!Array.isArray(value)) throw new Error(`${context}.edits must be an array`);
  if (!value.every(isTextEdit)) throw new Error(`malformed text edit in ${context}`);
  return value;
}

function parseVersion<T>(value: T, context: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isNonNegativeInteger(value)) {
    throw new Error(`${context}.version must be a nonnegative integer or null`);
  }
  return Number(value);
}

function parseResourceOptions<T>(value: T, kind: string): ResourceOptions | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw new Error(`${kind}.options must be an object`);
  const allowed = new Set(
    kind === "delete" ? ["ignoreIfNotExists", "recursive"] : ["overwrite", "ignoreIfExists"],
  );
  for (const [key, option] of Object.entries(value)) {
    if (!allowed.has(key) || !isBooleanValue(option)) {
      throw new Error(`invalid ${kind}.options.${key}`);
    }
  }
  if (!isResourceOptions(value)) {
    throw new Error(`${kind}.options must contain boolean values`);
  }
  if (value.overwrite === true && value.ignoreIfExists === true) {
    throw new Error(`${kind} cannot set both overwrite and ignoreIfExists`);
  }
  if (kind !== "delete" && value.ignoreIfNotExists !== undefined) {
    throw new Error(`${kind} does not support ignoreIfNotExists`);
  }
  if (kind === "delete" && value.overwrite !== undefined) {
    throw new Error(`delete does not support overwrite`);
  }
  return value;
}

function parseTextDocumentEdit<T>(value: T, context: string): TextDocumentEdit | null {
  if (!isTextDocumentEdit(value)) return null;
  const version = parseVersion(value.textDocument.version, `${context}.textDocument`);
  return {
    textDocument: { uri: value.textDocument.uri, version },
    edits: parseTextEdits(value.edits, context),
  };
}

function parseWorkspaceEdit(edit: {
  changes?: Record<string, unknown[]>;
  documentChanges?: unknown[];
}): void {
  if (edit.changes !== undefined) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      parseTextEdits(edits, `changes[${uri}]`);
    }
  }
  for (const [index, change] of (edit.documentChanges ?? []).entries()) {
    const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
    if (text) continue;
    if (!isResourceOperation(change)) {
      throw new Error(`malformed documentChanges[${index}]`);
    }
    switch (change.kind) {
      case "create":
        if (change.uri === undefined) throw new Error("create.uri must be a string");
        parseResourceOptions(change.options, "create");
        break;
      case "rename":
        if (change.oldUri === undefined || change.newUri === undefined) {
          throw new Error("rename requires oldUri and newUri strings");
        }
        parseResourceOptions(change.options, "rename");
        break;
      case "delete":
        if (change.uri === undefined) throw new Error("delete.uri must be a string");
        parseResourceOptions(change.options, "delete");
        break;
      default:
        throw new Error(`unsupported workspace resource operation: ${change.kind}`);
    }
  }
}

function formatRange(range: LSPRange): string {
  return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

export function rangesOverlap(a: LSPRange, b: LSPRange): boolean {
  return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

function positionsEqual(a: LSPPosition, b: LSPPosition): boolean {
  return a.line === b.line && a.character === b.character;
}

function isEmptyRange(range: LSPRange): boolean {
  return positionsEqual(range.start, range.end);
}

function sortEditsForApplication(edits: LSPTextEdit[]): LSPTextEdit[] {
  return edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      const startDelta = comparePosition(b.edit.range.start, a.edit.range.start);
      if (startDelta !== 0) return startDelta;
      const endDelta = comparePosition(b.edit.range.end, a.edit.range.end);
      if (endDelta !== 0) return endDelta;
      return b.index - a.index;
    })
    .map(({ edit }) => edit);
}

function validateTextEdits(edits: LSPTextEdit[]): LSPTextEdit[] {
  const unique: LSPTextEdit[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (!isEmptyRange(edit.range)) {
      const key = textEditKey("", edit);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    unique.push(edit);
  }
  const ordered = sortEditsForApplication(unique);
  for (let index = 0; index < ordered.length - 1; index++) {
    const later = ordered[index]?.range;
    const earlier = ordered[index + 1]?.range;
    if (later && earlier && comparePosition(earlier.end, later.start) > 0) {
      throw new Error(
        `overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}`,
      );
    }
  }
  return unique;
}

function utf16Position(
  content: string,
  position: LSPPosition,
  encoding: PositionEncoding,
): LSPPosition {
  const line = lineTextAt(content, position.line);
  const wireLength = convertCharacterOffset(encoding, line, line.length);
  const hasTrailingCR = line.endsWith("\r");
  const clampedLength = hasTrailingCR ? line.length - 1 : line.length;
  const clampedWireLength = hasTrailingCR ? wireLength - 1 : wireLength;
  if (position.character > clampedWireLength) {
    return { line: position.line, character: clampedLength };
  }
  if (encoding === "utf-16") return position;
  for (let offset = 0; offset <= line.length; offset++) {
    if (encoding === "utf-32" && offset > 0 && offset < line.length) {
      const previous = line.charCodeAt(offset - 1);
      const current = line.charCodeAt(offset);
      if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
        continue;
    }
    if (convertCharacterOffset(encoding, line, offset) === position.character) {
      return { line: position.line, character: offset };
    }
  }
  throw new Error(`text edit character ${position.character} is not a ${encoding} boundary`);
}

function normalizeTextEditsForContent(
  content: string,
  edits: LSPTextEdit[],
  encoding: PositionEncoding,
): LSPTextEdit[] {
  const lines = content.split("\n");
  const lastLine = Math.max(0, lines.length - 1);
  const ending = detectLineEnding(content);
  const clamp = (position: LSPPosition): LSPPosition => {
    if (position.line >= lines.length) {
      return { line: lastLine, character: (lines[lastLine] ?? "").length };
    }
    return utf16Position(content, position, encoding);
  };
  const converted = edits.map((edit) => {
    const start = clamp(edit.range.start);
    const end = clamp(edit.range.end);
    if (comparePosition(start, end) > 0) throw new Error("text edit range is out of order");
    return {
      ...edit,
      range: { start, end },
      newText: restoreLineEndings(normalizeToLF(edit.newText), ending),
    };
  });
  return validateTextEdits(converted);
}

export function applyTextEditsToString(
  content: string,
  edits: LSPTextEdit[],
  positionEncoding: PositionEncoding = "utf-16",
): string {
  const lines = content.split("\n");
  const normalized = sortEditsForApplication(
    normalizeTextEditsForContent(content, edits, positionEncoding),
  );
  for (const edit of normalized) {
    const { start, end } = edit.range;
    if (start.line === end.line) {
      const line = lines[start.line] ?? "";
      lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
      continue;
    }
    const startLine = lines[start.line] ?? "";
    const endLine = lines[end.line] ?? "";
    const replacement =
      startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
    lines.splice(start.line, end.line - start.line + 1, ...replacement.split("\n"));
  }
  return lines.join("\n");
}

export async function normalizeWorkspaceEditToUtf16(
  edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
  positionEncoding: PositionEncoding,
  cwd: string,
): Promise<{ changes?: Record<string, unknown[]>; documentChanges?: unknown[] }> {
  parseWorkspaceEdit(edit);
  if (positionEncoding === "utf-16") return edit;

  const planned = planWorkspaceEdit(edit, true);
  const prepared = await preflightWorkspaceEdit(planned, cwd, { positionEncoding });
  const normalizedByOrigin = new Map<string, LSPTextEdit[]>();
  for (const op of planned) {
    if (op.kind !== "text") continue;
    for (const origin of op.origins ?? []) {
      normalizedByOrigin.set(
        textEditOriginKey(origin),
        prepared.textByOrigin.get(textEditOriginKey(origin)) ?? [],
      );
    }
  }

  const changes: Record<string, unknown[]> = {};
  for (const uri of Object.keys(edit.changes ?? {})) {
    changes[uri] =
      normalizedByOrigin.get(textEditOriginKey({ kind: "changes", uri, edits: [] })) ?? [];
  }
  const documentChanges: unknown[] = [];
  for (const [index, change] of (edit.documentChanges ?? []).entries()) {
    const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
    if (!text) {
      documentChanges.push(change);
      continue;
    }
    // SAFETY: TextDocumentEditSchema verified that this JSON-RPC change is an object.
    const original = change as object;
    documentChanges.push({
      ...original,
      edits:
        normalizedByOrigin.get(textEditOriginKey({ kind: "documentChanges", index, edits: [] })) ??
        [],
    });
  }
  const normalized: NormalizedWorkspaceEdit = {};
  if (edit.changes !== undefined) normalized.changes = changes;
  if (edit.documentChanges !== undefined) normalized.documentChanges = documentChanges;
  return normalized;
}

export function flattenWorkspaceTextEdits(edit: {
  changes?: Record<string, unknown[]>;
  documentChanges?: unknown[];
}): Map<string, LSPTextEdit[]> {
  parseWorkspaceEdit(edit);
  const buckets = new Map<string, { uri: string; edits: LSPTextEdit[] }>();
  const push = (uri: string, edits: unknown[]) => {
    const textEdits = parseTextEdits(edits, uri);
    if (textEdits.length === 0) return;
    const key = pathIndexKey(uri);
    const existing = buckets.get(key);
    if (existing) existing.edits.push(...textEdits);
    else buckets.set(key, { uri, edits: [...textEdits] });
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) push(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    const text = parseTextDocumentEdit(change, "documentChanges");
    if (text) push(text.textDocument.uri, text.edits);
  }
  return new Map([...buckets.values()].map(({ uri, edits }) => [uri, edits]));
}

function textEditKey(uri: string, edit: LSPTextEdit): string {
  return [
    pathIndexKey(uri),
    edit.range.start.line,
    edit.range.start.character,
    edit.range.end.line,
    edit.range.end.character,
    edit.newText,
  ].join(":");
}

export interface MergeWorkspaceEditsResult {
  edit: { changes: Record<string, LSPTextEdit[]> };
  droppedConflicts: number;
  inputEditCount: number;
  serverIds: string[];
}

export function mergeWorkspaceTextEditsByPriority(
  entries: Array<{
    serverId: string;
    edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] } | null | undefined;
  }>,
): MergeWorkspaceEditsResult {
  const merged = new Map<string, { uri: string; edits: LSPTextEdit[] }>();
  const seenExact = new Set<string>();
  let droppedConflicts = 0;
  let inputEditCount = 0;
  const serverIds: string[] = [];
  for (const entry of entries) {
    serverIds.push(entry.serverId);
    if (!entry.edit) continue;
    for (const [uri, edits] of flattenWorkspaceTextEdits(entry.edit)) {
      const key = pathIndexKey(uri);
      const bucket = merged.get(key) ?? { uri, edits: [] };
      const kept = bucket.edits;
      for (const edit of edits) {
        inputEditCount += 1;
        const exactKey = isEmptyRange(edit.range) ? undefined : textEditKey(uri, edit);
        if (exactKey !== undefined && seenExact.has(exactKey)) continue;
        if (kept.some((existing) => rangesOverlap(existing.range, edit.range))) {
          droppedConflicts += 1;
          continue;
        }
        if (exactKey !== undefined) seenExact.add(exactKey);
        kept.push(edit);
      }
      if (kept.length > 0) merged.set(key, bucket);
    }
  }
  const changes: Record<string, LSPTextEdit[]> = {};
  for (const { uri, edits } of merged.values()) changes[uri] = edits;
  return { edit: { changes }, droppedConflicts, inputEditCount, serverIds };
}

type TextEditOrigin =
  | { kind: "changes"; uri: string; edits: LSPTextEdit[] }
  | { kind: "documentChanges"; index: number; edits: LSPTextEdit[] };

type WorkspaceEditOp =
  | {
      kind: "text";
      uri: string;
      edits: LSPTextEdit[];
      version?: number | null;
      origins?: TextEditOrigin[];
    }
  | CreateFileOp
  | RenameFileOp
  | DeleteFileOp;

function pathIndexKey(uri: string): string {
  return normalizeEphemeralMapKey(uriToPath(uri));
}

function textEditOriginKey(origin: TextEditOrigin): string {
  return origin.kind === "changes" ? `changes:${origin.uri}` : `documentChanges:${origin.index}`;
}

function parseResource<T>(change: T): WorkspaceEditOp {
  if (!isResourceOperation(change)) {
    throw new Error("malformed workspace resource operation");
  }
  const kind = change.kind;
  if (kind === "create" && change.uri !== undefined) {
    return { kind, uri: change.uri, options: parseResourceOptions(change.options, kind) };
  }
  if (kind === "rename" && change.oldUri !== undefined && change.newUri !== undefined) {
    return {
      kind,
      oldUri: change.oldUri,
      newUri: change.newUri,
      options: parseResourceOptions(change.options, kind),
    };
  }
  if (kind === "delete" && change.uri !== undefined) {
    return { kind, uri: change.uri, options: parseResourceOptions(change.options, kind) };
  }
  throw new Error(`unsupported workspace resource operation: ${String(kind)}`);
}

function planWorkspaceEdit(
  edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
  trackOrigins = false,
): WorkspaceEditOp[] {
  parseWorkspaceEdit(edit);
  const ops: WorkspaceEditOp[] = [];
  const pending = new Map<
    string,
    {
      uri: string;
      edits: LSPTextEdit[];
      version?: number | null;
      origins?: TextEditOrigin[];
    }
  >();
  const descendants = new Map<string, Set<string>>();
  const indexedAncestors = new Map<string, string[]>();
  const seenResources = new Set<string>();
  const pathKeys = new Map<string, string>();
  const indexKey = (uri: string): string => {
    const cached = pathKeys.get(uri);
    if (cached !== undefined) return cached;
    const key = pathIndexKey(uri);
    pathKeys.set(uri, key);
    return key;
  };
  const addIndex = (key: string): void => {
    const ancestors: string[] = [];
    let current = key;
    while (true) {
      const set = descendants.get(current) ?? new Set<string>();
      set.add(key);
      descendants.set(current, set);
      ancestors.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    indexedAncestors.set(key, ancestors);
  };
  const removeIndex = (key: string): void => {
    for (const ancestor of indexedAncestors.get(key) ?? []) descendants.get(ancestor)?.delete(key);
    indexedAncestors.delete(key);
  };
  const queue = (
    uri: string,
    edits: LSPTextEdit[],
    version: number | null | undefined,
    origin?: TextEditOrigin,
  ): void => {
    const key = indexKey(uri);
    const existing = pending.get(key);
    if (existing) {
      const existingNumeric = existing.version === null ? undefined : existing.version;
      const incomingNumeric = version === null ? undefined : version;
      if (
        existingNumeric !== undefined &&
        incomingNumeric !== undefined &&
        existingNumeric !== incomingNumeric
      ) {
        throw new Error(`conflicting text document versions for ${uri}`);
      }
      existing.edits.push(...edits);
      if (origin) (existing.origins ??= []).push(origin);
      if (existingNumeric === undefined && incomingNumeric !== undefined)
        existing.version = version;
      return;
    }
    if (origin) {
      pending.set(key, { uri, edits: [...edits], version, origins: [origin] });
    } else {
      pending.set(key, { uri, edits: [...edits], version });
    }
    addIndex(key);
  };
  const flushUri = (uri: string): void => {
    const key = indexKey(uri);
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    removeIndex(key);
    if (item.origins) {
      ops.push({
        kind: "text",
        uri: item.uri,
        edits: item.edits,
        version: item.version,
        origins: item.origins,
      });
    } else {
      ops.push({ kind: "text", uri: item.uri, edits: item.edits, version: item.version });
    }
  };
  const flushSubtree = (uri: string): void => {
    const key = indexKey(uri);
    for (const candidate of descendants.get(key) ?? []) {
      const item = pending.get(candidate);
      if (item) flushUri(item.uri);
    }
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const parsed = parseTextEdits(edits, `changes[${uri}]`);
    queue(
      uri,
      parsed,
      undefined,
      trackOrigins ? { kind: "changes", uri, edits: parsed } : undefined,
    );
  }
  for (const [index, change] of (edit.documentChanges ?? []).entries()) {
    const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
    if (text) {
      queue(
        text.textDocument.uri,
        text.edits,
        text.textDocument.version,
        trackOrigins
          ? {
              kind: "documentChanges",
              index,
              edits: text.edits,
            }
          : undefined,
      );
      continue;
    }
    const resource = parseResource(change);
    const resourceKey =
      resource.kind === "rename"
        ? `rename:${indexKey(resource.oldUri)}:${indexKey(resource.newUri)}`
        : `${resource.kind}:${indexKey(resource.uri)}`;
    if (seenResources.has(resourceKey))
      throw new Error(`duplicate workspace resource operation: ${resourceKey}`);
    seenResources.add(resourceKey);
    if (resource.kind === "create") flushUri(resource.uri);
    else if (resource.kind === "rename") {
      flushSubtree(resource.oldUri);
      flushSubtree(resource.newUri);
    } else flushSubtree(resource.uri);
    ops.push(resource);
  }
  for (const item of pending.values()) flushUri(item.uri);
  return ops;
}

export function __planWorkspaceEditForTest(edit: {
  changes?: Record<string, unknown[]>;
  documentChanges?: unknown[];
}): number {
  return planWorkspaceEdit(edit).length;
}

function relativeToCwd(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath) || path.basename(filePath);
  return rel.replace(/\\/g, "/");
}

const IMPORT_RELEVANT_LINE = /^\s*import\b|^\s*export\s[^;]*\bfrom\s|\bfrom\s+['"]/;

function importsSignature(text: string): string {
  return text
    .split("\n")
    .filter((line) => IMPORT_RELEVANT_LINE.test(line))
    .join("\n");
}

export function summarizeWorkspaceEdit(
  edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
  cwd: string,
): string[] {
  const lines: string[] = [];
  for (const [uri, edits] of flattenWorkspaceTextEdits(edit))
    lines.push(`Apply ${edits.length} edit(s) to ${relativeToCwd(uriToPath(uri), cwd)}`);
  for (const change of edit.documentChanges ?? []) {
    if (!isResourceOperation(change)) continue;
    if (change.kind === "create" && change.uri !== undefined) {
      lines.push(`Create ${relativeToCwd(uriToPath(change.uri), cwd)}`);
    } else if (
      change.kind === "rename" &&
      change.oldUri !== undefined &&
      change.newUri !== undefined
    ) {
      lines.push(
        `Rename ${relativeToCwd(uriToPath(change.oldUri), cwd)} → ${relativeToCwd(uriToPath(change.newUri), cwd)}`,
      );
    } else if (change.kind === "delete" && change.uri !== undefined) {
      lines.push(`Delete ${relativeToCwd(uriToPath(change.uri), cwd)}`);
    }
  }
  return lines;
}

type VirtualFile = { exists: boolean; directory: boolean; content?: string };

async function lstatOrMissing(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (err) {
    if (isFsError(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

export function isSameFsIdentity(
  a: { dev: bigint; ino: bigint },
  b: { dev: bigint; ino: bigint },
): boolean {
  return a.dev === b.dev && a.ino !== 0n && b.ino !== 0n && a.ino === b.ino;
}

async function bigintLstatOrMissing(filePath: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(filePath, { bigint: true });
  } catch (err) {
    if (isFsError(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

async function isSameFsEntry(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([bigintLstatOrMissing(a), bigintLstatOrMissing(b)]);
  return Boolean(statA && statB && isSameFsIdentity(statA, statB));
}

async function assertParentIsUsable(
  filePath: string,
  stateFor: (filePath: string) => Promise<VirtualFile>,
): Promise<void> {
  let current = path.dirname(filePath);
  while (true) {
    const known = await stateFor(current);
    if (known.exists) {
      if (!known.directory) throw new Error(`resource parent is not a directory: ${current}`);
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`resource parent does not exist: ${filePath}`);
    current = parent;
  }
}

async function resolveExistingAncestor(filePath: string): Promise<string> {
  let current = path.resolve(filePath);
  const tail: string[] = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return path.join(resolved, ...tail.reverse());
    } catch (err) {
      const code = isFsError(err) ? err.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

async function createWorkspaceUriConfiner(cwd: string): Promise<(uri: string) => Promise<string>> {
  const root = await resolveExistingAncestor(cwd);
  return async (uri: string): Promise<string> => {
    let filePath = "";
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:" || (parsed.host !== "" && parsed.hostname !== "localhost"))
        throw new Error("URI must be a local file URI");
      filePath = uriToPath(uri);
    } catch (err) {
      throw new Error(
        `invalid workspace edit URI ${uri}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!path.isAbsolute(filePath))
      throw new Error(`workspace edit path escapes workspace: ${uri}`);
    const resolved = await resolveExistingAncestor(filePath);
    if (!isUnderDir(resolved, root))
      throw new Error(`workspace edit path escapes workspace: ${uri}`);
    return filePath;
  };
}

export async function validateWorkspaceEdit(
  edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
  cwd: string,
): Promise<void> {
  const planned = planWorkspaceEdit(edit);
  await preflightWorkspaceEdit(planned, cwd, {});
}

async function preflightWorkspaceEdit(
  planned: WorkspaceEditOp[],
  cwd: string,
  options: ApplyWorkspaceEditOptions,
): Promise<{
  text: Map<WorkspaceEditOp, LSPTextEdit[]>;
  textByOrigin: Map<string, LSPTextEdit[]>;
  ignored: Set<WorkspaceEditOp>;
}> {
  const confine = await createWorkspaceUriConfiner(cwd);
  const virtual = new Map<string, VirtualFile>();
  const virtualOverrides = new Map<string, VirtualFile>();
  const virtualMoves: Array<{
    from: string;
    to: string;
    directory: boolean;
  }> = [];
  const virtualTombstones: Array<{ path: string; directory: boolean }> = [];
  const text = new Map<WorkspaceEditOp, LSPTextEdit[]>();
  const textByOrigin = new Map<string, LSPTextEdit[]>();
  const ignored = new Set<WorkspaceEditOp>();
  const resolveVirtualPath = (filePath: string): string | undefined => {
    let resolved = filePath;
    for (let index = virtualMoves.length - 1; index >= 0; index--) {
      const move = virtualMoves[index];
      if (isUnderDir(resolved, move.to) && (move.directory || pathsEqual(resolved, move.to))) {
        const suffix = path.relative(move.to, resolved);
        resolved = suffix ? path.join(move.from, suffix) : move.from;
        continue;
      }
      if (isUnderDir(resolved, move.from) && (move.directory || pathsEqual(resolved, move.from))) {
        return undefined;
      }
    }
    return resolved;
  };
  const isTombstoned = (filePath: string): boolean =>
    virtualTombstones.some(
      (tombstone) =>
        pathsEqual(filePath, tombstone.path) ||
        (tombstone.directory && isUnderDir(filePath, tombstone.path)),
    );
  const clearTombstonesUnder = (filePath: string): void => {
    for (let index = virtualTombstones.length - 1; index >= 0; index--) {
      const tombstone = virtualTombstones[index];
      if (pathsEqual(tombstone.path, filePath) || isUnderDir(tombstone.path, filePath)) {
        virtualTombstones.splice(index, 1);
      }
    }
  };
  const stateFor = async (filePath: string): Promise<VirtualFile> => {
    if (isTombstoned(filePath)) return { exists: false, directory: false };
    const physicalPath = resolveVirtualPath(filePath);
    if (!physicalPath) {
      return virtualOverrides.get(normalizeMapKey(filePath)) ?? { exists: false, directory: false };
    }
    const key = normalizeMapKey(physicalPath);
    const known = virtual.get(key);
    if (known) return known;
    const stat = await lstatOrMissing(physicalPath);
    const value = { exists: Boolean(stat), directory: stat?.isDirectory() ?? false };
    virtual.set(key, value);
    return value;
  };
  const contentFor = async (filePath: string, state: VirtualFile): Promise<string> => {
    if (!state.exists || state.directory)
      throw new Error(`text edit target is not a file: ${filePath}`);
    if (state.content !== undefined) return state.content;
    const physicalPath = resolveVirtualPath(filePath);
    if (!physicalPath) throw new Error(`text edit target does not exist: ${filePath}`);
    const content = await fs.readFile(physicalPath, "utf-8");
    state.content = content;
    return content;
  };
  for (const op of planned) {
    if (op.kind === "text") {
      const filePath = await confine(op.uri);
      const state = await stateFor(filePath);
      if (op.version !== undefined && op.version !== null) {
        const current = options.documentVersions?.get(normalizeMapKey(filePath));
        if (current === undefined || current !== op.version)
          throw new Error(
            `stale text document version for ${filePath}: expected ${op.version}, current ${current ?? "unknown"}`,
          );
      }
      const content = await contentFor(filePath, state);
      const encoding = options.positionEncoding ?? "utf-16";
      const normalized = normalizeTextEditsForContent(content, op.edits, encoding);
      text.set(op, normalized);

      for (const origin of op.origins ?? []) {
        textByOrigin.set(
          textEditOriginKey(origin),
          normalizeTextEditsForContent(content, origin.edits, encoding),
        );
      }
      state.content = applyTextEditsToString(content, normalized);
      continue;
    }
    if (op.kind === "create") {
      const filePath = await confine(op.uri);
      const state = await stateFor(filePath);
      await assertParentIsUsable(filePath, stateFor);
      if (state.exists) {
        if (op.options?.ignoreIfExists) {
          ignored.add(op);
          continue;
        }
        if (!op.options?.overwrite || state.directory)
          throw new Error(`create target already exists: ${filePath}`);
        state.content = "";
      } else {
        clearTombstonesUnder(filePath);
        state.exists = true;
        state.directory = false;
        state.content = "";
        const physicalPath = resolveVirtualPath(filePath);
        if (physicalPath) virtual.set(normalizeMapKey(physicalPath), state);
        else virtualOverrides.set(normalizeMapKey(filePath), state);
      }
      continue;
    }
    if (op.kind === "rename") {
      const oldPath = await confine(op.oldUri);
      const newPath = await confine(op.newUri);
      const oldDisk = uriToDiskPath(op.oldUri);
      const newDisk = uriToDiskPath(op.newUri);
      if (path.resolve(oldDisk).replace(/\\/g, "/") === path.resolve(newDisk).replace(/\\/g, "/")) {
        throw new Error("rename source and destination must differ");
      }
      const source = await stateFor(oldPath);
      if (!source.exists) throw new Error(`rename source does not exist: ${oldPath}`);
      const sourceFromOverride = resolveVirtualPath(oldPath) === undefined;
      await assertParentIsUsable(newPath, stateFor);
      const destination = await stateFor(newPath);
      if (destination.exists) {
        const aliasesSource = destination === source || (await isSameFsEntry(oldDisk, newDisk));
        if (!aliasesSource) {
          if (op.options?.ignoreIfExists) {
            ignored.add(op);
            continue;
          }
          if (!op.options?.overwrite)
            throw new Error(`rename destination already exists: ${newPath}`);
        }
      }
      clearTombstonesUnder(newPath);
      if (!source.directory) await contentFor(oldPath, source);
      if (sourceFromOverride) {
        virtualOverrides.delete(normalizeMapKey(oldPath));
        const destinationPhysicalPath = resolveVirtualPath(newPath);
        if (destinationPhysicalPath) virtual.set(normalizeMapKey(destinationPhysicalPath), source);
        else virtualOverrides.set(normalizeMapKey(newPath), source);
      } else {
        virtualMoves.push({ from: oldPath, to: newPath, directory: source.directory });
      }
      continue;
    }
    const filePath = await confine(op.uri);
    const state = await stateFor(filePath);
    if (!state.exists) {
      if (op.options?.ignoreIfNotExists) ignored.add(op);
      else throw new Error(`delete target does not exist: ${filePath}`);
    } else {
      if (state.directory && !op.options?.recursive)
        throw new Error(`delete directory requires recursive: ${filePath}`);
      state.exists = false;
      state.content = undefined;
      virtualTombstones.push({ path: filePath, directory: state.directory });
    }
  }
  return { text, textByOrigin, ignored };
}

export async function applyWorkspaceEdit(
  edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
  cwd: string,
  options: ApplyWorkspaceEditOptions = {},
): Promise<AppliedWorkspaceEdit> {
  const descriptions: string[] = [];
  const touchedFiles = new Set<string>();
  const fileDetails: AppliedWorkspaceFileDetail[] = [];
  const appliedOperationIndexes: number[] = [];
  let appliedOperationTotal = 0;
  let operationIndex = 0;
  const operationCounts = { textEdits: 0, create: 0, rename: 0, delete: 0 };
  const planned = planWorkspaceEdit(edit);
  let operationTotal = 0;
  let prepared: Awaited<ReturnType<typeof preflightWorkspaceEdit>>;
  const operationSize = (op: WorkspaceEditOp): number =>
    op.kind === "text" ? (prepared.text.get(op)?.length ?? 0) : 1;
  const markApplied = (op: WorkspaceEditOp): void => {
    const count = operationSize(op);
    for (let index = 0; index < count; index++) {
      if (appliedOperationIndexes.length < 100) {
        appliedOperationIndexes.push(operationIndex + index);
      }
    }
    appliedOperationTotal += count;
    operationIndex += count;
  };
  const skipOperation = (op: WorkspaceEditOp): void => {
    operationIndex += operationSize(op);
  };
  const makeResult = (): AppliedWorkspaceEdit => ({
    descriptions,
    files: [...touchedFiles],
    operationTotal,
    appliedOperationTotal,
    appliedOperationIndexes,
    operationCounts,
    fileDetails,
  });
  try {
    prepared = await preflightWorkspaceEdit(planned, cwd, options);
    for (const op of planned) {
      const size = operationSize(op);
      if (op.kind === "text") operationCounts.textEdits += size;
      else operationCounts[op.kind]++;
      operationTotal += size;
    }
    for (const op of planned) {
      if (prepared.ignored.has(op)) {
        skipOperation(op);
        continue;
      }
      if (op.kind === "text") {
        const filePath = uriToPath(op.uri);
        const diskPath = uriToDiskPath(op.uri);
        const edits = prepared.text.get(op) ?? [];
        if (edits.length === 0) {
          skipOperation(op);
          continue;
        }
        const content = await fs.readFile(diskPath, "utf-8");
        const updated = applyTextEditsToString(content, edits, "utf-16");
        await fs.writeFile(diskPath, updated, "utf-8");
        const start = Math.min(...edits.map((item) => item.range.start.line + 1));
        const end = Math.max(...edits.map((item) => item.range.end.line + 1));
        touchedFiles.add(filePath);
        fileDetails.push({
          filePath,
          range: { start, end },
          importsChanged: importsSignature(content) !== importsSignature(updated),
        });
        markApplied(op);
        descriptions.push(`Applied ${edits.length} edit(s) to ${relativeToCwd(filePath, cwd)}`);
      } else if (op.kind === "create") {
        const filePath = uriToPath(op.uri);
        const diskPath = uriToDiskPath(op.uri);
        await fs.mkdir(path.dirname(diskPath), { recursive: true });
        if (op.options?.overwrite) await fs.writeFile(diskPath, "", "utf-8");
        else await fs.writeFile(diskPath, "", { flag: "wx" });
        touchedFiles.add(filePath);
        fileDetails.push({ filePath, range: { start: 1, end: 1 }, importsChanged: false });
        markApplied(op);
        descriptions.push(`Created ${relativeToCwd(filePath, cwd)}`);
      } else if (op.kind === "rename") {
        const oldPath = uriToPath(op.oldUri);
        const newPath = uriToPath(op.newUri);
        const oldDisk = uriToDiskPath(op.oldUri);
        const newDisk = uriToDiskPath(op.newUri);
        await fs.mkdir(path.dirname(newDisk), { recursive: true });
        if (op.options?.overwrite) await fs.rm(newDisk, { recursive: true, force: true });
        await fs.rename(oldDisk, newDisk);
        touchedFiles.add(oldPath);
        touchedFiles.add(newPath);
        fileDetails.push(
          { filePath: oldPath, range: { start: 1, end: 1 }, importsChanged: true },
          { filePath: newPath, range: { start: 1, end: 1 }, importsChanged: true },
        );
        markApplied(op);
        descriptions.push(
          `Renamed ${relativeToCwd(oldPath, cwd)} → ${relativeToCwd(newPath, cwd)}`,
        );
      } else {
        const filePath = uriToPath(op.uri);
        const diskPath = uriToDiskPath(op.uri);
        await fs.rm(diskPath, { recursive: op.options?.recursive === true, force: false });
        touchedFiles.add(filePath);
        fileDetails.push({ filePath, range: { start: 1, end: 1 }, importsChanged: true });
        markApplied(op);
        descriptions.push(`Deleted ${relativeToCwd(filePath, cwd)}`);
      }
    }
  } catch (err) {
    const partial = makeResult();
    if (options.mutationContext && options.observe !== false) {
      recordLspMutation(options.mutationContext, { results: [partial], status: "failed" });
    }
    const already = [...touchedFiles];
    if (already.length > 0) {
      const alreadyList = already.map((f) => `  • ${relativeToCwd(f, cwd)}`).join("\n");
      const failure: Error & { appliedWorkspaceEdit: AppliedWorkspaceEdit } = Object.assign(
        new Error(
          `Workspace edit failed mid-application — ${already.length} file(s) already written, no rollback performed:\n${alreadyList}\nCause: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { appliedWorkspaceEdit: partial },
      );
      throw failure;
    }
    throw err;
  }
  const applied = makeResult();
  if (options.mutationContext && options.observe !== false) {
    recordLspMutation(options.mutationContext, {
      results: [applied],
      status: appliedOperationTotal > 0 ? "success" : "skipped",
    });
  }
  return applied;
}
