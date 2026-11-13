import assert from "node:assert/strict";
import test from "node:test";

import { ToolPresentationTracker } from "../src/translate/tool-presentation.ts";

test("normalizes editor and terminal presentations", () => {
  const tracker = new ToolPresentationTracker();
  const edit = tracker.start({
    toolCallId: "edit",
    toolName: "edit",
    args: { file_path: "a.ts", line: 2, column: 3, oldText: "old", newText: "new" },
    cwd: "/tmp/project",
  });
  assert.deepEqual(edit.presentation.locations, [
    { path: "/tmp/project/a.ts", line: 2, column: 3 },
  ]);
  assert.deepEqual(edit.presentation.diff, {
    path: "/tmp/project/a.ts",
    oldText: "old",
    newText: "new",
  });

  const shell = tracker.start({
    toolCallId: "shell",
    toolName: "bash",
    args: { cmd: "pwd" },
    cwd: "/tmp/project",
  });
  assert.equal(shell.kind, "terminal");
  assert.deepEqual(shell.presentation.terminal, { command: "pwd", cwd: "/tmp/project" });
  assert.equal(
    tracker.end({ toolCallId: "shell", result: { exitCode: 7 }, isError: true })?.status,
    "failed",
  );
});

test("status is monotonic and streamed text is bounded", () => {
  const tracker = new ToolPresentationTracker();
  tracker.start({ toolCallId: "x", toolName: "custom", args: {} });
  const update = tracker.update({ toolCallId: "x", result: "x".repeat(40_000) });
  assert.equal(update?.text?.length, 32 * 1024);
  assert.match(update?.text ?? "", /\[truncated\]$/);
  assert.equal(
    tracker.end({ toolCallId: "x", result: "done", isError: false })?.status,
    "completed",
  );
  assert.equal(tracker.update({ toolCallId: "x", result: "late" }), undefined);
  assert.equal(tracker.end({ toolCallId: "x", result: "late", isError: true }), undefined);
});

test("supports apply patch, first edit, valid custom details, and positive locations", () => {
  const tracker = new ToolPresentationTracker();
  const patch = tracker.start({
    toolCallId: "patch",
    toolName: "apply-patch",
    args: { path: "x.ts", oldText: "a", newText: "b" },
    cwd: "/work",
  });
  assert.deepEqual(patch.presentation.diff, { path: "/work/x.ts", oldText: "a", newText: "b" });

  const firstEdit = tracker.start({
    toolCallId: "first",
    toolName: "edit",
    args: {
      path: "/x",
      line: 0,
      column: Number.MAX_SAFE_INTEGER + 1,
      edits: [{ oldText: "c", newText: "d" }],
    },
  });
  assert.deepEqual(firstEdit.presentation.diff, { path: "/x", oldText: "c", newText: "d" });
  assert.deepEqual(firstEdit.presentation.locations, [{ path: "/x" }]);

  const custom = tracker.start({
    toolCallId: "custom",
    toolName: "widget",
    args: {
      details: {
        editorToolPresentation: {
          title: "Widget task",
          summary: "Reading widget",
          locations: [{ path: "/widget", line: 4 }],
          diff: { path: "/widget", oldText: "a", newText: "b" },
          terminal: { command: "pwd", cwd: "/widget", exitCode: 0 },
        },
      },
    },
  });
  assert.deepEqual(custom.presentation, {
    title: "Widget task",
    summary: "Reading widget",
    locations: [{ path: "/widget", line: 4 }],
    diff: { path: "/widget", oldText: "a", newText: "b" },
    terminal: { command: "pwd", cwd: "/widget", exitCode: 0 },
  });
  assert.equal(custom.kind, "generic");

  const invalid = tracker.start({
    toolCallId: "invalid",
    toolName: "widget",
    args: { details: { editorToolPresentation: { locations: [{ path: 1 }] } } },
  });
  assert.deepEqual(invalid.presentation, { title: "widget" });
});

