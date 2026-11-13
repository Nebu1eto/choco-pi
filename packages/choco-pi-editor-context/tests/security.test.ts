import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EditorContextDocument } from "../src/protocol.ts";
import {
  validateEditorContextDocument,
  type EditorContextDiagnostic,
  type EditorContextValidationOptions,
} from "../src/security.ts";
import type { BoundaryValue } from "../src/runtime-values.ts";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function fixture(overrides: Partial<EditorContextDocument> = {}): EditorContextDocument {
  return {
    version: 1,
    requestId: "request.1",
    editor: { name: "zed", clientId: "zed-client" },
    session: { sessionId: "session.1", ownerId: "owner-1", generation: 7 },
    workspace: { root: "/a/project" },
    buffer: { path: "/a/project/src/example.ts", language: "TypeScript" },
    cursor: { line: 1, column: 1 },
    selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, text: "ok" },
    capturedAt: "2025-12-31T23:59:50.000Z",
    expiresAt: "2026-01-01T00:00:10.000Z",
    ...overrides,
  };
}

function options(
  overrides: Partial<EditorContextValidationOptions> = {},
): EditorContextValidationOptions {
  return {
    cwd: "/a/project",
    sessionId: "session.1",
    ownerId: "owner-1",
    generation: 7,
    now: () => NOW,
    realpath: (path) => path,
    ...overrides,
  };
}

function codes(
  result: ReturnType<typeof validateEditorContextDocument>,
): readonly EditorContextDiagnostic["code"][] {
  assert.equal(result.ok, false);
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function expectsCode(
  document: BoundaryValue,
  expected: EditorContextDiagnostic["code"],
  validationOptions = options(),
): void {
  assert.ok(codes(validateEditorContextDocument(document, validationOptions)).includes(expected));
}

test("accepts a canonical valid document", () => {
  const result = validateEditorContextDocument(fixture(), options());
  assert.deepEqual(result, { ok: true, document: fixture(), fileSecurity: "not-applicable" });
});

test("rejects an unsupported schema version", () => {
  expectsCode({ ...fixture(), version: 2 }, "UNSUPPORTED_VERSION");
});

test("rejects invalid request, session, and owner identifiers", () => {
  expectsCode({ ...fixture(), requestId: "not/valid" }, "INVALID_REQUEST_ID");
  expectsCode(
    { ...fixture(), session: { ...fixture().session, sessionId: "not/valid" } },
    "INVALID_SESSION_ID",
  );
  expectsCode(
    { ...fixture(), session: { ...fixture().session, ownerId: "not.valid" } },
    "INVALID_OWNER_ID",
  );
});

test("rejects relative workspace and buffer paths", () => {
  expectsCode({ ...fixture(), workspace: { root: "project" } }, "PATH_NOT_ABSOLUTE");
  expectsCode({ ...fixture(), buffer: { path: "src/example.ts" } }, "PATH_NOT_ABSOLUTE");
});

test("normalizes and accepts Windows-native absolute paths", () => {
  const document = fixture({
    workspace: { root: "C:\\a\\project\\." },
    buffer: { path: "C:\\a\\project\\src\\example.ts" },
  });
  assert.equal(
    validateEditorContextDocument(
      document,
      options({ cwd: "C:\\a\\project", pathPlatform: "win32" }),
    ).ok,
    true,
  );
});

test("matches symlinked and real workspace roots in both directions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-security-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realRoot = join(root, "real");
  const linkedRoot = join(root, "linked");
  await mkdir(realRoot);
  await symlink(realRoot, linkedRoot, "dir");

  for (const [workspaceRoot, approvedRoot] of [
    [linkedRoot, realRoot],
    [realRoot, linkedRoot],
  ]) {
    const result = validateEditorContextDocument(
      fixture({ workspace: { root: workspaceRoot }, buffer: undefined }),
      options({ cwd: approvedRoot, realpath: undefined }),
    );
    assert.equal(result.ok, true);
  }
});

test("rejects unresolvable and genuinely different workspace roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-security-different-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const approvedRoot = join(root, "approved");
  const otherRoot = join(root, "other");
  const linkedOther = join(root, "linked-other");
  await Promise.all([mkdir(approvedRoot), mkdir(otherRoot)]);
  await symlink(otherRoot, linkedOther, "dir");

  expectsCode(
    fixture({ workspace: { root: join(root, "missing") }, buffer: undefined }),
    "WORKSPACE_ROOT_UNRESOLVABLE",
    options({ cwd: approvedRoot, realpath: undefined }),
  );
  expectsCode(
    fixture({ workspace: { root: linkedOther }, buffer: undefined }),
    "WORKSPACE_NOT_APPROVED",
    options({ cwd: approvedRoot, realpath: undefined }),
  );
});

test("realpath containment rejects symlink escapes and permits a new buffer file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-security-buffer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const source = join(workspace, "src");
  const outside = join(root, "outside");
  await Promise.all([mkdir(source, { recursive: true }), mkdir(outside)]);
  await writeFile(join(outside, "escaped.ts"), "escaped\n");
  await symlink(outside, join(workspace, "linked-outside"), "dir");

  expectsCode(
    fixture({
      workspace: { root: workspace },
      buffer: { path: join(workspace, "linked-outside", "escaped.ts") },
    }),
    "BUFFER_OUTSIDE_WORKSPACE",
    options({ cwd: workspace, realpath: undefined }),
  );
  assert.equal(
    validateEditorContextDocument(
      fixture({
        workspace: { root: workspace },
        buffer: { path: join(source, "not-created-yet.ts") },
      }),
      options({ cwd: workspace, realpath: undefined }),
    ).ok,
    true,
  );
});

