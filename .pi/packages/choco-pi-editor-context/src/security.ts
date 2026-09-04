import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { Check } from "typebox/value";

import {
  EDITOR_CONTEXT_VERSION,
  EditorContextDocumentSchema,
  isEditorContextId,
  isEditorContextOwnerId,
  type EditorContextDocument,
  type EditorPosition,
} from "./protocol.ts";
import {
  isBoundaryRecord,
  isNumber,
  isString,
  type BoundaryRecord,
  type BoundaryValue,
} from "./runtime-values.ts";

/** Selection text is capped at 16 KiB to keep explicit editor context bounded. */
export const DEFAULT_SELECTION_TEXT_BYTES = 16 * 1024;
/** A complete context document is capped at 64 KiB, including selection text. */
export const DEFAULT_CONTEXT_PAYLOAD_BYTES = 64 * 1024;
/** Paths are capped at 4096 UTF-16 code units, the conventional POSIX maximum. */
export const DEFAULT_PATH_LENGTH = 4096;
/** Captures more than 30 seconds ahead of the validator clock are implausible. */
export const DEFAULT_CLOCK_SKEW_MS = 30_000;
export const MAX_EDITOR_CONTEXT_DIAGNOSTICS = 16;

export interface EditorContextValidationLimits {
  selectionTextBytes: number;
  payloadBytes: number;
  pathLength: number;
  clockSkewMs: number;
}

export const DEFAULT_EDITOR_CONTEXT_VALIDATION_LIMITS: Readonly<EditorContextValidationLimits> = {
  selectionTextBytes: DEFAULT_SELECTION_TEXT_BYTES,
  payloadBytes: DEFAULT_CONTEXT_PAYLOAD_BYTES,
  pathLength: DEFAULT_PATH_LENGTH,
  clockSkewMs: DEFAULT_CLOCK_SKEW_MS,
};

export interface EditorContextFileStat {
  isSymbolicLink(): boolean;
  uid?: number;
}

/**
 * This deliberately accepts an lstat-shaped function rather than Node's fs
 * types so validation remains testable and independent from the storage layer.
 */
export type EditorContextFileStatCheck = (path: string) => EditorContextFileStat | undefined;

export type EditorContextPathPlatform = "posix" | "win32";
export type EditorContextRealpathResolver = (path: string) => string | undefined;

export interface EditorContextFileSecurityOptions {
  path: string;
  lstat?: EditorContextFileStatCheck;
  currentUid?: number;
}

export interface EditorContextValidationOptions {
  cwd: string;
  sessionId: string;
  ownerId: string;
  generation: number;
  approvedWorkspaceRoots?: readonly string[];
  now?: () => number;
  limits?: Partial<EditorContextValidationLimits>;
  pathPlatform?: EditorContextPathPlatform;
  realpath?: EditorContextRealpathResolver;
  contextFile?: EditorContextFileSecurityOptions;
}

export type EditorContextFileSecurityStatus =
  | "not-applicable"
  | "verified"
  | "ownership-unavailable";

export type EditorContextDiagnosticField =
  | "workspace.root"
  | "buffer.path"
  | "cursor.line"
  | "cursor.column"
  | "selection.start.line"
  | "selection.start.column"
  | "selection.end.line"
  | "selection.end.column";

/**
 * Diagnostics intentionally contain only fixed codes, fixed field labels, and
 * bounded numeric metadata. In particular they have no message or text field.
 */