test("presents a one-file choco-pi apply_patch input as a structured diff", () => {
  const tracker = new ToolPresentationTracker();
  const patch = tracker.start({
    toolCallId: "actual-patch",
    toolName: "apply_patch",
    args: {
      input: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        " const stable = true;",
        "-const value = 'old';",
        "+const value = 'new';",
        "*** End Patch",
      ].join("\n"),
    },
    cwd: "/work/project",
  });

  assert.deepEqual(patch.presentation.locations, [
    { path: "/work/project/src/example.ts", line: 2 },
  ]);
  assert.deepEqual(patch.presentation.diff, {
    path: "/work/project/src/example.ts",
    oldText: "const stable = true;\nconst value = 'old';\n",
    newText: "const stable = true;\nconst value = 'new';\n",
  });
  assert.deepEqual(patch.presentation.diffs, [
    {
      path: "/work/project/src/example.ts",
      oldText: "const stable = true;\nconst value = 'old';\n",
      newText: "const stable = true;\nconst value = 'new';\n",
      line: 2,
    },
  ]);
});

test("presents all locations without a false diff for multi-file apply_patch input", () => {
  const tracker = new ToolPresentationTracker();
  const patch = tracker.start({
    toolCallId: "multi-patch",
    toolName: "apply_patch",
    args: {
      input: [
        "*** Begin Patch",
        "*** Update File: src/existing.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: src/added.ts",
        "+added",
        "*** Delete File: src/deleted.ts",
        "*** End Patch",
      ].join("\n"),
    },
    cwd: "/work/project",
  });

  assert.deepEqual(patch.presentation.locations, [
    { path: "/work/project/src/existing.ts", line: 1 },
    { path: "/work/project/src/added.ts", line: 1 },
    { path: "/work/project/src/deleted.ts" },
  ]);
  assert.equal(patch.presentation.summary, "Patch touches 3 files");
  assert.equal(patch.presentation.diff, undefined);
  assert.equal(patch.presentation.diffs?.length, 2);
});

test("detects embedded code-mode apply_patch envelopes and preserves ordinary exec", () => {
  const tracker = new ToolPresentationTracker();
  const patch = tracker.start({
    toolCallId: "exec-patch",
    toolName: "exec",
    args: {
      code: [
        'const label = "before";',
        'await tools.apply_patch("*** Begin Patch\\n*** Update File: greet.js\\n@@\\n-// e2e-marker\\n+// e2e-marker-2\\n*** End Patch\\n");',
        'text("done")',
      ].join("\n"),
    },
    cwd: "/work/project",
  });

  assert.equal(patch.kind, "edit");
  assert.equal(patch.presentation.title, "exec (apply_patch)");
  assert.equal(patch.presentation.diffs?.length, 1);
  assert.equal(patch.presentation.diffs?.[0]?.path, "/work/project/greet.js");
  assert.match(patch.presentation.diffs?.[0]?.oldText ?? "", /\/\/ e2e-marker/);
  assert.match(patch.presentation.diffs?.[0]?.newText ?? "", /\/\/ e2e-marker-2/);
  assert.equal(patch.presentation.diffs?.[0]?.line, 1);

  const ordinary = tracker.start({
    toolCallId: "exec-ordinary",
    toolName: "exec",
    args: { code: 'text("ordinary")' },
    cwd: "/work/project",
  });
  assert.equal(ordinary.kind, "terminal");
  assert.deepEqual(ordinary.presentation.terminal, {
    command: undefined,
    cwd: "/work/project",
  });
  assert.equal(ordinary.presentation.diffs, undefined);
});

test("parses multiple envelopes and add files while ignoring malformed and oversized regions", () => {
  const tracker = new ToolPresentationTracker();
  const code = [
    "before();",
    "*** Begin Patch",
    "*** Update File: first.ts",
    "@@ -10,2 +10,2 @@",
    " stable",
    "-old",
    "+new",
    "*** End Patch",
    "between();",
    "*** Begin Patch",
    "*** Add File: second.ts",
    "+created",
    "*** End Patch",
  ].join("\n");
  const parsed = tracker.start({
    toolCallId: "multiple",
    toolName: "exec",
    args: { source: code },
    cwd: "/work/project",
  });
  assert.deepEqual(
    parsed.presentation.diffs?.map(({ path, line }) => ({ path, line })),
    [
      { path: "/work/project/first.ts", line: 11 },
      { path: "/work/project/second.ts", line: 1 },
    ],
  );

  for (const [toolCallId, input] of [
    ["malformed", "*** Begin Patch\n*** Update File: broken.ts\nnot a hunk line\n*** End Patch"],
    [
      "oversized",
      `*** Begin Patch\n*** Add File: huge.txt\n+${"x".repeat(256 * 1024)}\n*** End Patch`,
    ],
  ] as const) {
    const result = tracker.start({
      toolCallId,
      toolName: "exec",
      args: { code: input },
      cwd: "/work/project",
    });
    assert.equal(result.kind, "terminal");
    assert.equal(result.presentation.diffs, undefined);
  }

  const locationOnly = tracker.start({
    toolCallId: "oversized-unit",
    toolName: "exec",
    args: {
      code: `*** Begin Patch\n*** Add File: large.txt\n+${"x".repeat(40_000)}\n*** End Patch`,
    },
    cwd: "/work/project",
  });
  assert.equal(locationOnly.kind, "edit");
  assert.deepEqual(locationOnly.presentation.locations, [
    { path: "/work/project/large.txt", line: 1 },
  ]);
  assert.equal(locationOnly.presentation.diffs, undefined);
});

