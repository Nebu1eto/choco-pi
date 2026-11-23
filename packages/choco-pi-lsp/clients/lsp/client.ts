/**
 * LSP Client for choco-pi-lsp
 *
 * Handles JSON-RPC communication with language servers:
 * - Initialize/shutdown lifecycle
 * - Document synchronization (didOpen, didChange)
 * - Diagnostics with debouncing
 * - Request/response handling
 *
 * This module is a facade: the implementation lives in `./client/`, and this file
 * re-exports the public surface unchanged.
 */
export type {
  LSPDiagnostic,
  LSPPullFailure,
  LSPLocation,
  LSPHover,
  LSPSignatureHelp,
  LSPCodeAction,
  LSPWorkspaceEdit,
  LSPWorkspaceDiagnosticsSupport,
  LSPShutdownOptions,
  LSPOperationSupport,
  LSPSymbol,
  LSPCallHierarchyItem,
  LSPCallHierarchyIncomingCall,
  LSPCallHierarchyOutgoingCall,
  LSPClientInfo,
  DynamicRegistration,
  LSPClientState,
} from "./client/types.ts";
export { CLIENT_CAPABILITIES } from "./client/constants.ts";
export { killProcessTree, clientShutdown } from "./client/process.ts";
export {
  stripDiagnosticNoiseLines,
  pullDiagnosticSources,
  bumpDiagnosticsVersion,
  diagnosticsVersionForPath,
  clearDiagnosticsForPath,
} from "./client/diagnostics-store.ts";
export {
  handleNotifyExternalChange,
  handleNotifyOpen,
  handleNotifyChange,
  closeDocument,
} from "./client/document-sync.ts";
export { applyDynamicCapabilities, resolveConfigurationSection } from "./client/capabilities.ts";
export { setupIncomingHandlers } from "./client/incoming-handlers.ts";
export {
  clientRequestWorkspaceDiagnostics,
  clientWaitForDiagnostics,
} from "./client/workspace-diagnostics.ts";
export { navRequest } from "./client/navigation.ts";
export {
  runServerCommand,
  runReadOnlyServerCommand,
  normalizeClientWorkspaceEdit,
} from "./client/commands.ts";
export { createLSPClient } from "./client/create-client.ts";
