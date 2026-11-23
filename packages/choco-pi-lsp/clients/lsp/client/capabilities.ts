/**
 * Dynamic capability registration, configuration-section resolution, and server capability detection.
 */
import type { Static } from "@earendil-works/pi-schema";
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import { isBooleanValue } from "../schema-guards.ts";
import {
  isJsonRecord,
  type JsonObject,
  type JsonValue,
  type LspCapabilities,
  type ProviderCapabilitySchema,
} from "./schemas.ts";
import type {
  LSPClientState,
  LSPOperationSupport,
  LSPWorkspaceDiagnosticsSupport,
} from "./types.ts";

// Methods that can be registered dynamically and map to operationSupport keys
interface DynamicOperationMethodMap {
  [method: string]: keyof LSPOperationSupport;
}

const DYNAMIC_OPERATION_METHOD_MAP: DynamicOperationMethodMap = {
  "textDocument/definition": "definition",
  "textDocument/typeDefinition": "typeDefinition",
  "textDocument/declaration": "declaration",
  "textDocument/references": "references",
  "textDocument/hover": "hover",
  "textDocument/signatureHelp": "signatureHelp",
  "textDocument/documentSymbol": "documentSymbol",
  "workspace/symbol": "workspaceSymbol",
  "textDocument/codeAction": "codeAction",
  "textDocument/rename": "rename",
  "textDocument/implementation": "implementation",
  "textDocument/prepareCallHierarchy": "callHierarchy",
};

export function applyDynamicCapabilities(state: LSPClientState): void {
  const registrations = [...state.dynamicRegistrations.values()];
  const registeredMethods = new Set(registrations.map((r) => r.method));

  const hasDynamicPull =
    registeredMethods.has("textDocument/diagnostic") ||
    registeredMethods.has("workspace/diagnostic");

  if (hasDynamicPull) {
    state.workspaceDiagnosticsSupport = {
      advertised: true,
      mode: "pull",
      // #1667: workspace-pull support is what the REGISTRATION declares. The
      // spec registers workspace pull as `registerOptions.workspaceDiagnostics`
      // on a `textDocument/diagnostic` registration - `workspace/diagnostic` is
      // not itself a registrable method - so reading the method name alone
      // missed every conforming server and this client never issued a
      // workspace pull for one. The method-name check stays as a fallback for
      // servers that register it as a method anyway.
      workspaceDiagnostics:
        registrations.some((r) => r.workspaceDiagnostics === true) ||
        registeredMethods.has("workspace/diagnostic"),
      diagnosticProviderKind: "dynamic",
    };
  } else if (
    state.staticDiagnosticsMode === "push-only" &&
    state.workspaceDiagnosticsSupport.diagnosticProviderKind === "dynamic"
  ) {
    // Was only dynamically registered, now unregistered — revert to push-only
    state.workspaceDiagnosticsSupport = {
      advertised: false,
      mode: "push-only",
      workspaceDiagnostics: false,
      diagnosticProviderKind: "none",
    };
  }

  for (const [method, key] of Object.entries(DYNAMIC_OPERATION_METHOD_MAP)) {
    if (registeredMethods.has(method)) {
      state.operationSupport[key] = true;
    }
  }
}

function isJsonObjectValue(value: JsonValue): value is JsonObject {
  return isJsonRecord(value);
}

/**
 * Resolve a `workspace/configuration` request item's `section` (a dot-path,
 * e.g. "scan.jobs") against the server's `initializationOptions` blob.
 * - No section (undefined/empty) → the whole blob, per spec ("if a scope
 *   isn't asked for" the client returns the full settings for that scope).
 * - An unresolvable path → `null`, never the whole blob — a server asking
 *   for a section it doesn't get must not silently receive unrelated config.
 * Exported for the #983 regression test.
 */
export function resolveConfigurationSection(
  initialization: JsonObject | undefined,
  section: string | undefined,
): JsonValue | undefined {
  if (!initialization) return section ? null : {};
  if (!section) return initialization;
  let cur: JsonValue = initialization;
  for (const part of section.split(".")) {
    if (!isJsonObjectValue(cur) || !Object.hasOwn(cur, part)) {
      return null;
    }
    cur = cur[part];
  }
  return cur;
}

export function detectWorkspaceDiagnosticsSupport(
  capabilities: LspCapabilities | undefined,
): LSPWorkspaceDiagnosticsSupport {
  const diagnosticProvider = capabilities?.diagnosticProvider;
  if (!diagnosticProvider) {
    return {
      advertised: false,
      mode: "push-only",
      workspaceDiagnostics: false,
      diagnosticProviderKind: "none",
    };
  }

  if (isBooleanValue(diagnosticProvider)) {
    return {
      advertised: diagnosticProvider,
      mode: diagnosticProvider ? "pull" : "push-only",
      // The boolean form of diagnosticProvider only signals document pull.
      workspaceDiagnostics: false,
      diagnosticProviderKind: "boolean",
    };
  }

  return {
    advertised: true,
    mode: "pull",
    workspaceDiagnostics: diagnosticProvider.workspaceDiagnostics === true,
    diagnosticProviderKind: "object",
  };
}

export function detectExecuteCommands(capabilities: LspCapabilities | undefined): string[] {
  const commands = capabilities?.executeCommandProvider?.commands;
  return Array.isArray(commands)
    ? commands.filter((command): command is string => isRuntimeString(command))
    : [];
}

export function detectOperationSupport(
  capabilities: LspCapabilities | undefined,
): LSPOperationSupport {
  const hasProvider = (value: Static<typeof ProviderCapabilitySchema> | undefined): boolean => {
    if (value === undefined || value === null) return false;
    return isBooleanValue(value) ? value : true;
  };

  return {
    definition: hasProvider(capabilities?.definitionProvider),
    typeDefinition: hasProvider(capabilities?.typeDefinitionProvider),
    declaration: hasProvider(capabilities?.declarationProvider),
    references: hasProvider(capabilities?.referencesProvider),
    hover: hasProvider(capabilities?.hoverProvider),
    signatureHelp: hasProvider(capabilities?.signatureHelpProvider),
    documentSymbol: hasProvider(capabilities?.documentSymbolProvider),
    workspaceSymbol: hasProvider(capabilities?.workspaceSymbolProvider),
    codeAction: hasProvider(capabilities?.codeActionProvider),
    rename: hasProvider(capabilities?.renameProvider),
    implementation: hasProvider(capabilities?.implementationProvider),
    callHierarchy: hasProvider(capabilities?.callHierarchyProvider),
  };
}
