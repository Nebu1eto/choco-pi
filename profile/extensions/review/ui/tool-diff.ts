import { isObject, isString, recordOf, type RuntimeValue } from "../../lib/runtime-values.ts";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  AgentSession,
  type EditToolDetails,
  keyHint,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { computeHunkId, parseGitDiff } from "../../lib/changes/patch.ts";
import { renderDiffFile } from "../../lib/changes/render/diff-render.ts";
import { createHighlight, DEFAULT_HIGHLIGHT } from "../../lib/changes/render/highlight.ts";
import type { DiffFile, DiffHunk, DiffLine, ResolvedReviewConfig } from "../core/types.ts";
import { normalizePatchPath } from "@choco-pi/code-mode/patch-paths";

export type ToolDiffToolName = "write" | "edit" | "apply_patch";

export const TOOL_DIFF_TOOLS: readonly ToolDiffToolName[] = ["write", "edit", "apply_patch"];

export const TOOL_DIFF_LABELS = {
  write: "File: Writing",
  edit: "File: Editing",
  apply_patch: "File: Patching",
} satisfies Readonly<Record<ToolDiffToolName, string>>;

export const TOOL_DIFF_FINISHED_LABELS = {
  write: "File: Wrote",
  edit: "File: Edited",
  apply_patch: "File: Patched",
} satisfies Readonly<Record<ToolDiffToolName, string>>;

export function toolDiffLabel(name: ToolDiffToolName, context: RenderContextLike): string {
  return context.isPartial === false ? TOOL_DIFF_FINISHED_LABELS[name] : TOOL_DIFF_LABELS[name];
}

export type ToolDiffRenderingOptions = {
  config?: () => ResolvedReviewConfig | undefined;
  mode?: "unified" | "split";
};

type RenderContextLike = {
  args?: unknown;
  toolCallId?: string;
  lastComponent?: Component | undefined;
  cwd?: string;
  argsComplete?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
};

