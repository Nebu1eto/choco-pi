import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fc from "fast-check";

import { parsePatchActions } from "../.pi/packages/choco-pi-codex/src/patch/parser.ts";
import {
  normalizePatchPath,
  resolvePatchPath,
} from "../.pi/packages/choco-pi-codex/src/patch/paths.ts";
import {
  DiffError,
  ExecutePatchError,
  type ParsedPatchAction,
} from "../.pi/packages/choco-pi-codex/src/patch/types.ts";
import { getBundledApplyPatchBinaryPath } from "../.pi/packages/choco-pi-codex/src/tools/apply-patch/binary.ts";
import { enrichApplyPatchContextFailure } from "../.pi/packages/choco-pi-codex/src/tools/apply-patch/context-preflight.ts";
import { touchedPatchPaths } from "../.pi/packages/choco-pi-codex/src/tools/apply-patch/execute.ts";
import { executePatchWithRust } from "../.pi/packages/choco-pi-codex/src/tools/apply-patch/executor.ts";

// Fixed seed and run count keep the suite deterministic; fast-check prints the
// seed, path, and shrunk counterexample when a property fails.
const RUNS = { seed: 0x5eed_5a7c, numRuns: 300 };
const CWD = "/workspace/project";

// A path with no character the header boundary alters.
const cleanPath = fc
  .array(fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,7}$/), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));

type Decoration = "plain" | "at" | "double" | "single" | "atDouble" | "padded";

const decoration = fc.constantFrom<Decoration>(
  "plain",
  "at",
  "double",
  "single",
  "atDouble",
  "padded",
);

function decorate(value: string, kind: Decoration): string {
  switch (kind) {
    case "plain":
      return value;
    case "at":
      return `@${value}`;
    case "double":
      return `"${value}"`;
    case "single":
      return `'${value}'`;
    case "atDouble":
      return `@"${value}"`;
    case "padded":
      return `  ${value}\t`;
  }
}

/**
 * The path the bundled apply_patch binary reads from a decorated header,
 * as observed by running it: "@" and quotes are kept, leading spaces are kept,
 * and the trailing tab is dropped. The differential properties below check the
 * TypeScript boundary against the binary itself.
 */
function headerPath(value: string, kind: Decoration): string {
  return kind === "padded" ? `  ${value}` : decorate(value, kind);
}

// A single line that the parser treats as plain content: no newline and no
// "*** " control prefix.
const contentLine = fc
  .string({ maxLength: 12 })
  .filter((line) => !line.includes("\n") && !line.startsWith("***"));

type GeneratedAction =
  | { type: "add"; content: string[] }
  | { type: "delete" }
  | { type: "update"; movePath: string | undefined; body: string[] };

const generatedAction: fc.Arbitrary<GeneratedAction> = fc.oneof(
  fc.record({
    type: fc.constant("add" as const),
    content: fc.array(contentLine, { maxLength: 4 }),
  }),
  fc.record({ type: fc.constant("delete" as const) }),
  fc.record({
    type: fc.constant("update" as const),
    movePath: fc.option(cleanPath, { nil: undefined }),
    body: fc.array(contentLine, { minLength: 1, maxLength: 4 }),
  }),
);

const generatedPatch = fc
  .uniqueArray(cleanPath, { minLength: 1, maxLength: 5 })
  .chain((paths) =>
    fc.tuple(
      fc.constant(paths),
      fc.array(generatedAction, { minLength: paths.length, maxLength: paths.length }),
      fc.array(decoration, { minLength: paths.length, maxLength: paths.length }),
    ),
  );

type RenderedPatch = { text: string; expected: ParsedPatchAction[] };

function renderPatch(
  paths: readonly string[],
  actions: readonly GeneratedAction[],
  decorations: readonly Decoration[],
): RenderedPatch {
  const lines = ["*** Begin Patch"];
  const expected: ParsedPatchAction[] = [];
  actions.forEach((action, index) => {
    const target = paths[index]!;
    const kind = decorations[index]!;
    const header = decorate(target, kind);
    const reported = headerPath(target, kind);
    switch (action.type) {
      case "add":
        lines.push(`*** Add File: ${header}`, ...action.content.map((line) => `+${line}`));
        expected.push({
          type: "add",
          path: reported,
          newFile: action.content.length === 0 ? "" : `${action.content.join("\n")}\n`,
        });
        break;
      case "delete":
        lines.push(`*** Delete File: ${header}`);
        expected.push({ type: "delete", path: reported });
        break;
      case "update":
        lines.push(`*** Update File: ${header}`);
        if (action.movePath !== undefined) lines.push(`*** Move to: ${action.movePath}`);
        lines.push(...action.body);
        expected.push({
          type: "update",
          path: reported,
          movePath: action.movePath,
          lines: action.body,
        });
        break;
    }
  });
  lines.push("*** End Patch");
  return { text: lines.join("\n"), expected };
}

