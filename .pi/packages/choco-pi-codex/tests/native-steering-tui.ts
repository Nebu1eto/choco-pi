/** Opt-in dedicated interactive Pi process. Run inside a disposable PTY/tmux pane. */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createNativeHost } from "./native-host-support.ts";

if (process.env.CHOCO_PI_NATIVE_LIVE !== "1") throw new Error("Requires CHOCO_PI_NATIVE_LIVE=1");
const host = await createNativeHost({
  watchdog: false,
  enabled: !process.argv.includes("--off"),
  transformSteer: process.argv.includes("--fallback"),
});
try {
  const mode = new InteractiveMode(host.runtime, { tuiMode: "fullscreen" });
  await mode.run();
} finally {
  await host.dispose();
}
