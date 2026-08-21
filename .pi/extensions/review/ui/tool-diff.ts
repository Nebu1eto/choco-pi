import { isObject, isString, recordOf, type RuntimeValue } from "../../lib/runtime-values.ts";
/**
 * Re-render Pi's file-changing tool output through the review diff renderer.
 *
 * `write`, `edit`, and `apply_patch` normally draw with Pi's plain built-in
 * diff. This module swaps only their `renderCall`/`renderResult` functions for
 * ones that build a `DiffModel` and hand it to `core/render/diff-render.ts`,
 * so tool rows get the same syntax-highlighted, token-emphasised diff as the
 * `/review` view.
 *
 * ## Why a prototype patch, and why this one
 *
 * `AgentSession.getToolDefinition()` reads `_toolDefinitions`, a registry that
 * is separate from the `_toolRegistry` the agent executes from (Pi 0.84.1,
 * `dist/core/agent-session.js`). Every caller of `getToolDefinition` is a
 * rendering or inspection path, so replacing renderers there cannot reach
 * execution. Re-registering a same-named tool through `registerTool` would
 * replace `execute` wholesale and is deliberately avoided: exact-match
 * validation, uniqueness and overlap checks, the file mutation queue, and BOM
 * and EOL preservation must stay with Pi and with the `apply_patch` provider.
 *
 * `.pi/extensions/command-filter.ts` is the precedent for the guarded
 * prototype patch and the applied-flag idiom that keeps an extension reload
 * from stacking wrappers.
 *
 * ## Failure policy
 *
 * Every wrapper is a decoration with a fallback. A patch that will not parse,
 * an unexpected result shape, a missing renderer, or a throw inside this
 * module all fall through to the tool's original renderer, so a future Pi
 * change degrades to stock rendering instead of breaking the tool row.
 *
 * Verified against Pi 0.84.1. The internals this module reads are listed
 * above; nothing else in the review feature touches them.
 */
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
import { DEFAULT_HIGHLIGHT } from "../core/config.ts";
import { computeHunkId, parseGitDiff } from "../core/diff.ts";
import { renderDiffFile } from "../core/render/diff-render.ts";
import { createHighlight } from "../core/render/highlight.ts";
import type { DiffFile, DiffHunk, DiffLine, ResolvedReviewConfig } from "../core/types.ts";

/* ------------------------------------------------------------------ types */

export type ToolDiffToolName = "write" | "edit" | "apply_patch";

/** Tools this module decorates. Every other tool passes through by identity. */
export const TOOL_DIFF_TOOLS: readonly ToolDiffToolName[] = ["write", "edit", "apply_patch"];

/**
 * Transcript header labels while the call runs. The registered name is an API
 * identifier, not something to show a reader; these match the working line's
 * verbs in choco-pi-ui's `tool-labels.ts`, so a tool reads the same mid-turn
 * and in the transcript.
 */
export const TOOL_DIFF_LABELS = {
  write: "File: Writing",
  edit: "File: Editing",
  apply_patch: "File: Patching",
} satisfies Readonly<Record<ToolDiffToolName, string>>;

/**
 * The same headers once the call has settled. A transcript row outlives the
 * work it describes, so it reads in the past tense Pi's own finished rows use
 * ("Ran", "Explored").
 */
export const TOOL_DIFF_FINISHED_LABELS = {
  write: "File: Wrote",
  edit: "File: Edited",
  apply_patch: "File: Patched",
} satisfies Readonly<Record<ToolDiffToolName, string>>;

/**
 * Pi starts a tool row with `isPartial: true` and clears it when the final
 * result arrives, so this is the moment the header switches tense.
 */
export function toolDiffLabel(name: ToolDiffToolName, context: RenderContextLike): string {
  return context.isPartial === false ? TOOL_DIFF_FINISHED_LABELS[name] : TOOL_DIFF_LABELS[name];
}

export type ToolDiffRenderingOptions = {
  /**
   * Read on every render rather than captured, so a `review.json` reload
   * takes effect without reinstalling the patch. Missing config means the
   * built-in highlight defaults.
   */
  config?: () => ResolvedReviewConfig | undefined;
  /**
   * Tool rows are usually narrower than `MIN_SPLIT_WIDTH`, and
   * `renderDiffFile` falls back to unified below it anyway, so `"unified"`
   * is the default.
   */
  mode?: "unified" | "split";
};

