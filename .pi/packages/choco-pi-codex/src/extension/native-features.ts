import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  closeNativeSteering,
  steerNativeResponse,
} from "../providers/openai-codex/native-steering.ts";
import { clearAsyncCodeModeCalls } from "../providers/openai-codex/native-features.ts";
import { SteeringStatusWidget } from "../ui/steering-status.ts";

/** Side-band delivery only: returning normally lets Pi persist and queue the original input. */
export function registerNativeFeatures(
  pi: ExtensionAPI,
  isEnabled: () => boolean,
  showDeliveryStatus: () => boolean = () => false,
) {
  let owner = "";
  const widget = new SteeringStatusWidget();
  pi.on("session_start", (_event, ctx) => {
    widget.clear(ctx);
    if (owner) closeNativeSteering(owner);
    owner = ctx.sessionManager.getSessionId();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const closing = owner;
    owner = "";
    widget.clear(ctx);
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
    if (event.streamingBehavior !== "steer") {
      if (ctx.isIdle()) widget.clear(ctx);
      return;
    }
    const currentOwner = ctx.sessionManager.getSessionId();
    if (currentOwner !== owner) return;
    const observe = showDeliveryStatus() ? widget.add(event.text, ctx) : undefined;
    if (
      event.images?.length ||
      ctx.hasPendingMessages() ||
      !isEnabled() ||
      ctx.model?.id !== "gpt-6-astra" ||
      ctx.model.provider !== "openai-codex"
    )
      return;
    steerNativeResponse(currentOwner, event.text, observe);
  });
  return { clearDeliveryStatus: (ctx: ExtensionContext) => widget.clear(ctx) };
}