test("adds result-reported patch locations without fabricating diff text", () => {
  const tracker = new ToolPresentationTracker();
  tracker.start({
    toolCallId: "result-paths",
    toolName: "exec",
    args: { code: "runPatchIndirectly()" },
    cwd: "/work/project",
  });
  const result = tracker.end({
    toolCallId: "result-paths",
    result: {
      content: [{ type: "text", text: "Applied patch successfully" }],
      details: {
        result: {
          changedFiles: ["src/changed.ts"],
          createdFiles: ["src/created.ts"],
          deletedFiles: [],
          movedFiles: [],
        },
      },
    },
  });

  assert.deepEqual(result?.presentation.locations, [
    { path: "/work/project/src/changed.ts" },
    { path: "/work/project/src/created.ts" },
  ]);
  assert.equal(result?.presentation.diffs, undefined);
});

test("merges validated custom presentation updates and terminal results", () => {
  const tracker = new ToolPresentationTracker();
  tracker.start({
    toolCallId: "custom-merge",
    toolName: "widget",
    args: { details: { editorToolPresentation: { title: "Initial" } } },
  });

  assert.deepEqual(
    tracker.update({
      toolCallId: "custom-merge",
      result: {
        details: {
          editorToolPresentation: {
            summary: "Updated",
            locations: [{ path: "/widget", line: 1, column: 2 }],
          },
        },
      },
    })?.presentation,
    {
      title: "Initial",
      summary: "Updated",
      locations: [{ path: "/widget", line: 1, column: 2 }],
    },
  );

  assert.deepEqual(
    tracker.end({
      toolCallId: "custom-merge",
      result: {
        details: {
          editorToolPresentation: {
            summary: "Done",
            diff: { path: "/widget", oldText: "a", newText: "b" },
          },
        },
      },
    })?.presentation,
    {
      title: "Initial",
      summary: "Done",
      locations: [{ path: "/widget", line: 1, column: 2 }],
      diff: { path: "/widget", oldText: "a", newText: "b" },
    },
  );
});

test("rejects non-positive custom locations and identifies duplicate terminals", () => {
  const tracker = new ToolPresentationTracker();
  for (const [toolCallId, line, column] of [
    ["zero", 0, 1],
    ["negative", 1, -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1, 1],
  ] as const) {
    const result = tracker.start({
      toolCallId,
      toolName: "widget",
      args: {
        details: { editorToolPresentation: { locations: [{ path: "/widget", line, column }] } },
      },
    });
    assert.deepEqual(result.presentation, { title: "widget" });
  }

  assert.equal(tracker.isTerminal("unseen"), false);
  tracker.start({ toolCallId: "active", toolName: "widget" });
  assert.equal(tracker.isTerminal("active"), false);
  tracker.end({ toolCallId: "active" });
  assert.equal(tracker.isTerminal("active"), true);
  assert.equal(tracker.end({ toolCallId: "active" }), undefined);
});

test("bounds retained terminal call state with FIFO eviction", () => {
  const tracker = new ToolPresentationTracker();
  for (let index = 0; index <= 8_192; index += 1) {
    const toolCallId = `terminal-${index}`;
    tracker.start({ toolCallId, toolName: "widget" });
    tracker.end({ toolCallId });
  }

  assert.equal(tracker.isTerminal("terminal-0"), false);
  assert.equal(tracker.isTerminal("terminal-1"), true);
  assert.equal(tracker.isTerminal("terminal-8192"), true);
});
