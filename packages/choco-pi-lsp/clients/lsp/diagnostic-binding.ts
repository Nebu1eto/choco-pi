import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { PathKeyedMap } from "../path-keyed-map.ts";
import { normalizeEphemeralMapKey } from "../path-utils.ts";

export type BoundToCurrentDisk = boolean | "unknown";

export interface StoredDiagnosticBinding {
  version?: number;
  contentHash?: string;
}

export interface DiagnosticBinding extends StoredDiagnosticBinding {
  boundToCurrentDisk: BoundToCurrentDisk;
}

export interface TouchFileResult {
  diags: import("./client.ts").LSPDiagnostic[];
  confirmation?: "confirmed" | "partial";
  inconclusive?: boolean;
  inconclusiveServerIds?: string[];
  inconclusiveReason?: TouchInconclusiveReason;
  unconfirmedServerIds?: string[];
  binding?: DiagnosticBinding;
}

export type TouchInconclusiveReason = "notify-write" | "diagnostics-wait" | "mixed";

export interface TouchVerdictInput {
  primaryNotifyWriteTimedOutServerIds: readonly string[];
  diagnosticsTimedOut: boolean;
  diagnosticsUnansweredServerIds: readonly string[];
}

export interface TouchVerdict {
  inconclusive: boolean;
  inconclusiveServerIds?: string[];
  inconclusiveReason?: TouchInconclusiveReason;
}

export function resolveTouchVerdict(input: TouchVerdictInput): TouchVerdict {
  const notifyIds = [...new Set(input.primaryNotifyWriteTimedOutServerIds)];
  const waitIds = input.diagnosticsTimedOut
    ? [...new Set(input.diagnosticsUnansweredServerIds)]
    : [];
  if (notifyIds.length === 0 && !input.diagnosticsTimedOut) {
    return { inconclusive: false };
  }
  const serverIds = [...new Set([...notifyIds, ...waitIds])];
  const reason: TouchInconclusiveReason =
    notifyIds.length > 0 && input.diagnosticsTimedOut
      ? "mixed"
      : notifyIds.length > 0
        ? "notify-write"
        : "diagnostics-wait";
  return {
    inconclusive: true,
    ...(serverIds.length > 0 && { inconclusiveServerIds: serverIds }),
    inconclusiveReason: reason,
  };
}

export function touchCoverageGap(result: TouchFileResult | undefined): readonly string[] {
  return result?.unconfirmedServerIds ?? [];
}

export function touchCompletedConfirmationPolicy(result: TouchFileResult | undefined): boolean {
  return result?.confirmation !== undefined;
}

export type AuxiliaryWaitOutcome = "answered" | "silent" | "cut_off" | "deferred";

export interface AuxiliaryWaitEvidence {
  serverId: string;
  outcome: AuxiliaryWaitOutcome;
  publishedThisContent?: boolean;
}

export function auxiliaryCoverageGap(evidence: readonly AuxiliaryWaitEvidence[]): string[] {
  return evidence
    .filter((aux) => aux.outcome !== "answered" && aux.publishedThisContent !== true)
    .map((aux) => aux.serverId);
}

export function hashDiagnosticContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function composeBoundToCurrentDisk(
  values: readonly BoundToCurrentDisk[],
): BoundToCurrentDisk {
  if (values.some((v) => v === false)) return false;
  if (values.every((value) => value === "unknown")) {
    return "unknown";
  }
  return true;
}

export function bindingStateLabel(value: BoundToCurrentDisk): "bound" | "mismatch" | "unknown" {
  if (value === true) return "bound";
  if (value === false) return "mismatch";
  return "unknown";
}

export interface DiskBindingCache {
  boundToCurrentDisk(filePath: string, stored: StoredDiagnosticBinding): BoundToCurrentDisk;
}

const DISK_BINDING_MEMO_MAX = 4096;

export function createDiskBindingCache(): DiskBindingCache {
  const diskHashByPath = new PathKeyedMap<{ mtimeMs: number; hash: string }>(
    normalizeEphemeralMapKey,
  );
  return {
    boundToCurrentDisk(filePath, stored) {
      if (stored.contentHash === undefined) return "unknown";
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        return "unknown";
      }
      let cached = diskHashByPath.get(filePath);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        let diskHash: string;
        try {
          diskHash = hashDiagnosticContent(fs.readFileSync(filePath, "utf-8"));
        } catch {
          return "unknown";
        }
        cached = { mtimeMs, hash: diskHash };
        if (diskHashByPath.size >= DISK_BINDING_MEMO_MAX) {
          diskHashByPath.clear();
        }
        diskHashByPath.set(filePath, cached);
      }
      return cached.hash === stored.contentHash;
    },
  };
}
