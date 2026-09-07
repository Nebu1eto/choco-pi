import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  closeNativeSteering,
  steerNativeResponse,
} from "../providers/openai-codex/native-steering.ts";
import { clearAsyncCodeModeCalls } from "../providers/openai-codex/native-features.ts";

/** Side-band delivery only: returning normally lets Pi persist and queue the original input. */
export function registerNativeFeatures(pi: ExtensionAPI, isEnabled: () => boolean): void {
  let owner = "";
  pi.on("session_start", (_event, ctx) => {
    if (owner) closeNativeSteering(owner);
    owner = ctx.sessionManager.getSessionId();
  });
  pi.on("session_shutdown", () => {
    const closing = owner;
    owner = "";
    if (closing) closeNativeSteering(closing);
    if (closing) clearAsyncCodeModeCalls(closing);
  });
  pi.on("agent_end", () => {
    if (owner) {
      closeNativeSteering(owner);
      clearAsyncCodeModeCalls(owner);
    }
  });
  pi.on("input", (event, ctx) => {
    if (
      event.streamingBehavior !== "steer" ||
      event.images?.length ||
      ctx.hasPendingMessages() ||
      !isEnabled() ||
      ctx.model?.id !== "gpt-6-astra" ||
      ctx.model.provider !== "openai-codex"
    )
      return;
    const currentOwner = ctx.sessionManager.getSessionId();
    if (currentOwner !== owner) return;
    steerNativeResponse(currentOwner, event.text);
  });
}