test("normalizePatchPath keeps @, quotes, and leading spaces and drops trailing whitespace", () => {
  fc.assert(
    fc.property(cleanPath, decoration, (value, kind) => {
      assert.equal(normalizePatchPath({ path: decorate(value, kind) }), headerPath(value, kind));
    }),
    RUNS,
  );
});

// Nested decorations such as '"@0"' are where a stripping boundary loses idempotence.
const doublyDecorated = fc
  .tuple(cleanPath, decoration, decoration)
  .map(([value, inner, outer]) => decorate(decorate(value, inner), outer));

test("normalizePatchPath is idempotent", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string({ unit: "binary", maxLength: 16 }), doublyDecorated), (raw) => {
      const once = normalizePatchPath({ path: raw });
      assert.equal(normalizePatchPath({ path: once }), once);
    }),
    RUNS,
  );
});

test("parsePatchActions reports every well-formed action with the path the header names", () => {
  fc.assert(
    fc.property(generatedPatch, ([paths, actions, decorations]) => {
      const { text, expected } = renderPatch(paths, actions, decorations);
      assert.deepEqual(parsePatchActions({ text }), expected);
    }),
    RUNS,
  );
});

// Header spellings the binary reads as the same file: tabs and carriage returns
// are removed and trailing whitespace is trimmed.
type Spelling = "plain" | "trailingSpaces" | "trailingTab" | "leadingTab" | "carriageReturn";

const spelling = fc.constantFrom<Spelling>(
  "plain",
  "trailingSpaces",
  "trailingTab",
  "leadingTab",
  "carriageReturn",
);

function spell(value: string, kind: Spelling): string {
  switch (kind) {
    case "plain":
      return value;
    case "trailingSpaces":
      return `${value}  `;
    case "trailingTab":
      return `${value}\t`;
    case "leadingTab":
      return `\t${value}`;
    case "carriageReturn":
      return `${value}\r`;
  }
}

test("parsePatchActions rejects two update headers that name the same file", () => {
  fc.assert(
    fc.property(cleanPath, spelling, spelling, contentLine, (value, first, second, body) => {
      const text = [
        "*** Begin Patch",
        `*** Update File: ${spell(value, first)}`,
        body,
        `*** Update File: ${spell(value, second)}`,
        body,
        "*** End Patch",
      ].join("\n");
      assert.throws(
        () => parsePatchActions({ text }),
        (error: Error) => error instanceof DiffError && /Duplicate Path/.test(error.message),
      );
    }),
    RUNS,
  );
});

// Arbitrary text built from patch-like fragments, so most inputs reach the
// parser's header and body handling rather than failing the envelope check.
const patchFragment = fc.oneof(
  fc.constantFrom(
    "*** Begin Patch",
    "*** End Patch",
    "*** Add File: ",
    "*** Delete File: ",
    "*** Update File: ",
    "*** Move to: ",
    "+",
    "@@",
    "\n",
    " ",
    '"',
    "@",
  ),
  fc.string({ maxLength: 6 }),
);

const fragmentText = fc.array(patchFragment, { maxLength: 24 }).map((parts) => parts.join(""));

// Half the inputs carry a valid envelope so the body parser is reached often.
const patchLikeText = fc.oneof(
  fragmentText,
  fragmentText.map((body) =>
    ["*** Begin Patch", body, "*** End Patch"].filter((line) => line !== "").join("\n"),
  ),
);

test("parsePatchActions fails only with DiffError", () => {
  fc.assert(
    fc.property(patchLikeText, (text) => {
      try {
        parsePatchActions({ text });
      } catch (error) {
        assert.ok(error instanceof DiffError, `non-DiffError thrown: ${String(error)}`);
      }
    }),
    RUNS,
  );
});