type AnyRenderCall = (args: RuntimeValue, theme: Theme, context: RenderContextLike) => Component;
type AnyRenderResult = (
  result: { content: unknown[]; details?: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContextLike,
) => Component;

type PatchedSessionPrototype = typeof AgentSession.prototype & {
  __chocoPiToolDiffApplied?: boolean;
};

const COLLAPSED_BODY_LINES = 10;

const MAX_RENDER_READ_BYTES = 2_000_000;

const APPLY_PATCH_CACHE_LIMIT = 128;

const DEFAULT_CONFIG_HIGHLIGHT: ResolvedReviewConfig["highlight"] = { ...DEFAULT_HIGHLIGHT };

const OWNED = Symbol.for("choco-pi.review.toolDiff");

function own<T extends object>(component: T): T {
  Object.defineProperty(component, OWNED, { value: true, enumerable: false, configurable: true });
  return component;
}

function isOwned(component: RuntimeValue): boolean {
  return isObject(component) && component !== null && OWNED in component;
}

class DiffLinesComponent implements Component {
  private build: (width: number) => string[];
  private fallbackText: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(build: (width: number) => string[], fallbackText = "") {
    this.build = build;
    this.fallbackText = fallbackText;
    own(this);
  }

  setBuild(build: (width: number) => string[], fallbackText = ""): void {
    this.build = build;
    this.fallbackText = fallbackText;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    try {
      this.cachedLines = this.build(width);
    } catch {
      this.cachedLines = this.fallbackText ? [this.fallbackText] : [];
    }
    return this.cachedLines;
  }
}

function diffLinesComponent(
  lastComponent: Component | undefined,
  build: (width: number) => string[],
  fallbackText: string,
): DiffLinesComponent {
  if (lastComponent instanceof DiffLinesComponent) {
    lastComponent.setBuild(build, fallbackText);
    return lastComponent;
  }
  return new DiffLinesComponent(build, fallbackText);
}

function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) return path;
  const relativePath = relative(cwd, path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

function readSourceLines(path: string, cwd: string | undefined): string[] | undefined {
  try {
    const absolute = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
    if (statSync(absolute).size > MAX_RENDER_READ_BYTES) return undefined;
    return splitContentLines(readFileSync(absolute, "utf8"));
  } catch {
    return undefined;
  }
}

function splitContentLines(content: string): string[] {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (withoutTrailingNewline.length === 0) return [];
  return withoutTrailingNewline
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function buildWriteDiffFile(path: string, content: string): DiffFile {
  const lines = splitContentLines(content);
  const diffLines: DiffLine[] = lines.map((text, index) => ({
    kind: "add",
    newLine: index + 1,
    text,
  }));
  const header = `@@ -0,0 +1,${lines.length} @@`;
  const hunks: DiffHunk[] =
    lines.length === 0
      ? []
      : [
          {
            id: computeHunkId(path, header, diffLines),
            header,
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            lines: diffLines,
          },
        ];
  return { path, kind: "added", hunks, additions: lines.length, deletions: 0 };
}

export function parseEditPatch(patch: string, path: string): DiffFile[] {
  const lines = patch.split("\n");
  const bodyStart = lines.findIndex((line) => line.startsWith("@@ "));
  if (bodyStart < 0) return [];
  if (path.includes("\n")) return [];
  const body = lines.slice(bodyStart).join("\n");
  const normalized = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
  return parseGitDiff(normalized, "", "").files;
}

type CodexAction =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; body: string[] };

const CODEX_BEGIN = "*** Begin Patch";
const CODEX_END = "*** End Patch";
const CODEX_ADD = "*** Add File: ";
const CODEX_DELETE = "*** Delete File: ";
const CODEX_UPDATE = "*** Update File: ";
const CODEX_MOVE = "*** Move to: ";
const CODEX_EOF = "*** End of File";

function isCodexSectionStart(line: string): boolean {
  return (
    line.startsWith(CODEX_ADD) || line.startsWith(CODEX_DELETE) || line.startsWith(CODEX_UPDATE)
  );
}

export function parseCodexPatch(text: string): CodexAction[] {
  const lines = text.trim().split("\n");
  const last = lines.length - 1;
  if (lines.length < 2 || !lines[0]!.startsWith(CODEX_BEGIN) || lines[last] !== CODEX_END) {
    throw new Error("Not an apply_patch envelope");
  }

  const actions: CodexAction[] = [];
  let index = 1;
  while (index < last) {
    const line = lines[index]!;
    if (line.startsWith(CODEX_UPDATE)) {
      const path = normalizePatchPath({ path: line.slice(CODEX_UPDATE.length) });
      index += 1;
      let movePath: string | undefined;
      if (index < last && lines[index]!.startsWith(CODEX_MOVE)) {
        movePath = normalizePatchPath({ path: lines[index]!.slice(CODEX_MOVE.length) });
        index += 1;
      }
      const bodyStart = index;
      while (index < last && !isCodexSectionStart(lines[index]!)) index += 1;
      actions.push({ kind: "update", path, movePath, body: lines.slice(bodyStart, index) });
      continue;
    }
    if (line.startsWith(CODEX_DELETE)) {
      actions.push({
        kind: "delete",
        path: normalizePatchPath({ path: line.slice(CODEX_DELETE.length) }),
      });
      index += 1;
      continue;
    }
    if (line.startsWith(CODEX_ADD)) {
      const path = normalizePatchPath({ path: line.slice(CODEX_ADD.length) });
      index += 1;
      const added: string[] = [];
      while (index < last && !isCodexSectionStart(lines[index]!)) {
        const value = lines[index]!;
        if (value === CODEX_EOF) {
          index += 1;
          continue;
        }
        if (!value.startsWith("+")) throw new Error(`Invalid Add File line: ${value}`);
        added.push(value.slice(1));
        index += 1;
      }
      actions.push({ kind: "add", path, lines: added });
      continue;
    }
    throw new Error(`Unexpected apply_patch line: ${line}`);
  }

  if (actions.length === 0) throw new Error("apply_patch envelope contains no file action");
  return actions;
}

type CodexMarker = { kind: DiffLine["kind"]; text: string };

function codexMarker(raw: string): CodexMarker {
  if (raw.startsWith("+")) return { kind: "add", text: raw.slice(1) };
  if (raw.startsWith("-")) return { kind: "del", text: raw.slice(1) };
  if (raw.startsWith(" ")) return { kind: "context", text: raw.slice(1) };
  return { kind: "context", text: raw };
}

function findSequence(
  haystack: readonly string[],
  needle: readonly string[],
  from: number,
): number {
  if (needle.length === 0) return -1;
  const scan = (start: number, compare: (a: string, b: string) => boolean): number => {
    for (let index = Math.max(0, start); index + needle.length <= haystack.length; index += 1) {
      let matched = true;
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (!compare(haystack[index + offset]!, needle[offset]!)) {
          matched = false;
          break;
        }
      }
      if (matched) return index;
    }
    return -1;
  };
  const exact = (a: string, b: string) => a === b;
  const loose = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const forward = scan(from, exact);
  if (forward >= 0) return forward;
  const anywhere = scan(0, exact);
  if (anywhere >= 0) return anywhere;
  return scan(0, loose);
}

