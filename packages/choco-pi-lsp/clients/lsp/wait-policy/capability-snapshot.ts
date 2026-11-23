import type { LSPOperationSupport, LSPWorkspaceDiagnosticsSupport } from "../client.ts";

export interface LSPCapabilitySnapshot {
  serverId: string;
  root: string;
  operationSupport: LSPOperationSupport;
  workspaceDiagnosticsSupport: LSPWorkspaceDiagnosticsSupport;
  advertisedCommands: string[];
  rawCapabilityKeys: string[];
  launchVariant?: "classic" | "native-ts7";
}
