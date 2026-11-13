import type { Api, Model } from "@earendil-works/pi-ai";

import { xaiGateAdmitsModel } from "../xai/capability.ts";
import type { OwnerSpec } from "./owner-spec.ts";
import type { HostRuntime } from "./runtime.ts";

/** The provider-native lane switches of one owner. */
export type NativeLaneSwitches = Pick<
  OwnerSpec,
  "allowAnthropic" | "allowForeign" | "xaiServerSide"
>;

/**
 * Provider-native lane switches for an owner serving `model`, shared by the
 * main session and every subagent child so both select the same backends for
 * the same model: Anthropic native and foreign (Codex) backends are admitted
 * (each still behind its own setting and capability check), and xAI
 * server-side owns an admitted `openai-responses` model while its mode is
 * selected.
 */
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
