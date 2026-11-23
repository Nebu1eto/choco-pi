import type { Api, Model } from "@earendil-works/pi-ai";

import { xaiGateAdmitsModel } from "../xai/capability.ts";
import type { OwnerSpec } from "./owner-spec.ts";
import type { HostRuntime } from "./runtime.ts";

export type NativeLaneSwitches = Pick<
  OwnerSpec,
  "allowAnthropic" | "allowForeign" | "xaiServerSide"
>;

export function nativeLaneSwitches(
  rt: Pick<HostRuntime, "xaiMode" | "xaiGate">,
  model: Model<Api>,
): NativeLaneSwitches {
  return {
    allowAnthropic: true,
    allowForeign: true,
    xaiServerSide:
      rt.xaiMode === "server-side" &&
      model.api === "openai-responses" &&
      xaiGateAdmitsModel(rt.xaiGate, model),
  };
}
