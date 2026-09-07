import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrototypeHost } from "./host.ts";
import { connectPrototype } from "./transport.ts";

const checkout = realpathSync(fileURLToPath(new URL("../../../../../", import.meta.url)));
const allowedCheckout =
  checkout.endsWith("/choco-pi-dev") ||
  (checkout.endsWith("/choco-pi") && process.argv.includes("--allow-main"));
if (realpathSync(process.cwd()) !== checkout || !allowedCheckout) {
  throw new Error("Run from choco-pi-dev, or explicitly allow choco-pi with --allow-main");
}
const mode = process.argv[2];
if (!process.argv.includes("--live") || (mode !== "steering" && mode !== "async")) {
  throw new Error(
    "Usage: node .pi/packages/choco-pi-codex/src/prototype/run.ts steering|async --live [--allow-main]",
  );
}
let trace: string[] = [];
let steer: Promise<void> | undefined;
let text = "";
let hostToolExecutions = 0;
const host = await createPrototypeHost({
  mode,
  connect: connectPrototype,
  onCreated() {
    if (mode === "steering" && !steer) {
      steer = host.session.prompt("Change direction: reply with exactly STEERING_PROTOTYPE_OK.", {
        streamingBehavior: "steer",
      });
      void steer.catch(() => {});
    }
  },
  onFinished(turn) {
    trace = [...turn.trace];
  },
});
try {
  host.session.subscribe((event) => {
    if (event.type === "tool_execution_start") hostToolExecutions++;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  await host.session.prompt(
    mode === "steering"
      ? "Explain five approaches to sorting a list, including examples."
      : "Start prototype_lookup. While it runs, say INDEPENDENT_WORK_OK and list three city-trip essentials. When the result arrives, quote its exact marker and identify it as synthetic data.",
  );
  await steer;
  const last = host.session.messages.at(-1);
  const passed =
    last?.role === "assistant" &&
    last.stopReason === "stop" &&
    hostToolExecutions === 0 &&
    (mode === "steering"
      ? trace.includes("steering_successor_completed") && text.includes("STEERING_PROTOTYPE_OK")
      : trace.includes("async_continuation_completed") && trace.includes("text_before_result"));
  console.log(
    JSON.stringify(
      {
        mode,
        passed,
        trace,
        hostToolExecutions,
        error: last?.role === "assistant" ? last.errorMessage : "missing_assistant",
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await host.dispose();
}
