import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
  EDITOR_CONTEXT_VERSION,
  EditorContextDocumentSchema,
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

  assert.equal(Check(EditorContextDocumentSchema, document), true);
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
