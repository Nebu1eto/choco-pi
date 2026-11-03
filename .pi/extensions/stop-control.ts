import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createStopController,
  STOP_ENTRY_TYPE,
  type StopCommandIo,
  type StopController,
} from "./lib/stop-control.ts";

function commandIo(ctx: ExtensionCommandContext): StopCommandIo {
  return {
    notify: (message, level) => ctx.ui.notify(message, level),
    isIdle: () => ctx.isIdle(),
    abort: () => ctx.abort(),
  };
}

/** /stop and /resume-work: one session-scoped epoch latch honoured by every participant. */
export default function stopControl(pi: ExtensionAPI): void {
  const controller: StopController = createStopController({
    events: pi.events,
    appendState: (state) => pi.appendEntry(STOP_ENTRY_TYPE, state),
    sendNotice: (content) =>
      pi.sendMessage(
        { customType: STOP_ENTRY_TYPE, content, display: true },
        { triggerTurn: false },
      ),
  });

  pi.on("session_start", (_event, ctx) => {
    controller.start(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch());
  });
  pi.on("session_shutdown", (event) => {
    controller.shutdown(event.reason);
  });
  pi.on("tool_call", (event) => controller.fence(event.toolName));
  pi.registerCommand("stop", {
    description:
      "Stop all agents, workflows, shells and automatic turns; /stop agent <ref> stops one agent",
    handler: async (args, ctx) => controller.stop(args, commandIo(ctx)),
  });
  pi.registerCommand("resume-work", {
    description: "Reopen work admission after /stop (stopped work stays stopped)",
    handler: async (_args, ctx) => controller.resume(commandIo(ctx)),
  });
}