export type EditorContextDiagnostic =
  | Readonly<{ code: "DOCUMENT_SHAPE_INVALID" }>
  | Readonly<{ code: "UNSUPPORTED_VERSION"; actual?: number }>
  | Readonly<{ code: "INVALID_REQUEST_ID" }>
  | Readonly<{ code: "INVALID_SESSION_ID" }>
  | Readonly<{ code: "INVALID_OWNER_ID" }>
  | Readonly<{ code: "PATH_NOT_ABSOLUTE"; field: "workspace.root" | "buffer.path" }>
  | Readonly<{
      code: "PATH_TOO_LONG";
      field: "workspace.root" | "buffer.path";
      actual: number;
      limit: number;
    }>
  | Readonly<{ code: "WORKSPACE_NOT_APPROVED" }>
  | Readonly<{ code: "WORKSPACE_ROOT_UNRESOLVABLE" }>
  | Readonly<{ code: "BUFFER_PATH_UNRESOLVABLE" }>
  | Readonly<{ code: "BUFFER_OUTSIDE_WORKSPACE" }>
  | Readonly<{ code: "SESSION_MISMATCH" }>
  | Readonly<{ code: "OWNER_MISMATCH" }>
  | Readonly<{ code: "GENERATION_MISMATCH" }>
  | Readonly<{ code: "TIMESTAMP_INVALID" }>
  | Readonly<{ code: "EXPIRY_NOT_AFTER_CAPTURE" }>
  | Readonly<{ code: "CONTEXT_EXPIRED" }>
  | Readonly<{ code: "CAPTURE_TIME_IN_FUTURE"; actual: number; limit: number }>
  | Readonly<{ code: "INVALID_POSITION"; field: EditorContextDiagnosticField }>
  | Readonly<{ code: "SELECTION_RANGE_INVALID" }>
  | Readonly<{ code: "SELECTION_TEXT_TOO_LARGE"; actual: number; limit: number }>
  | Readonly<{ code: "PAYLOAD_TOO_LARGE"; actual: number; limit: number }>
  | Readonly<{ code: "PAYLOAD_NOT_SERIALIZABLE" }>
  | Readonly<{ code: "CONTEXT_FILE_SYMLINK" }>
  | Readonly<{ code: "CONTEXT_FILE_FOREIGN_OWNER" }>
  | Readonly<{ code: "CONTEXT_FILE_SECURITY_UNAVAILABLE" }>;

export type EditorContextValidationResult =
  | Readonly<{
      ok: true;
      document: EditorContextDocument;
      fileSecurity: EditorContextFileSecurityStatus;
    }>
  | Readonly<{ ok: false; diagnostics: readonly EditorContextDiagnostic[] }>;

type PathApi = typeof posix;

function valueRecord(value: BoundaryValue): BoundaryRecord | undefined {
  return isBoundaryRecord(value) ? value : undefined;
}

function validPositivePosition(value: BoundaryValue): value is EditorPosition {
  const position = valueRecord(value);
  return (
    position !== undefined &&
    isNumber(position.line) &&
    Number.isSafeInteger(position.line) &&
    position.line >= 1 &&
    isNumber(position.column) &&
    Number.isSafeInteger(position.column) &&
    position.column >= 1
  );
}

function addDiagnostic(
  diagnostics: EditorContextDiagnostic[],
  diagnostic: EditorContextDiagnostic,
): void {
  if (diagnostics.length < MAX_EDITOR_CONTEXT_DIAGNOSTICS) diagnostics.push(diagnostic);
}

function boundedNumber(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 1_000_000_000;
}

function resolvedLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function resolveLimits(options: EditorContextValidationOptions): EditorContextValidationLimits {
  return {
    selectionTextBytes: resolvedLimit(
      options.limits?.selectionTextBytes,
      DEFAULT_SELECTION_TEXT_BYTES,
    ),
    payloadBytes: resolvedLimit(options.limits?.payloadBytes, DEFAULT_CONTEXT_PAYLOAD_BYTES),
    pathLength: resolvedLimit(options.limits?.pathLength, DEFAULT_PATH_LENGTH),
    clockSkewMs: resolvedLimit(options.limits?.clockSkewMs, DEFAULT_CLOCK_SKEW_MS),
  };
}

function pathApiFor(options: EditorContextValidationOptions): PathApi {
  return options.pathPlatform === "win32" ||
    (options.pathPlatform === undefined && process.platform === "win32")
    ? win32
    : posix;
}

