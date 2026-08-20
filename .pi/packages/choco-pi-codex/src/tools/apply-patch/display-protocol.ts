import type { BoundaryValue } from "../boundary.js";
import { isFunctionValue, isObjectValue } from "../boundary.js";
export const APPLY_PATCH_DISPLAY_PROTOCOL = "@howaboua/pi-codex-conversion/apply-patch-display/v1";
export const APPLY_PATCH_DISPLAY_REQUEST_CHANNEL = `${APPLY_PATCH_DISPLAY_PROTOCOL}/request`;
export const APPLY_PATCH_DISPLAY_AVAILABLE_CHANNEL = `${APPLY_PATCH_DISPLAY_PROTOCOL}/available`;

export interface ApplyPatchDisplayBroker {
  protocol: typeof APPLY_PATCH_DISPLAY_PROTOCOL;
  isActive(): boolean;
  register(customType: string): () => void;
}

export function isApplyPatchDisplayRequest(value: BoundaryValue): boolean {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "protocol" in value &&
    value.protocol === APPLY_PATCH_DISPLAY_PROTOCOL,
  );
}

export function isApplyPatchDisplayBroker(value: BoundaryValue): value is ApplyPatchDisplayBroker {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "protocol" in value &&
    value.protocol === APPLY_PATCH_DISPLAY_PROTOCOL &&
    "isActive" in value &&
    isFunctionValue(value.isActive) &&
    "register" in value &&
    isFunctionValue(value.register),
  );
}
