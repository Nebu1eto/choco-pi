import { Type } from "typebox";

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

export const EditorPositionSchema = Type.Object(
  {
    line: Type.Number(),
    column: Type.Number(),
  },
  { additionalProperties: false },
);

export const EditorSelectionSchema = Type.Object(
  {
    start: Type.Optional(EditorPositionSchema),
    end: Type.Optional(EditorPositionSchema),
    text: Type.Optional(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const EditorBufferSchema = Type.Object(
  {
    path: Type.String(),
    relativePath: Type.Optional(Type.String()),
    language: Type.Optional(Type.String()),
    symbol: Type.Optional(Type.String()),
    dirty: Type.Optional(Type.Boolean()),
    version: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const EditorContextSessionSchema = Type.Object(
  {
    sessionId: Type.String(),
    ownerId: Type.String(),
    generation: Type.Number(),
  },
  { additionalProperties: false },
);

export const EditorContextEditorSchema = Type.Object(
  {
    name: Type.String(),
    clientId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const EditorContextWorkspaceSchema = Type.Object(
  { root: Type.String() },
  { additionalProperties: false },
);

/** TypeBox is exported for boundary validation; consumers should use the plain interfaces above. */
export const EditorContextDocumentSchema = Type.Object(
  {
    version: Type.Literal(EDITOR_CONTEXT_VERSION),
    requestId: Type.String(),
    editor: EditorContextEditorSchema,
    session: EditorContextSessionSchema,
    workspace: EditorContextWorkspaceSchema,
    buffer: Type.Optional(EditorBufferSchema),
    cursor: Type.Optional(EditorPositionSchema),
    selection: Type.Optional(EditorSelectionSchema),
    capturedAt: Type.String(),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);
