import { execFileSync } from "node:child_process";
import {
  applyMultiplexerImagePolicy,
  detectMultiplexer,
  parseZellijVersion,
} from "./lib/multiplexer-images.ts";
import type { ImageEnvironment, ZellijVersion } from "./lib/multiplexer-images.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

/**
 * Align pi-tui's cached terminal capabilities with what a multiplexer can
 * actually carry.
 *
 * pi-tui detects inline image support from `TERM`/`TERM_PROGRAM` alone. Zellij
 * passes both through. Zellij 0.45+ re-implements the Kitty graphics protocol
 * with the placement semantics pi's renderer needs, so Kitty stays enabled
 * there; older Zellij, tmux, and screen degrade to the text fallback rather
 * than emitting escapes that arrive mangled.
 *
 * Set `CHOCO_PI_IMAGE_PROTOCOL` to `kitty`, `iterm2` or `none` to override.
 */
let cachedZellijVersion: ZellijVersion | undefined;

/** Read `zellij --version` once; the binary that hosts this pane answers. */
function zellijClientVersion(env: ImageEnvironment): ZellijVersion {
  if (cachedZellijVersion !== undefined) return cachedZellijVersion;
  if (detectMultiplexer(env) !== "zellij") {
    cachedZellijVersion = null;
    return cachedZellijVersion;
  }
  try {
    const raw = execFileSync("zellij", ["--version"], { encoding: "utf8", timeout: 1500 });
    cachedZellijVersion = parseZellijVersion(raw);
  } catch {
    cachedZellijVersion = null;
  }
  return cachedZellijVersion;
}

export function installMultiplexerImagePolicy(env: ImageEnvironment): boolean {
  const capabilities = applyMultiplexerImagePolicy(
    getCapabilities(),
    env,
    zellijClientVersion(env),
  );
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