function normalizedAbsolutePath(path: string, api: PathApi): string | undefined {
  const normalized = api.normalize(path);
  return api.isAbsolute(normalized) ? normalized : undefined;
}

function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function resolvedRealpath(
  path: string,
  api: PathApi,
  resolver: EditorContextRealpathResolver,
): string | undefined {
  let resolved: string | undefined;
  try {
    resolved = resolver(path);
  } catch {
    return undefined;
  }
  return resolved === undefined ? undefined : normalizedAbsolutePath(resolved, api);
}

function resolvedBufferPath(
  path: string,
  api: PathApi,
  resolver: EditorContextRealpathResolver,
): string | undefined {
  let candidate = path;
  const remaining: string[] = [];
  while (true) {
    const resolved = resolvedRealpath(candidate, api, resolver);
    if (resolved !== undefined) return api.join(resolved, ...remaining);
    if (resolver === defaultRealpath) {
      try {
        lstatSync(candidate);
        return undefined;
      } catch (error) {
        // SAFETY: Node filesystem errors expose errno through the optional code property.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      }
    }
    const parent = api.dirname(candidate);
    if (parent === candidate) return undefined;
    remaining.unshift(api.basename(candidate));
    candidate = parent;
  }
}

function containsPath(root: string, candidate: string, api: PathApi): boolean {
  const relative = api.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative))
  );
}

function validatePosition(
  value: BoundaryValue,
  lineField: EditorContextDiagnosticField,
  columnField: EditorContextDiagnosticField,
  diagnostics: EditorContextDiagnostic[],
): void {
  const position = valueRecord(value);
  if (
    position === undefined ||
    !isNumber(position.line) ||
    !Number.isSafeInteger(position.line) ||
    position.line < 1
  ) {
    addDiagnostic(diagnostics, { code: "INVALID_POSITION", field: lineField });
  }
  if (
    position === undefined ||
    !isNumber(position.column) ||
    !Number.isSafeInteger(position.column) ||
    position.column < 1
  ) {
    addDiagnostic(diagnostics, { code: "INVALID_POSITION", field: columnField });
  }
}

function selectionEndPrecedesStart(start: EditorPosition, end: EditorPosition): boolean {
  return end.line < start.line || (end.line === start.line && end.column < start.column);
}

function serializedPayloadBytes(value: BoundaryValue): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

function validateContextFile(
  options: EditorContextValidationOptions,
  diagnostics: EditorContextDiagnostic[],
): EditorContextFileSecurityStatus {
  const contextFile = options.contextFile;
  if (contextFile === undefined) return "not-applicable";
  if (contextFile.lstat === undefined) {
    if (process.platform !== "win32")
      addDiagnostic(diagnostics, { code: "CONTEXT_FILE_SECURITY_UNAVAILABLE" });
    return "ownership-unavailable";
  }

  let stat: EditorContextFileStat | undefined;
  try {
    stat = contextFile.lstat(contextFile.path);
  } catch {
    addDiagnostic(diagnostics, { code: "CONTEXT_FILE_SECURITY_UNAVAILABLE" });
    return "ownership-unavailable";
  }
  if (stat === undefined) {
    addDiagnostic(diagnostics, { code: "CONTEXT_FILE_SECURITY_UNAVAILABLE" });
    return "ownership-unavailable";
  }
  if (stat.isSymbolicLink()) addDiagnostic(diagnostics, { code: "CONTEXT_FILE_SYMLINK" });

  const currentUid = contextFile.currentUid ?? process.getuid?.();
  if (process.platform === "win32" || currentUid === undefined || stat.uid === undefined) {
    return "ownership-unavailable";
  }
  if (stat.uid !== currentUid) addDiagnostic(diagnostics, { code: "CONTEXT_FILE_FOREIGN_OWNER" });
  return "verified";
}