/**
 * Pi's `ToolRenderContext` is not exported from the package entry, so the
 * fields this module reads are declared structurally.
 */
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

/* -------------------------------------------------------------- constants */

/** Physical diff lines shown before a collapsed row is truncated. */
const COLLAPSED_BODY_LINES = 10;

/** Upper bound on a synchronous render-time read of an on-disk file. */
const MAX_RENDER_READ_BYTES = 2_000_000;

/** Bounded so a long session cannot grow the apply_patch model cache forever. */
const APPLY_PATCH_CACHE_LIMIT = 128;

const DEFAULT_CONFIG_HIGHLIGHT: ResolvedReviewConfig["highlight"] = { ...DEFAULT_HIGHLIGHT };

/* ------------------------------------------------------------- components */

/**
 * Marks every component this module returns.
 *
 * Pi hands the previous component back as `context.lastComponent`. The stock
 * renderers assume they created it (`component.cache`, `component.clear()`,
 * `component.preview`), so a fallback must never pass one of ours back.
 */
const OWNED = Symbol.for("choco-pi.review.toolDiff");

function own<T extends object>(component: T): T {
  Object.defineProperty(component, OWNED, { value: true, enumerable: false, configurable: true });
  return component;
}

function isOwned(component: RuntimeValue): boolean {
  return isObject(component) && component !== null && OWNED in component;
}

/**
 * Renders pre-formatted lines verbatim.
 *
 * `Text` word-wraps, which would break diff lines that `renderDiffFile` has
 * already truncated to the exact render width.
 */
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

  /**
   * Rendering happens after the wrapper has returned, so the guard against a
   * throwing renderer has to live here too: a throw during `render` would
   * escape into the surrounding TUI redraw.
   */
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

/* ------------------------------------------------------------------ paths */