// execute.ts locks touchedPatchPaths(), and context-preflight.ts resolves the
// parser-reported path, so both must name that path resolved against cwd.
test("the lock key for a parsed path is that path resolved against cwd", () => {
  fc.assert(
    fc.property(cleanPath, decoration, decoration, (value, inner, outer) => {
      const header = decorate(decorate(value, inner), outer);
      const text = ["*** Begin Patch", `*** Delete File: ${header}`, "*** End Patch"].join("\n");
      const [action] = parsePatchActions({ text });
      assert.ok(action);
      const resolved = path.resolve(CWD, action.path);
      assert.equal(resolvePatchPath({ cwd: CWD, patchPath: action.path }), resolved);
      assert.deepEqual(touchedPatchPaths(CWD, text), [resolved]);
    }),
    RUNS,
  );
});

// Differential properties: the bundled Rust binary is the only applier, so it
// is the reference for which file a header names.
const BINARY = getBundledApplyPatchBinaryPath();
const BINARY_SKIP = BINARY
  ? false
  : `no bundled apply_patch binary for ${process.platform}-${process.arch}`;
const NATIVE_RUNS = { seed: 0x5eed_5a7c, numRuns: 40 };

// Fragments around a required alphanumeric core, so every segment names a real
// entry (never "", ".", or "..") and no header starts with "/".
const segmentCore = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,4}$/);
const segmentFragment = fc.constantFrom(
  "@",
  '"',
  "'",
  " ",
  "  ",
  "\t",
  "\r",
  "é",
  "日本",
  "\u00a0",
  "\u3000",
  "\u0085",
  "\ufeff",
  ".",
);
const headerSegment = fc
  .tuple(
    fc.array(segmentFragment, { maxLength: 3 }),
    segmentCore,
    fc.array(segmentFragment, { maxLength: 3 }),
  )
  .map(([before, core, after]) => `${before.join("")}${core}${after.join("")}`);
const nativeHeader = fc
  .array(headerSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));
// Shapes that distinguish a stripping boundary from the binary's reading.
const NATIVE_EXAMPLES: [string][] = [
  ["@0"],
  ['"@0"'],
  ["'0'"],
  ['"a b"'],
  ["  pad\t"],
  ["x\ty"],
  ["a\ufeff"],
];

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "prop-patch-paths-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "the file the binary adds is the file TypeScript reports, resolves, and locks",
  { skip: BINARY_SKIP },
  async () => {
    await fc.assert(
      fc.asyncProperty(nativeHeader, (header) =>
        withScratchDir(async (dir) => {
          const text = ["*** Begin Patch", `*** Add File: ${header}`, "+x", "*** End Patch"].join(
            "\n",
          );
          const [action] = parsePatchActions({ text });
          assert.ok(action);
          const resolved = resolvePatchPath({ cwd: dir, patchPath: action.path });
          assert.deepEqual(touchedPatchPaths(dir, text), [resolved]);
          await executePatchWithRust({ cwd: dir, patchText: text });
          assert.deepEqual(await listFiles(dir), [resolved]);
        }),
      ),
      { ...NATIVE_RUNS, examples: NATIVE_EXAMPLES },
    );
  },
);

test(
  "context preflight reads the file the binary failed to update",
  { skip: BINARY_SKIP },
  async () => {
    await fc.assert(
      fc.asyncProperty(nativeHeader, (header) =>
        withScratchDir(async (dir) => {
          const add = ["*** Begin Patch", `*** Add File: ${header}`, "+one", "*** End Patch"];
          await executePatchWithRust({ cwd: dir, patchText: add.join("\n") });
          const update = [
            "*** Begin Patch",
            `*** Update File: ${header}`,
            "@@",
            "-missing",
            "+two",
            "*** End Patch",
          ].join("\n");
          const failure = await executePatchWithRust({ cwd: dir, patchText: update }).then(
            () => undefined,
            (error: Error) => error,
          );
          assert.ok(failure instanceof ExecutePatchError, String(failure));
          const [action] = parsePatchActions({ text: update });
          assert.ok(action);
          const guidance = enrichApplyPatchContextFailure(failure, dir);
          assert.ok(guidance, `no preflight diagnostic for ${JSON.stringify(header)}`);
          assert.match(guidance, /Current line count: 1\n/);
          assert.ok(guidance.includes(`Path: ${action.path}\n`));
        }),
      ),
      { ...NATIVE_RUNS, examples: NATIVE_EXAMPLES },
    );
  },
);