/**
 * Validates an untrusted serialized editor-context value without retaining it
 * on rejection. File ownership is checked only when contextFile is supplied;
 * Windows ownership limitations are surfaced through fileSecurity.
 */
export function validateEditorContextDocument(
  value: BoundaryValue,
  options: EditorContextValidationOptions,
): EditorContextValidationResult {
  const diagnostics: EditorContextDiagnostic[] = [];
  const limits = resolveLimits(options);
  const api = pathApiFor(options);
  const realpath = options.realpath ?? defaultRealpath;
  const document = valueRecord(value);

  if (!Check(EditorContextDocumentSchema, value))
    addDiagnostic(diagnostics, { code: "DOCUMENT_SHAPE_INVALID" });
  if (document === undefined) return { ok: false, diagnostics };

  if (document.version !== EDITOR_CONTEXT_VERSION) {
    if (isNumber(document.version)) {
      addDiagnostic(diagnostics, {
        code: "UNSUPPORTED_VERSION",
        actual: boundedNumber(document.version),
      });
    } else {
      addDiagnostic(diagnostics, { code: "UNSUPPORTED_VERSION" });
    }
  }

  if (!isString(document.requestId) || !isEditorContextId(document.requestId)) {
    addDiagnostic(diagnostics, { code: "INVALID_REQUEST_ID" });
  }

  const session = valueRecord(document.session);
  if (session !== undefined) {
    if (!isString(session.sessionId) || !isEditorContextId(session.sessionId)) {
      addDiagnostic(diagnostics, { code: "INVALID_SESSION_ID" });
    } else if (session.sessionId !== options.sessionId) {
      addDiagnostic(diagnostics, { code: "SESSION_MISMATCH" });
    }
    if (!isString(session.ownerId) || !isEditorContextOwnerId(session.ownerId)) {
      addDiagnostic(diagnostics, { code: "INVALID_OWNER_ID" });
    } else if (session.ownerId !== options.ownerId) {
      addDiagnostic(diagnostics, { code: "OWNER_MISMATCH" });
    }
    if (session.generation !== options.generation)
      addDiagnostic(diagnostics, { code: "GENERATION_MISMATCH" });
  }

  const workspace = valueRecord(document.workspace);
  let resolvedWorkspaceRoot: string | undefined;
  if (workspace !== undefined && isString(workspace.root)) {
    if (workspace.root.length > limits.pathLength) {
      addDiagnostic(diagnostics, {
        code: "PATH_TOO_LONG",
        field: "workspace.root",
        actual: boundedNumber(workspace.root.length),
        limit: limits.pathLength,
      });
    }
    const normalizedWorkspaceRoot = normalizedAbsolutePath(workspace.root, api);
    if (normalizedWorkspaceRoot === undefined) {
      addDiagnostic(diagnostics, { code: "PATH_NOT_ABSOLUTE", field: "workspace.root" });
    } else {
      resolvedWorkspaceRoot = resolvedRealpath(normalizedWorkspaceRoot, api, realpath);
      if (resolvedWorkspaceRoot === undefined) {
        addDiagnostic(diagnostics, { code: "WORKSPACE_ROOT_UNRESOLVABLE" });
      }
      const approvedRoots = [options.cwd, ...(options.approvedWorkspaceRoots ?? [])]
        .map((root) => normalizedAbsolutePath(root, api))
        .filter((root): root is string => root !== undefined)
        .map((root) => resolvedRealpath(root, api, realpath))
        .filter((root): root is string => root !== undefined);
      if (
        resolvedWorkspaceRoot !== undefined &&
        !approvedRoots.some((root) => root === resolvedWorkspaceRoot)
      ) {
        addDiagnostic(diagnostics, { code: "WORKSPACE_NOT_APPROVED" });
      }
    }
  }

  const buffer = valueRecord(document.buffer);
  if (buffer !== undefined && isString(buffer.path)) {
    if (buffer.path.length > limits.pathLength) {
      addDiagnostic(diagnostics, {
        code: "PATH_TOO_LONG",
        field: "buffer.path",
        actual: boundedNumber(buffer.path.length),
        limit: limits.pathLength,
      });
    }
    const normalizedBufferPath = normalizedAbsolutePath(buffer.path, api);
    if (normalizedBufferPath === undefined) {
      addDiagnostic(diagnostics, { code: "PATH_NOT_ABSOLUTE", field: "buffer.path" });
    } else {
      const realBufferPath = resolvedBufferPath(normalizedBufferPath, api, realpath);
      if (realBufferPath === undefined) {
        addDiagnostic(diagnostics, { code: "BUFFER_PATH_UNRESOLVABLE" });
      } else if (
        resolvedWorkspaceRoot !== undefined &&
        !containsPath(resolvedWorkspaceRoot, realBufferPath, api)
      ) {
        addDiagnostic(diagnostics, { code: "BUFFER_OUTSIDE_WORKSPACE" });
      }
    }
  }

  const capturedAt = isString(document.capturedAt) ? Date.parse(document.capturedAt) : Number.NaN;
  const expiresAt = isString(document.expiresAt) ? Date.parse(document.expiresAt) : Number.NaN;
  if (!Number.isFinite(capturedAt) || !Number.isFinite(expiresAt)) {
    addDiagnostic(diagnostics, { code: "TIMESTAMP_INVALID" });
  } else {
    if (expiresAt <= capturedAt) addDiagnostic(diagnostics, { code: "EXPIRY_NOT_AFTER_CAPTURE" });
    const now = options.now?.() ?? Date.now();
    if (expiresAt <= now) addDiagnostic(diagnostics, { code: "CONTEXT_EXPIRED" });
    if (capturedAt > now + limits.clockSkewMs) {
      addDiagnostic(diagnostics, {
        code: "CAPTURE_TIME_IN_FUTURE",
        actual: boundedNumber(capturedAt - now),
        limit: limits.clockSkewMs,
      });
    }
  }

  if (document.cursor !== undefined) {
    validatePosition(document.cursor, "cursor.line", "cursor.column", diagnostics);
  }
  const selection = valueRecord(document.selection);
  if (selection !== undefined) {
    if (selection.start !== undefined) {
      validatePosition(
        selection.start,
        "selection.start.line",
        "selection.start.column",
        diagnostics,
      );
    }
    if (selection.end !== undefined) {
      validatePosition(selection.end, "selection.end.line", "selection.end.column", diagnostics);
    }
    if (
      validPositivePosition(selection.start) &&
      validPositivePosition(selection.end) &&
      selectionEndPrecedesStart(selection.start, selection.end)
    ) {
      addDiagnostic(diagnostics, { code: "SELECTION_RANGE_INVALID" });
    }
    if (isString(selection.text)) {
      const size = Buffer.byteLength(selection.text, "utf8");
      if (size > limits.selectionTextBytes) {
        addDiagnostic(diagnostics, {
          code: "SELECTION_TEXT_TOO_LARGE",
          actual: boundedNumber(size),
          limit: limits.selectionTextBytes,
        });
      }
    }
  }

  const payloadBytes = serializedPayloadBytes(value);
  if (payloadBytes === undefined) {
    addDiagnostic(diagnostics, { code: "PAYLOAD_NOT_SERIALIZABLE" });
  } else if (payloadBytes > limits.payloadBytes) {
    addDiagnostic(diagnostics, {
      code: "PAYLOAD_TOO_LARGE",
      actual: boundedNumber(payloadBytes),
      limit: limits.payloadBytes,
    });
  }

  const fileSecurity = validateContextFile(options, diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  // SAFETY: TypeBox checked the exact schema before this boundary assertion.
  return { ok: true, document: value as EditorContextDocument, fileSecurity };
}
