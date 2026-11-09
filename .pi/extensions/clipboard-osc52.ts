import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Let copies reach the clipboard of a remote viewer.
 *
 * Pi writes the local clipboard and adds OSC 52 only when it sees SSH or mosh
 * variables. A Rex pane or a multiplexer attached from another machine sets
 * neither, so the copy lands on this host and the viewer's clipboard stays
 * unchanged. Pi reads `PI_CLIPBOARD_OSC52` on every copy; setting it here
 * makes it emit OSC 52 in addition to the local write. An explicit value,
 * including `0`, is left untouched.
 */
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

// Applied at module load so the first copy already sees the variable.
enableOsc52ForRemoteViewers(process.env);

export default function clipboardOsc52(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    enableOsc52ForRemoteViewers(process.env);
  });
}
