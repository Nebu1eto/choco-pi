import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SYNTHETIC_QUOTAS_READ_EVENT,
  SYNTHETIC_QUOTAS_REQUEST_EVENT,
  type SyntheticQuotasReadPayload,
  type SyntheticQuotasRequestPayload,
  type SyntheticQuotasSnapshotPayload,
} from "../../src/types/quotas";

export function requestQuotas(
  pi: ExtensionAPI,
  respond?: (snapshot: SyntheticQuotasSnapshotPayload | undefined) => void,
): void {
  pi.events.emit(SYNTHETIC_QUOTAS_REQUEST_EVENT, {
    respond,
  } satisfies SyntheticQuotasRequestPayload);
}

export function readQuotas(
  pi: ExtensionAPI,
  respond: (snapshot: SyntheticQuotasSnapshotPayload | undefined) => void,
): void {
  pi.events.emit(SYNTHETIC_QUOTAS_READ_EVENT, {
    respond,
  } satisfies SyntheticQuotasReadPayload);
}