function countKind(lines: readonly DiffLine[], kind: DiffLine["kind"]): number {
  return lines.filter((line) => line.kind === kind).length;
}

function wholeFileHunk(path: string, lines: string[], kind: "add" | "del"): DiffHunk[] {
  if (lines.length === 0) return [];
  const diffLines: DiffLine[] = lines.map((text, index) =>
    kind === "add"
      ? { kind: "add", newLine: index + 1, text }
      : { kind: "del", oldLine: index + 1, text },
  );
  const header = kind === "add" ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
  return [
    {
      id: computeHunkId(path, header, diffLines),
      header,
      oldStart: kind === "add" ? 0 : 1,
      oldLines: kind === "add" ? 0 : lines.length,
      newStart: kind === "add" ? 1 : 0,
      newLines: kind === "add" ? lines.length : 0,
      lines: diffLines,
    },
  ];
}

function updateHunks(
  path: string,
  body: readonly string[],
  source: readonly string[] | undefined,
): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let index = 0;
  let searchStart = 0;
  let delta = 0;

  while (index < body.length) {
    const marker = body[index]!;
    if (marker === CODEX_EOF) break;
    if (!marker.startsWith("@@")) {
      index += 1;
      continue;
    }
    const section = marker.slice(2);
    index += 1;
    const rawLines: string[] = [];
    while (index < body.length && !body[index]!.startsWith("@@") && body[index] !== CODEX_EOF) {
      rawLines.push(body[index]!);
      index += 1;
    }
    if (rawLines.length === 0) continue;

    const entries = rawLines.map(codexMarker);
    const oldSide = entries.filter((entry) => entry.kind !== "add").map((entry) => entry.text);
    const start = source ? findSequence(source, oldSide, searchStart) : -1;
    let oldLine = start >= 0 ? start + 1 : undefined;
    let newLine = start >= 0 ? start + 1 + delta : undefined;
    const oldStart = oldLine ?? 0;
    const newStart = newLine ?? 0;

    const lines: DiffLine[] = entries.map((entry) => {
      if (entry.kind === "add") {
        const line: DiffLine = { kind: "add", newLine, text: entry.text };
        if (newLine !== undefined) newLine += 1;
        return line;
      }
      if (entry.kind === "del") {
        const line: DiffLine = { kind: "del", oldLine, text: entry.text };
        if (oldLine !== undefined) oldLine += 1;
        return line;
      }
      const line: DiffLine = { kind: "context", oldLine, newLine, text: entry.text };
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
      return line;
    });

    const oldCount = countKind(lines, "context") + countKind(lines, "del");
    const newCount = countKind(lines, "context") + countKind(lines, "add");
    const header =
      start >= 0 ? `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section}` : marker;
    hunks.push({
      id: computeHunkId(path, header, lines),
      header,
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      lines,
    });

    if (start >= 0) {
      searchStart = start + oldSide.length;
      delta += newCount - oldCount;
    }
  }

  return hunks;
}

