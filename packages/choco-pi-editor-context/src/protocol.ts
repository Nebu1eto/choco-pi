import { bool, compile, lit, num, obj, opt, str, type Schema } from "@earendil-works/pi-schema";

export const EDITOR_CONTEXT_VERSION = 1 as const;

export const EDITOR_CONTEXT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const EDITOR_CONTEXT_REQUEST_ID_PATTERN = EDITOR_CONTEXT_ID_PATTERN;

export const EDITOR_CONTEXT_SESSION_ID_PATTERN = EDITOR_CONTEXT_ID_PATTERN;

export const EDITOR_CONTEXT_OWNER_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function isEditorContextId(value: string): boolean {
  return EDITOR_CONTEXT_ID_PATTERN.test(value);
}

export function isEditorContextRequestId(value: string): boolean {
  return EDITOR_CONTEXT_REQUEST_ID_PATTERN.test(value);
}

export function isEditorContextSessionId(value: string): boolean {
  return EDITOR_CONTEXT_SESSION_ID_PATTERN.test(value);
}

export function isEditorContextOwnerId(value: string): boolean {
  return EDITOR_CONTEXT_OWNER_ID_PATTERN.test(value);
}

export interface EditorPosition {
  line: number;
  column: number;
}

export interface EditorSelection {
  start?: EditorPosition;
  end?: EditorPosition;
  text?: string;
  truncated?: boolean;
}

export interface EditorBuffer {
  path: string;
  relativePath?: string;
  language?: string;
  symbol?: string;
  dirty?: boolean;
  version?: number;
}

export interface EditorContextSession {
  sessionId: string;
  ownerId: string;
  generation: number;
}

export interface EditorContextEditor {
  name: "zed" | "neovim" | string;
  clientId?: string;
}

export interface EditorContextWorkspace {
  root: string;
}

export interface EditorContextDocument {
  version: 1;
  requestId: string;
  editor: EditorContextEditor;
  session: EditorContextSession;
  workspace: EditorContextWorkspace;
  buffer?: EditorBuffer;
  cursor?: EditorPosition;
  selection?: EditorSelection;
  capturedAt: string;
  expiresAt: string;
}

const finiteNumber = () => num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });

export const EditorPositionSchema: Schema<EditorPosition> = obj({
  line: finiteNumber(),
  column: finiteNumber(),
});

export const EditorSelectionSchema: Schema<EditorSelection> = obj({
  start: opt(EditorPositionSchema),
  end: opt(EditorPositionSchema),
  text: opt(str()),
  truncated: opt(bool()),
});

export const EditorBufferSchema: Schema<EditorBuffer> = obj({
  path: str(),
  relativePath: opt(str()),
  language: opt(str()),
  symbol: opt(str()),
  dirty: opt(bool()),
  version: opt(finiteNumber()),
});

export const EditorContextSessionSchema: Schema<EditorContextSession> = obj({
  sessionId: str(),
  ownerId: str(),
  generation: finiteNumber(),
});

export const EditorContextEditorSchema: Schema<EditorContextEditor> = obj({
  name: str(),
  clientId: opt(str()),
});

export const EditorContextWorkspaceSchema: Schema<EditorContextWorkspace> = obj({ root: str() });

export const EditorContextDocumentSchema: Schema<EditorContextDocument> = obj({
  version: lit(EDITOR_CONTEXT_VERSION),
  requestId: str(),
  editor: EditorContextEditorSchema,
  session: EditorContextSessionSchema,
  workspace: EditorContextWorkspaceSchema,
  buffer: opt(EditorBufferSchema),
  cursor: opt(EditorPositionSchema),
  selection: opt(EditorSelectionSchema),
  capturedAt: str(),
  expiresAt: str(),
});

export const isEditorContextDocument = compile(EditorContextDocumentSchema).check;
