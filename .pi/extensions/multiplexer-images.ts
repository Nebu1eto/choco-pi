import { applyMultiplexerImagePolicy } from "./lib/multiplexer-images.ts";
import type { ImageEnvironment } from "./lib/multiplexer-images.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

/**
 * Align pi-tui's cached terminal capabilities with what a multiplexer can
 * actually carry.
 *
 * pi-tui detects inline image support from `TERM`/`TERM_PROGRAM` alone. Zellij
 * passes both through, so Ghostty inside Zellij selects the Kitty graphics
 * protocol even though Zellij intercepts those sequences and re-renders them
 * itself. Degrading to the text fallback is better than emitting escapes that
 * arrive mangled.
 *
 * Set `CHOCO_PI_IMAGE_PROTOCOL` to `kitty`, `iterm2` or `none` to override.
 */
export function installMultiplexerImagePolicy(env: ImageEnvironment): boolean {
  const capabilities = applyMultiplexerImagePolicy(getCapabilities(), env);
  if (!capabilities) return false;
  setCapabilities(capabilities);
  return true;
}

// Applied at module load so the override lands before the TUI reads
// `getCapabilities()` in `beforeTerminalStart()`.
installMultiplexerImagePolicy(process.env);

export default function multiplexerImages(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    installMultiplexerImagePolicy(process.env);
  });
}
