import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITOR_CONTEXT_VERSION,
  isEditorContextDocument,
  isEditorContextId,
  isEditorContextOwnerId,
  isEditorContextRequestId,
  isEditorContextSessionId,
  type EditorContextDocument,
} from "../src/protocol.ts";

test("protocol schema accepts the version-one document with omitted selection bounds", () => {
  const document: EditorContextDocument = {
    version: EDITOR_CONTEXT_VERSION,
    requestId: "request.1",
    editor: { name: "zed" },
    session: { sessionId: "session.1", ownerId: "owner-1", generation: 2 },
    workspace: { root: "/workspace/project" },
    selection: { text: "selected by a Zed Task" },
    capturedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
  };

  assert.equal(isEditorContextDocument(document), true);
  assert.equal(document.selection?.start, undefined);
  assert.equal(document.selection?.end, undefined);
});

test("shared identifier predicates match the session-bridge character rules", () => {
  assert.equal(isEditorContextId("session.under_score-1"), true);
  assert.equal(isEditorContextRequestId("request.1"), true);
  assert.equal(isEditorContextSessionId("session_1"), true);
  assert.equal(isEditorContextId(""), false);
  assert.equal(isEditorContextId("contains/slash"), false);
  assert.equal(isEditorContextOwnerId("owner-1"), true);
  assert.equal(isEditorContextOwnerId("owner.1"), false);
});

test("document schema rejects invalid shapes, unknown keys and bad optional values", () => {
  const base = {
    version: 1,
    requestId: "r",
    editor: { name: "zed" },
    session: { sessionId: "s", ownerId: "o", generation: 1 },
    workspace: { root: "/w" },
    capturedAt: "a",
    expiresAt: "b",
  };
  assert.equal(isEditorContextDocument(base), true);
  assert.equal(isEditorContextDocument({ ...base, cursor: { line: 1, column: 2 } }), true);
  assert.equal(isEditorContextDocument({ ...base, buffer: undefined }), true);
  assert.equal(isEditorContextDocument({ ...base, version: 2 }), false);
  assert.equal(isEditorContextDocument({ ...base, requestId: undefined }), false);
  assert.equal(isEditorContextDocument({ ...base, requestId: 1 }), false);
  assert.equal(
    isEditorContextDocument({ ...base, cursor: { line: Number.NaN, column: 1 } }),
    false,
  );
  assert.equal(isEditorContextDocument({ ...base, buffer: null }), false);
  assert.equal(isEditorContextDocument({ ...base, selection: { truncated: "yes" } }), false);
  assert.equal(isEditorContextDocument([base]), false);
  assert.equal(isEditorContextDocument(null), false);
  // Closed objects: unknown keys are rejected at every level.
  assert.equal(isEditorContextDocument({ ...base, extra: 1 }), false);
  assert.equal(isEditorContextDocument({ ...base, editor: { name: "zed", extra: 1 } }), false);
  assert.equal(isEditorContextDocument({ ...base, cursor: { line: 1, column: 1, z: 1 } }), false);
});
