import * as os from "node:os";
import type { Static } from "@earendil-works/pi-schema";
import { finiteNum } from "../schema-guards.ts";
import {
  arr,
  bool,
  map,
  nul,
  obj,
  opt,
  str,
  union,
  unknown,
  compile,
} from "@earendil-works/pi-schema";
import type { LSPDiagnostic, LSPWorkspaceEdit } from "./types.ts";

export const PUB_DEBUG = Boolean(process.env.PILENS_PUB_DEBUG);

export function extractSpawnMarker(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  const tmpDir = os.tmpdir();
  for (let i = 0; i < args.length - 1; i++) {
    const flag = args[i];
    if (flag === "--config" || flag === "-c") {
      const value = args[i + 1];
      if (value?.startsWith(tmpDir)) return value;
    }
  }
  return undefined;
}

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonRpcParams {
  textDocument?: object;
  position?: object;
  context?: object;
  range?: object;
  query?: string;
  newName?: string;
  files?: object[];
  item?: object;
}

export interface LegacyDiagnosticsState {
  diagnostics: Map<string, LSPDiagnostic[]> | undefined;
}

export interface LegacyDiagnosticCacheState extends LegacyDiagnosticsState {
  diagnosticTimestamps: Map<string, number> | undefined;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

const JsonObjectSchema = obj({}, { open: true });
export const isJsonRecord = compile(JsonObjectSchema).check;

const ErrorCodeSchema = obj(
  {
    code: opt(union([str(), finiteNum()])),
  },
  { open: true },
);
export const isErrorCode = compile(ErrorCodeSchema).check;

export interface ErrorDetails {
  code?: string | number;
  message?: string;
}

const ErrorDetailsSchema = obj(
  {
    code: opt(union([str(), finiteNum()])),
    message: opt(str()),
  },
  { open: true },
);
export const isErrorDetails = compile(ErrorDetailsSchema).check;

const LspCodeActionSchema = obj({ title: str() }, { open: true });
export const isLspCodeAction = compile(LspCodeActionSchema).check;

const WorkspaceEditSchema = obj(
  {
    changes: opt(union([map(arr(unknown())), nul()])),
    documentChanges: opt(union([arr(unknown()), nul()])),
    changeAnnotations: opt(union([JsonObjectSchema, nul()])),
  },
  { open: true },
);
const isWorkspaceEdit = compile(WorkspaceEditSchema).check;

const VersionedTextDocumentChangeSchema = obj(
  {
    textDocument: obj(
      {
        uri: opt(str()),
        version: opt(union([finiteNum(), nul()])),
      },
      { open: true },
    ),
  },
  { open: true },
);
export const isVersionedTextDocumentChange = compile(VersionedTextDocumentChangeSchema).check;

export function parseWorkspaceEditPayload<T>(value: T): LSPWorkspaceEdit | undefined {
  if (!isWorkspaceEdit(value)) return undefined;
  const edit: LSPWorkspaceEdit = {};
  if (value.changes) edit.changes = value.changes;
  if (value.documentChanges) edit.documentChanges = value.documentChanges;
  if (value.changeAnnotations) {
    // SAFETY: JsonObjectSchema established a JSON object; pi-schema types an open empty-object schema as an empty object type.
    edit.changeAnnotations = value.changeAnnotations as JsonObject;
  }
  return edit;
}

const DiagnosticProviderSchema = union([
  nul(),
  bool(),
  obj({ workspaceDiagnostics: opt(union([bool(), nul()])) }, { open: true }),
]);

export const ProviderCapabilitySchema = union([nul(), bool(), obj({}, { open: true })]);

const LspCapabilitiesSchema = obj(
  {
    diagnosticProvider: opt(DiagnosticProviderSchema),
    executeCommandProvider: opt(
      union([nul(), obj({ commands: opt(union([arr(unknown()), nul()])) }, { open: true })]),
    ),
    positionEncoding: opt(union([str(), nul()])),
    textDocumentSync: opt(
      union([
        nul(),
        finiteNum(),
        obj({ change: opt(union([finiteNum(), nul()])) }, { open: true }),
      ]),
    ),
    definitionProvider: opt(ProviderCapabilitySchema),
    typeDefinitionProvider: opt(ProviderCapabilitySchema),
    declarationProvider: opt(ProviderCapabilitySchema),
    referencesProvider: opt(ProviderCapabilitySchema),
    hoverProvider: opt(ProviderCapabilitySchema),
    signatureHelpProvider: opt(ProviderCapabilitySchema),
    documentSymbolProvider: opt(ProviderCapabilitySchema),
    workspaceSymbolProvider: opt(ProviderCapabilitySchema),
    codeActionProvider: opt(ProviderCapabilitySchema),
    renameProvider: opt(ProviderCapabilitySchema),
    implementationProvider: opt(ProviderCapabilitySchema),
    callHierarchyProvider: opt(ProviderCapabilitySchema),
  },
  { open: true },
);

export type LspCapabilities = Static<typeof LspCapabilitiesSchema>;

const InitializeResultSchema = obj(
  { capabilities: opt(union([LspCapabilitiesSchema, nul()])) },
  { open: true },
);
export const isInitializeResult = compile(InitializeResultSchema).check;

export type InitializeResult = Static<typeof InitializeResultSchema>;

const DynamicRegistrationParamsSchema = obj(
  {
    registrations: opt(
      arr(
        obj(
          {
            id: str(),
            method: str(),
            registerOptions: opt(
              union([
                obj(
                  {
                    commands: opt(unknown()),
                    identifier: opt(unknown()),
                    workspaceDiagnostics: opt(unknown()),
                  },
                  { open: true },
                ),
                nul(),
              ]),
            ),
          },
          { open: true },
        ),
      ),
    ),
  },
  { open: true },
);
export const isDynamicRegistrationParams = compile(DynamicRegistrationParamsSchema).check;

export interface MutableDynamicRegistration {
  method: string;
  identifier?: string;
  workspaceDiagnostics?: boolean;
  commands?: string[];
}
