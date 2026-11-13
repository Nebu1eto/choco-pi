import { bool, compile, lit, num, obj, opt, str, type Schema } from "@earendil-works/pi-schema";

/** The only editor-context document version accepted by this package. */
export const EDITOR_CONTEXT_VERSION = 1 as const;

/** Session and request IDs allow the session-bridge charset, including dots and underscores. */
export const EDITOR_CONTEXT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Request IDs intentionally use the session-ID charset for safe file correlation. */
export const EDITOR_CONTEXT_REQUEST_ID_PATTERN = EDITOR_CONTEXT_ID_PATTERN;

/** Session IDs match the existing session-bridge character rule exactly. */
export const EDITOR_CONTEXT_SESSION_ID_PATTERN = EDITOR_CONTEXT_ID_PATTERN;

/** Owner IDs use the session-bridge owner charset. */
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

/**
 * A one-based editor location. Adapters must convert editor-native indexing
 * before serializing this protocol.
 */
export interface EditorPosition {
  line: number;
  column: number;
}

export interface EditorSelection {
  /** Zed Tasks omit this when they cannot provide an exact selection boundary. */
  start?: EditorPosition;
  /** Zed Tasks omit this when they cannot provide an exact selection boundary. */
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

// TypeBox Number rejected NaN and +/-Infinity but pi-schema num() accepts them; the finite bounds restore that
// (NaN fails the bound comparisons).
const finiteNumber = () => num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });

// All schemas are closed (additionalProperties: false in the TypeBox originals), so unknown keys are rejected.
// Each schema is annotated with the exported interface, which the compiler checks against the builder shape.
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

/** pi-schema schema for boundary validation; consumers should use the plain interfaces above. */
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

/** Compiled once; true only for an exact version-one document (unknown keys rejected). */
export const isEditorContextDocument = compile(EditorContextDocumentSchema).check;