function diffFileOf(
  path: string,
  oldPath: string | undefined,
  kind: DiffFile["kind"],
  hunks: DiffHunk[],
): DiffFile {
  const additions = hunks.reduce((total, hunk) => total + countKind(hunk.lines, "add"), 0);
  const deletions = hunks.reduce((total, hunk) => total + countKind(hunk.lines, "del"), 0);
  return oldPath
    ? { path, oldPath, kind, hunks, additions, deletions }
    : { path, kind, hunks, additions, deletions };
}

export function buildApplyPatchDiffFiles(
  patchText: string,
  cwd: string | undefined,
  readLines: (path: string) => string[] | undefined = (path) => readSourceLines(path, cwd),
): DiffFile[] {
  return parseCodexPatch(patchText).map((action) => {
    const shown = displayPath(action.path, cwd);
    if (action.kind === "add") {
      return diffFileOf(shown, undefined, "added", wholeFileHunk(shown, action.lines, "add"));
    }
    if (action.kind === "delete") {
      return diffFileOf(
        shown,
        undefined,
        "deleted",
        wholeFileHunk(shown, readLines(action.path) ?? [], "del"),
      );
    }
    const hunks = updateHunks(shown, action.body, readLines(action.path));
    return action.movePath
      ? diffFileOf(displayPath(action.movePath, cwd), shown, "renamed", hunks)
      : diffFileOf(shown, undefined, "modified", hunks);
  });
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

function totalDiffLines(files: readonly DiffFile[]): number {
  return files.reduce(
    (total, file) => total + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
    0,
  );
}

type LimitedDiff = { files: DiffFile[]; hidden: number };

function limitDiffLines(files: readonly DiffFile[], limit: number): LimitedDiff {
  const total = totalDiffLines(files);
  if (total <= limit) return { files: [...files], hidden: 0 };

  const kept: DiffFile[] = [];
  let budget = limit;
  for (const file of files) {
    const hunks: DiffHunk[] = [];
    for (const hunk of file.hunks) {
      if (budget <= 0) break;
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      hunks.push({ ...hunk, lines });
    }
    kept.push({ ...file, hunks });
    if (budget <= 0) break;
  }
  return { files: kept, hidden: total - limit };
}

function renderFiles(params: {
  label: string;
  files: readonly DiffFile[];
  theme: Theme;
  width: number;
  expanded: boolean;
  collapseLimit?: number;
}): string[] {
  const { label, theme, width } = params;
  const limit = params.expanded ? undefined : params.collapseLimit;
  const { files, hidden } =
    limit === undefined
      ? { files: [...params.files], hidden: 0 }
      : limitDiffLines(params.files, limit);
  const diffLines = totalDiffLines(params.files);
  const config = activeOptions.config?.()?.highlight ?? DEFAULT_CONFIG_HIGHLIGHT;
  const mode = activeOptions.mode ?? "unified";

  const output: string[] = [];
  for (const [index, file] of files.entries()) {
    const rendered = renderDiffFile(
      file,
      {
        mode,
        width,
        fold: () => false,
        highlight: createHighlight({ config, filePath: file.path, diffLines }),
      },
      theme,
    );
    if (index === 0) {
      const head = label
        ? `${theme.fg("toolTitle", theme.bold(label))} ${rendered[0] ?? ""}`
        : (rendered[0] ?? "");
      output.push(truncateToWidth(head, width, "…"));
      output.push(...rendered.slice(1));
      continue;
    }
    output.push("");
    output.push(...rendered);
  }

  if (output.length === 0 && label) output.push(theme.fg("toolTitle", theme.bold(label)));
  if (hidden > 0) {
    output.push(
      theme.fg("muted", `... (${hidden} more lines, ${diffLines} total, ${expandHint()})`),
    );
  }
  return output;
}

function stringField(source: RuntimeValue, ...keys: string[]): string | undefined {
  if (!isObject(source) || source === null) return undefined;
  for (const key of keys) {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const value = (source as Record<string, RuntimeValue>)[key];
    if (isString(value)) return value;
  }
  return undefined;
}

function sanitized(context: RenderContextLike): RenderContextLike {
  return isOwned(context.lastComponent) ? { ...context, lastComponent: undefined } : context;
}

function fallbackCall(
  original: AnyRenderCall | undefined,
  label: string,
  args: RuntimeValue,
  theme: Theme,
  context: RenderContextLike,
): Component {
  if (!original) return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
  return original(args, theme, sanitized(context));
}

function fallbackResult(
  original: AnyRenderResult | undefined,
  result: { content: unknown[]; details?: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContextLike,
): Component {
  if (!original) return new Text("", 0, 0);
  return original(result, options, theme, sanitized(context));
}

function toolBackground(
  theme: Theme,
  context: RenderContextLike,
  settled: boolean,
): (text: string) => string {
  if (context.isError) return (text) => theme.bg("toolErrorBg", text);
  if (settled) return (text) => theme.bg("toolSuccessBg", text);
  return (text) => theme.bg("toolPendingBg", text);
}

function renderWriteCall(
  original: AnyRenderCall | undefined,
  args: RuntimeValue,
  theme: Theme,
  context: RenderContextLike,
): Component {
  const label = toolDiffLabel("write", context);
  if (context.argsComplete !== true) return fallbackCall(original, label, args, theme, context);
  const path = stringField(args, "path", "file_path");
  const content = stringField(args, "content");
  if (path === undefined || content === undefined)
    return fallbackCall(original, label, args, theme, context);

  const shown = displayPath(path, context.cwd);
  const file = buildWriteDiffFile(shown, content);
  const expanded = context.expanded === true;
  return diffLinesComponent(
    context.lastComponent,
    (width) =>
      renderFiles({
        label,
        files: [file],
        theme,
        width,
        expanded,
        collapseLimit: COLLAPSED_BODY_LINES,
      }),
    `${label} ${shown}`,
  );
}

function renderEditCall(
  original: AnyRenderCall | undefined,
  args: RuntimeValue,
  theme: Theme,
  context: RenderContextLike,
): Component {
  if (context.isPartial !== false)
    return fallbackCall(original, TOOL_DIFF_LABELS.edit, args, theme, context);
  const path = stringField(args, "path", "file_path");
  const box = own(new Box(1, 1, toolBackground(theme, context, true)));
  const shown = path === undefined ? "" : displayPath(path, context.cwd);
  const label = toolDiffLabel("edit", context);
  const title = `${theme.fg("toolTitle", theme.bold(label))} ${shown}`.trimEnd();
  box.addChild(new Text(title, 0, 0));
  return box;
}

function renderEditResult(
  original: AnyRenderResult | undefined,
  result: { content: unknown[]; details?: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContextLike,
): Component {
  if (context.isError === true || options.isPartial) {
    return fallbackResult(original, result, options, theme, context);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const details = result.details as EditToolDetails | undefined;
  const path = stringField(context.args, "path", "file_path");
  if (!isString(details?.patch) || path === undefined) {
    return fallbackResult(original, result, options, theme, context);
  }
  const files = parseEditPatch(details.patch, displayPath(path, context.cwd));
  if (files.length === 0 || totalDiffLines(files) === 0) {
    return fallbackResult(original, result, options, theme, context);
  }

  const box = own(new Box(1, 0, toolBackground(theme, context, true)));
  box.addChild(
    new DiffLinesComponent(
      (width) =>
        renderFiles({
          label: "",
          files,
          theme,
          width,
          expanded: context.expanded === true,
        }),
      displayPath(path, context.cwd),
    ),
  );
  return box;
}

const applyPatchModels = new Map<string, DiffFile[]>();

function cacheApplyPatchModel(key: string, files: DiffFile[]): void {
  applyPatchModels.set(key, files);
  while (applyPatchModels.size > APPLY_PATCH_CACHE_LIMIT) {
    const oldest = applyPatchModels.keys().next();
    if (oldest.done) break;
    applyPatchModels.delete(oldest.value);
  }
}

export function clearToolDiffCache(): void {
  applyPatchModels.clear();
}

function applyPatchDiffFiles(patchText: string, context: RenderContextLike): DiffFile[] {
  const key =
    context.toolCallId === undefined ? undefined : `${context.toolCallId}\u0000${patchText}`;
  const cached = key === undefined ? undefined : applyPatchModels.get(key);
  if (cached) return cached;
  const files = buildApplyPatchDiffFiles(patchText, context.cwd);
  if (key !== undefined) cacheApplyPatchModel(key, files);
  return files;
}

function renderApplyPatchCall(
  original: AnyRenderCall | undefined,
  args: RuntimeValue,
  theme: Theme,
  context: RenderContextLike,
): Component {
  const label = toolDiffLabel("apply_patch", context);
  if (context.argsComplete !== true) return fallbackCall(original, label, args, theme, context);
  const patchText = stringField(args, "input", "patchText", "patch");
  if (patchText === undefined || patchText.trim().length === 0) {
    return fallbackCall(original, label, args, theme, context);
  }
  const files = applyPatchDiffFiles(patchText, context);
  if (files.length === 0) return fallbackCall(original, label, args, theme, context);

  const expanded = context.expanded === true;
  return diffLinesComponent(
    context.lastComponent,
    (width) =>
      renderFiles({
        label,
        files,
        theme,
        width,
        expanded,
        collapseLimit: COLLAPSED_BODY_LINES,
      }),
    `${label} ${files.map((file) => file.path).join(", ")}`,
  );
}

type ToolRenderers = {
  renderCall?: (
    original: AnyRenderCall | undefined,
    args: RuntimeValue,
    theme: Theme,
    context: RenderContextLike,
  ) => Component;
  renderResult?: (
    original: AnyRenderResult | undefined,
    result: { content: unknown[]; details?: unknown },
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContextLike,
  ) => Component;
};

const TOOL_RENDERERS = recordOf<ToolDiffToolName, ToolRenderers>()({
  write: { renderCall: renderWriteCall },
  edit: { renderCall: renderEditCall, renderResult: renderEditResult },
  apply_patch: { renderCall: renderApplyPatchCall },
});

function isWrappedTool(name: string): name is ToolDiffToolName {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return (TOOL_DIFF_TOOLS as readonly string[]).includes(name);
}

const decorations = new WeakMap<object, ToolDefinition>();

export function decorateToolDefinition(definition: ToolDefinition): ToolDefinition {
  if (!isWrappedTool(definition.name)) return definition;
  const cached = decorations.get(definition);
  if (cached) return cached;

  const overrides = TOOL_RENDERERS[definition.name];
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const originalCall = definition.renderCall as AnyRenderCall | undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const originalResult = definition.renderResult as AnyRenderResult | undefined;
  const name = definition.name;

  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const next = { ...definition } as ToolDefinition;
  if (overrides.renderCall) {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    next.renderCall = ((args: RuntimeValue, theme: Theme, context: RenderContextLike) => {
      try {
        return overrides.renderCall!(originalCall, args, theme, context);
      } catch {
        return fallbackCall(originalCall, toolDiffLabel(name, context), args, theme, context);
      }
    }) as ToolDefinition["renderCall"];
  }
  if (overrides.renderResult) {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    next.renderResult = ((
      result: { content: unknown[]; details?: unknown },
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContextLike,
    ) => {
      try {
        return overrides.renderResult!(originalResult, result, options, theme, context);
      } catch {
        return fallbackResult(originalResult, result, options, theme, context);
      }
    }) as ToolDefinition["renderResult"];
  }

  decorations.set(definition, next);
  return next;
}

let activeOptions: ToolDiffRenderingOptions = {};

export function installToolDiffRendering(options: ToolDiffRenderingOptions = {}): void {
  activeOptions = options;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const prototype = AgentSession.prototype as PatchedSessionPrototype;
  if (prototype.__chocoPiToolDiffApplied) return;

  const getToolDefinition = prototype.getToolDefinition;
  prototype.getToolDefinition = function getDecoratedToolDefinition(
    this: AgentSession,
    name: string,
  ): ToolDefinition | undefined {
    const definition = getToolDefinition.call(this, name);
    if (!definition) return definition;
    try {
      return decorateToolDefinition(definition);
    } catch {
      return definition;
    }
  };
  prototype.__chocoPiToolDiffApplied = true;
}
