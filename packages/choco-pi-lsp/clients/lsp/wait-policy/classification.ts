import { getServersForFileWithConfig } from "../config.ts";
import type { LSPService } from "../index.ts";
import { getStrategy } from "./strategies.ts";
import type { LSPCapabilitySnapshot } from "./capability-snapshot.ts";

export type CascadeWaitTier = "pull-capable" | "tier3-silent" | "waits";

export function classifyServerWaitTier(
  serverId: string,
  snapshot: LSPCapabilitySnapshot | undefined,
): CascadeWaitTier {
  if (!snapshot) return "waits";

  const mode = snapshot.workspaceDiagnosticsSupport?.mode;
  if (mode === "pull") return "pull-capable";
  if (mode !== "push-only") return "waits";

  const strategy = getStrategy(serverId, snapshot.launchVariant);
  if (strategy.silentOnClean !== true) return "waits";

  if (snapshot.launchVariant === "native-ts7") return "waits";

  return "tier3-silent";
}

export function resolvePrimaryServerForWaitPolicy(
  filePath: string,
  snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): { serverId: string; snapshot: LSPCapabilitySnapshot | undefined } | undefined {
  const servers = getServersForFileWithConfig(filePath).filter((s) => s.role !== "auxiliary");
  const primary = servers[0];
  if (!primary) return undefined;
  return {
    serverId: primary.id,
    snapshot: snapshots.find((s) => s.serverId === primary.id),
  };
}

export function classifyCascadeWaitTier(
  lspService: Pick<LSPService, "getCapabilitySnapshots">,
  filePath: string,
  snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
  void lspService;
  const primary = resolvePrimaryServerForWaitPolicy(filePath, snapshots);
  if (!primary) return "waits";
  return classifyServerWaitTier(primary.serverId, primary.snapshot);
}