function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) return path;
  const relativePath = relative(cwd, path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

function readSourceLines(path: string, cwd: string | undefined): string[] | undefined {
  try {
    const absolute = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
    // Rendering runs on the UI path, so an oversized file is skipped before it
    // is read rather than after.
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

/* ------------------------------------------------------- diff model: write */

/** Whole-content diff for `write`, rendered as an added file. */
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

/* -------------------------------------------------------- diff model: edit */

/**
 * Parse the unified patch the `edit` tool reports in `EditToolDetails.patch`.
 *
 * `generateUnifiedPatch` emits bare `--- path` / `+++ path` headers with no
 * `diff --git` line, and a repository path that itself starts with `a/` would
 * be mangled by the parser's prefix stripping. Rebuilding the headers from the
 * tool's own path avoids both problems and keeps `core/diff.ts` as the single
 * unified-patch parser.
 */
export function parseEditPatch(patch: string, path: string): DiffFile[] {
  const lines = patch.split("\n");
  const bodyStart = lines.findIndex((line) => line.startsWith("@@ "));
  if (bodyStart < 0) return [];
  if (path.includes("\n")) return [];
  const body = lines.slice(bodyStart).join("\n");
  const normalized = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
  return parseGitDiff(normalized, "", "").files;
}

/* -------------------------------------------------- diff model: apply_patch */

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

/**
 * Parse the `*** Begin Patch` envelope `apply_patch` receives.
 *
 * The provider package is installed only in the Pi profile, not in this
 * repository, so its parser cannot be imported here. This reads the same
 * grammar the tool documents and throws on anything it does not recognise,
 * which sends the caller back to the provider's own renderer.
 */
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
      const path = line.slice(CODEX_UPDATE.length).trim();
      index += 1;
      let movePath: string | undefined;
      if (index < last && lines[index]!.startsWith(CODEX_MOVE)) {
        movePath = lines[index]!.slice(CODEX_MOVE.length).trim();
        index += 1;
      }
      const bodyStart = index;
      while (index < last && !isCodexSectionStart(lines[index]!)) index += 1;
      actions.push({ kind: "update", path, movePath, body: lines.slice(bodyStart, index) });
      continue;
    }
    if (line.startsWith(CODEX_DELETE)) {
      actions.push({ kind: "delete", path: line.slice(CODEX_DELETE.length).trim() });
      index += 1;
      continue;
    }
    if (line.startsWith(CODEX_ADD)) {
      const path = line.slice(CODEX_ADD.length).trim();
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
  // The format tolerates a dropped leading space on an unchanged line.
  return { kind: "context", text: raw };
}

/** First index at or after `from` where `needle` occurs, retrying from 0. */
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

/**
 * Resolve the hunks of one `*** Update File` section.
 *
 * The envelope carries no line numbers, so each section is located by
 * searching the on-disk file for its unchanged-and-removed side. When the
 * search fails, the hunk still renders with blank gutters rather than
 * inventing positions.
 */
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

/** Convert an `apply_patch` envelope into renderable diff files. */
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

/* -------------------------------------------------------------- rendering */

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

/**
 * Keep at most `limit` physical diff lines.
 *
 * Truncating the model rather than the rendered output keeps syntax
 * highlighting off the lines nobody will see, which matters for a `write` of a
 * large file.
 */
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
      // `renderDiffFile` always leads with a `path  +a -b` header line, so
      // the tool label shares that line instead of duplicating the path.
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

/* ---------------------------------------------------------------- helpers */

function stringField(source: RuntimeValue, ...keys: string[]): string | undefined {
  if (!isObject(source) || source === null) return undefined;
  for (const key of keys) {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const value = (source as Record<string, RuntimeValue>)[key];
    if (isString(value)) return value;
  }
  return undefined;
}

/** Never hand one of our components back to a stock renderer. */
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

/* ------------------------------------------------------------------ write */

function renderWriteCall(
  original: AnyRenderCall | undefined,
  args: RuntimeValue,
  theme: Theme,
  context: RenderContextLike,
): Component {
  const label = toolDiffLabel("write", context);
  // While arguments still stream, Pi's incremental highlighter is the better
  // view: there is no complete file to diff yet.
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

/* ------------------------------------------------------------------- edit */

/**
 * `edit` reports the patch it actually applied only in its result, so the call
 * row keeps the title and `renderResult` draws the diff underneath it. Pi
 * composes call and result into the same container in that order, so the
 * on-screen layout is unchanged.
 */
function renderEditCall(
  original: AnyRenderCall | undefined,
  args: RuntimeValue,
  theme: Theme,
  context: RenderContextLike,
): Component {
  // Before the result settles, Pi's asynchronous pre-execution preview is
  // still the only diff available; keep it.
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
          // The label already sits on the call row; the diff header carries the path.
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

/* ------------------------------------------------------------- apply_patch */

const applyPatchModels = new Map<string, DiffFile[]>();

function cacheApplyPatchModel(key: string, files: DiffFile[]): void {
  applyPatchModels.set(key, files);
  while (applyPatchModels.size > APPLY_PATCH_CACHE_LIMIT) {
    const oldest = applyPatchModels.keys().next();
    if (oldest.done) break;
    applyPatchModels.delete(oldest.value);
  }
}

/** Exposed so tests and a session reset can drop cached render models. */
export function clearToolDiffCache(): void {
  applyPatchModels.clear();
}

/**
 * The envelope carries no line numbers, so positions come from the file as it
 * was before the patch ran. The first resolved model for a tool call is cached
 * and reused, because a re-render after execution would search the already
 * patched file.
 */
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

/* -------------------------------------------------------------- decoration */

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

/**
 * Copy a tool definition with only its renderers replaced.
 *
 * The spread preserves every other field, including `renderShell`, which
 * `tool-execution.js` resolves independently of the renderers, and `execute`,
 * which keeps its original function identity.
 */
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

/* ----------------------------------------------------------------- install */

let activeOptions: ToolDiffRenderingOptions = {};

/**
 * Route `write`, `edit`, and `apply_patch` rendering through the review diff
 * renderer.
 *
 * Safe to call repeatedly: the prototype is patched once and later calls only
 * refresh the options, so an extension reload cannot stack wrappers.
 */
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