test("rejects a buffer when no ancestor can be resolved", () => {
  expectsCode(fixture(), "BUFFER_PATH_UNRESOLVABLE", options({ realpath: () => undefined }));
});

test("rejects cross-project roots without accepting shared prefixes", () => {
  expectsCode({ ...fixture(), workspace: { root: "/a/project2" } }, "WORKSPACE_NOT_APPROVED");
  expectsCode(
    { ...fixture(), workspace: { root: "/a/project2" }, buffer: { path: "/a/project2/file.ts" } },
    "WORKSPACE_NOT_APPROVED",
  );
});

test("accepts an explicitly approved additional workspace root", () => {
  const document = fixture({
    workspace: { root: "/a/other" },
    buffer: { path: "/a/other/file.ts" },
  });
  assert.equal(
    validateEditorContextDocument(document, options({ approvedWorkspaceRoots: ["/a/other"] })).ok,
    true,
  );
});

test("rejects runtime session and owner mismatches", () => {
  expectsCode(
    { ...fixture(), session: { ...fixture().session, sessionId: "other.1" } },
    "SESSION_MISMATCH",
  );
  expectsCode(
    { ...fixture(), session: { ...fixture().session, ownerId: "other-1" } },
    "OWNER_MISMATCH",
  );
});

test("rejects a stale generation", () => {
  expectsCode(
    { ...fixture(), session: { ...fixture().session, generation: 6 } },
    "GENERATION_MISMATCH",
  );
});

test("rejects invalid, reversed, expired, and future timestamps", () => {
  expectsCode({ ...fixture(), capturedAt: "not-a-time" }, "TIMESTAMP_INVALID");
  expectsCode(
    fixture({ capturedAt: "2026-01-01T00:00:05.000Z", expiresAt: "2026-01-01T00:00:05.000Z" }),
    "EXPIRY_NOT_AFTER_CAPTURE",
  );
  expectsCode(fixture({ expiresAt: "2025-12-31T23:59:59.000Z" }), "CONTEXT_EXPIRED");
  expectsCode(
    fixture({ capturedAt: "2026-01-01T00:00:31.000Z", expiresAt: "2026-01-01T00:01:00.000Z" }),
    "CAPTURE_TIME_IN_FUTURE",
  );
});

test("uses the injected clock for a not-yet-expired document", () => {
  assert.equal(
    validateEditorContextDocument(fixture(), options({ now: () => NOW - 1_000 })).ok,
    true,
  );
});

test("accepts one-based positions and rejects zero, negative, and fractional values", () => {
  assert.equal(validateEditorContextDocument(fixture(), options()).ok, true);
  for (const line of [0, -1, 1.5]) {
    expectsCode(fixture({ cursor: { line, column: 1 } }), "INVALID_POSITION");
  }
  for (const column of [0, -1, 1.5]) {
    expectsCode(fixture({ cursor: { line: 1, column } }), "INVALID_POSITION");
  }
});

test("rejects a selection whose end precedes its start", () => {
  expectsCode(
    fixture({ selection: { start: { line: 4, column: 1 }, end: { line: 3, column: 99 } } }),
    "SELECTION_RANGE_INVALID",
  );
});

test("enforces the selection-text byte limit at its boundary", () => {
  const validationOptions = options({ limits: { selectionTextBytes: 4 } });
  assert.equal(
    validateEditorContextDocument(fixture({ selection: { text: "four" } }), validationOptions).ok,
    true,
  );
  expectsCode(
    fixture({ selection: { text: "five!" } }),
    "SELECTION_TEXT_TOO_LARGE",
    validationOptions,
  );
});

test("rejects payloads over the configured serialized limit", () => {
  expectsCode(
    fixture({ editor: { name: "z".repeat(100) } }),
    "PAYLOAD_TOO_LARGE",
    options({ limits: { payloadBytes: 64 } }),
  );
});

test("rejects paths over the configured length limit", () => {
  expectsCode(fixture(), "PATH_TOO_LONG", options({ limits: { pathLength: 4 } }));
});

test("rejects a buffer outside the validated workspace", () => {
  expectsCode(fixture({ buffer: { path: "/a/elsewhere/file.ts" } }), "BUFFER_OUTSIDE_WORKSPACE");
});

test("rejects symlink and foreign-owner context files through the injectable lstat", () => {
  const symlinkOptions = options({
    contextFile: {
      path: "/tmp/context.json",
      currentUid: 501,
      lstat: () => ({ uid: 501, isSymbolicLink: () => true }),
    },
  });
  expectsCode(fixture(), "CONTEXT_FILE_SYMLINK", symlinkOptions);
  const foreignOwnerOptions = options({
    contextFile: {
      path: "/tmp/context.json",
      currentUid: 501,
      lstat: () => ({ uid: 502, isSymbolicLink: () => false }),
    },
  });
  expectsCode(fixture(), "CONTEXT_FILE_FOREIGN_OWNER", foreignOwnerOptions);
});

test("rejection diagnostics never retain selection text", () => {
  const sentinel = "SUPERSECRET-SENTINEL-VALUE";
  const result = validateEditorContextDocument(
    fixture({
      requestId: "invalid/id",
      workspace: { root: "relative" },
      selection: { text: sentinel.repeat(100) },
      expiresAt: "2025-12-31T23:59:59.000Z",
    }),
    options({ limits: { selectionTextBytes: 8 } }),
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});
