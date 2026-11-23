import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function enableOsc52ForRemoteViewers(env: Record<string, string | undefined>): boolean {
  if (env.PI_CLIPBOARD_OSC52 !== undefined) return false;
  const term = env.TERM?.toLowerCase() ?? "";
  const remoteCapable =
    env.TERM_PROGRAM === "rex" ||
    env.ZELLIJ !== undefined ||
    env.TMUX !== undefined ||
    env.STY !== undefined ||
    term.startsWith("tmux") ||
    term.startsWith("screen");
  if (!remoteCapable) return false;
  env.PI_CLIPBOARD_OSC52 = "1";
  return true;
}

enableOsc52ForRemoteViewers(process.env);

export default function clipboardOsc52(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    enableOsc52ForRemoteViewers(process.env);
  });
}
