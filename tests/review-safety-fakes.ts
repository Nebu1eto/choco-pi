/** A small, real \`openReviewView\` mount for the sensitive-file and control-character tests. */
import assert from "node:assert/strict";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { computeHunkId } from "../.pi/extensions/lib/changes/patch.ts";
import type { ReviewChat, ReviewChatOptions } from "../.pi/extensions/review/core/ask.ts";
import type { DiffAssessment } from "../.pi/extensions/review/core/heuristics.ts";
import type { PullRequestMetadata } from "../.pi/extensions/review/core/pr.ts";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffModel,
  ResolvedReviewConfig,
  ReviewRecord,
} from "../.pi/extensions/review/core/types.ts";
import type { SpawnEditor } from "../.pi/extensions/review/core/editor-launch.ts";
import {
  openReviewView,
  type OpenReviewViewOptions,
  type RevealFile,
  type ReviewViewHost,
  type ReviewViewResult,
} from "../.pi/extensions/review/ui/review-view.ts";
import { unavailableZentuiLoader } from "./zentui-build.ts";

export const NOW = "2026-03-03T02:00:00.000Z";

export const CONFIG: ResolvedReviewConfig = {
  editor: { command: ["true"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
};

export const PLAIN_THEME =
  // SAFETY: The fixture supplies every Theme member the review view calls.
  {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;

export function textHunk(path: string, lines: DiffLine[], section = ""): DiffHunk {
  const header = `@@ -1,${lines.filter((line) => line.kind !== "add").length} +1,${lines.filter((line) => line.kind !== "del").length} @@${section ? ` ${section}` : ""}`;
  return {
    id: computeHunkId(path, header, lines),
    header,
    oldStart: 1,
    oldLines: lines.filter((line) => line.kind !== "add").length,
    newStart: 1,
    newLines: lines.filter((line) => line.kind !== "del").length,
    lines,
  };
}

export function changedFile(
  path: string,
  removed: string,
  added: string,
  oldPath?: string,
): DiffFile {
  const file: DiffFile = {
    path,
    kind: oldPath === undefined ? "modified" : "renamed",
    additions: 1,
    deletions: 1,
    hunks: [
      textHunk(path, [
        { kind: "del", oldLine: 1, text: removed },
        { kind: "add", newLine: 1, text: added },
      ]),
    ],
  };
  if (oldPath !== undefined) file.oldPath = oldPath;
  return file;
}

export function flatAssessment(model: DiffModel): DiffAssessment {
  return {
    files: model.files.map((file) => ({
      path: file.path,
      riskScore: 0,
      reasons: [],
      collapsed: false,
    })),
    hunks: model.files.flatMap((file) =>
      file.hunks.map((hunk) => ({ hunkId: hunk.id, collapsed: false })),
    ),
    reviewOrder: model.files.map((file) => file.path),
  };
}

export function baseRecord(model: DiffModel, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    version: 1,
    repoKey: "repo-key",
    target: { kind: "branch", base: "main" },
    baseSha: model.baseSha,
    headSha: model.headSha,
    cursor: { reviewedHunkIds: [], lastHeadSha: model.headSha },
    comments: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export type Mounted = {
  component: Component;
  notifications: string[];
  selects: string[][];
  editorTexts: string[];
  savedRecords: ReviewRecord[];
  /** The view's own result once it closes. */
  result: Promise<ReviewViewResult | undefined>;
  closed: Promise<RuntimeValue>;
  render(width: number): string[];
  press(...keys: string[]): Promise<void>;
};

export async function mount(options: {
  model: DiffModel;
  record?: ReviewRecord;
  assessments?: DiffAssessment;
  revealFile?: RevealFile;
  pullRequest?: PullRequestMetadata;
  createReviewChat?: (options: ReviewChatOptions) => ReviewChat;
  spawnEditor?: SpawnEditor;
  theme?: Theme;
  rows?: number;
}): Promise<Mounted> {
  let component: Component | undefined;
  let finish: ((value: RuntimeValue) => void) | undefined;
  const settled = new Promise<RuntimeValue>((resolve) => {
    finish = resolve;
  });
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const notifications: string[] = [];
  const selects: string[][] = [];
  const editorTexts: string[] = [];
  const savedRecords: ReviewRecord[] = [];
  const host: ReviewViewHost = {
    custom: async (factory) => {
      component = await factory(
        // SAFETY: The fixture supplies every TUI member the review view calls.
        {
          terminal: { rows: options.rows ?? 30 },
          requestRender: () => {},
          stop: () => {},
          start: () => {},
        } as never,
        options.theme ?? PLAIN_THEME,
        // SAFETY: The review view does not read key bindings.
        {} as never,
        (value) => finish?.(value),
      );
      ready();
      // SAFETY: The view resolves with its own result type.
      return (await settled) as never;
    },
    input: async () => undefined,
    notify: (message) => notifications.push(message),
    select: async (_title, choices) => {
      selects.push(choices);
      return undefined;
    },
    setEditorText: (text) => editorTexts.push(text),
  };
  const model = options.model;
  const viewOptions: OpenReviewViewOptions = {
    host,
    store: {
      load: async () => undefined,
      list: async () => [],
      save: async (record) => {
        savedRecords.push(structuredClone(record));
      },
    },
    styler: { fg: (_color, text) => text, inverse: (text) => text },
    model,
    assessments: options.assessments ?? flatAssessment(model),
    record: options.record ?? baseRecord(model),
    config: CONFIG,
    reviewRoot: "/repo",
    now: () => NOW,
    zentuiLoader: unavailableZentuiLoader,
  };
  if (options.revealFile) viewOptions.revealFile = options.revealFile;
  if (options.pullRequest) viewOptions.pullRequest = options.pullRequest;
  if (options.createReviewChat) viewOptions.createReviewChat = options.createReviewChat;
  if (options.spawnEditor) viewOptions.spawnEditor = options.spawnEditor;
  const result = openReviewView(viewOptions);
  await isReady;
  assert.ok(component?.handleInput);
  const mounted: Mounted = {
    component,
    notifications,
    selects,
    editorTexts,
    savedRecords,
    result,
    closed: settled,
    render: (width) => component?.render(width) ?? [],
    press: async (...keys) => {
      for (const key of keys) {
        component?.handleInput?.(key);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
  return mounted;
}

/** ESC colour, OSC 52 clipboard write ended by BEL, CR, LF, C1 CSI, right-to-left override. */
export const NASTY = "a\u001b[31mred\u001b]52;c;SGVsbG8=\u0007b\rc\nd\u009be\u202ef";

/** Independent of the production predicate: C0, DEL, C1 and the bidirectional controls. */
function isUnsafe(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * The view's own escapes: SGR styling (theme colours, pi-tui's truncation
 * reset) and pi-tui's cursor and fake-cursor APC markers. NASTY's `\u001b[31m` is SGR
 * too, so its sanitised glyph form is checked separately by `showsGlyphs`.
 */
const OWN_ESCAPES = [
  new RegExp(String.raw`\u001b\[[0-9;]*m`, "g"),
  new RegExp(String.raw`\u001b_pi:\/?fc\u0007`, "g"),
  new RegExp(String.raw`\u001b_pi:c\u0007`, "g"),
  // Pi's own OSC 8 hyperlink around a tool's path; the path inside is sanitised first.
  new RegExp(String.raw`\u001b\]8;;[^\u001b\u0007]*\u001b\\`, "g"),
];

/** Raw control characters left in rendered lines once the view's own styling is removed. */
export function rawControls(lines: readonly string[]): number {
  let count = 0;
  for (const line of lines) {
    let rest = line;
    for (const pattern of OWN_ESCAPES) rest = rest.replace(pattern, "");
    for (const character of rest) if (isUnsafe(character.codePointAt(0) ?? 0)) count += 1;
  }
  return count;
}

/** Raw control characters in text bound for the editor or a model, line breaks allowed. */
export function rawControlsExceptNewlines(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character !== "\n" && isUnsafe(character.codePointAt(0) ?? 0)) count += 1;
  }
  return count;
}

/** NASTY drawn as glyphs: the escape as ␛, the bell as ␇, CR as ␍, C1 and bidi as �. */
export function showsGlyphs(text: string): boolean {
  return text.includes("␛[31mred␛]52;c;SGVsbG8=␇b␍c") && text.includes("d\uFFFDe\uFFFDf");
}

export function overWidth(lines: readonly string[], width: number): number {
  return lines.filter((line) => visibleWidth(line) > width).length;
}
