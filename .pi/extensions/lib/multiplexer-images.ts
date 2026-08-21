import type { ImageProtocol, TerminalCapabilities } from "@earendil-works/pi-tui";

/**
 * The environment slice that decides which inline image protocol is safe.
 * `process.env` satisfies this shape directly.
 */
export type ImageEnvironment = {
  readonly CHOCO_PI_IMAGE_PROTOCOL?: string;
  readonly ZELLIJ?: string;
  readonly ZELLIJ_SESSION_NAME?: string;
  readonly TMUX?: string;
  readonly TERM?: string;
};

export type Multiplexer = "zellij" | "tmux" | "screen";

/** Parsed `zellij --version` output, e.g. `[0, 45, 0]`. `null` when unknown. */
export type ZellijVersion = readonly [number, number, number] | null;

/** The first Zellij release whose Kitty graphics implementation carries pi's placement semantics. */
export const ZELLIJ_KITTY_MIN_VERSION: readonly [number, number, number] = [0, 45, 0];

/** Parse `zellij --version` stdout ("zellij 0.45.0") into a comparable triple. */
export function parseZellijVersion(raw: string | undefined): ZellijVersion {
  const match = raw?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: ZellijVersion, minimum: readonly [number, number, number]): boolean {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

export type ImageProtocolPreference =
  | { readonly kind: "auto" }
  | { readonly kind: "force"; readonly protocol: ImageProtocol };

/** Environment variable that overrides the automatic multiplexer policy. */
export const IMAGE_PROTOCOL_ENV = "CHOCO_PI_IMAGE_PROTOCOL";

/**
 * Detect a terminal multiplexer between the agent and the outer terminal.
 *
 * Zellij passes `TERM` and `TERM_PROGRAM` through untouched, so terminal
 * identity alone cannot reveal it; `ZELLIJ`/`ZELLIJ_SESSION_NAME` are the only
 * reliable signals.
 */
export function detectMultiplexer(env: ImageEnvironment): Multiplexer | null {
  if (env.ZELLIJ !== undefined || env.ZELLIJ_SESSION_NAME !== undefined) return "zellij";
  const term = env.TERM?.toLowerCase() ?? "";
  if (env.TMUX !== undefined || term.startsWith("tmux")) return "tmux";
  if (term.startsWith("screen")) return "screen";
  return null;
}

/**
 * Whether a multiplexer carries an inline image protocol end to end.
 *
 * tmux and screen strip the sequences outright. Zellij 0.45 intercepts the
 * Kitty graphics protocol and re-implements it against its own grid; a
 * harness that impersonated the outer terminal (pixel-sized pty answering
 * `CSI 16 t`) captured Zellij forwarding every operation pi's alt-screen
 * renderer emits: `a=T` arrives as an RGBA retransmit plus `a=p ... C=1` at
 * the correct cell, `a=d,d=a` arrives as targeted deletes, `a=p,i=<id>`
 * re-places without retransmitting, and `y`/`h`/`r` crops arrive re-encoded
 * with the cropped pixel rows. The cursor never advances after a placement,
 * which pi's absolute-positioning alt-screen renderer does not rely on.
 * Older Zellij releases swallow the sequences, so the policy is gated on the
 * client version. Zellij does not implement the iTerm2 protocol.
 */
export function carriesImageProtocol(
  multiplexer: Multiplexer | null,
  protocol: ImageProtocol,
  zellijVersion: ZellijVersion = null,
): boolean {
  if (protocol === null) return true;
  if (multiplexer === null) return true;
  return (
    multiplexer === "zellij" &&
    protocol === "kitty" &&
    atLeast(zellijVersion, ZELLIJ_KITTY_MIN_VERSION)
  );
}

/** Parse the {@link IMAGE_PROTOCOL_ENV} escape hatch. Unknown values mean `auto`. */
export function readImageProtocolPreference(raw: string | undefined): ImageProtocolPreference {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "kitty") return { kind: "force", protocol: "kitty" };
  if (value === "iterm2") return { kind: "force", protocol: "iterm2" };
  if (value === "none" || value === "off" || value === "0" || value === "false") {
    return { kind: "force", protocol: null };
  }
  return { kind: "auto" };
}

/** The inline image protocol that should actually be used in this environment. */
export function resolveImageProtocol(
  detected: ImageProtocol,
  env: ImageEnvironment,
  zellijVersion: ZellijVersion = null,
): ImageProtocol {
  const preference = readImageProtocolPreference(env[IMAGE_PROTOCOL_ENV]);
  if (preference.kind === "force") return preference.protocol;
  const multiplexer = detectMultiplexer(env);
  return carriesImageProtocol(multiplexer, detected, zellijVersion) ? detected : null;
}

/**
 * Capabilities to install, or `undefined` when detection already agrees.
 * Only `images` is adjusted: Zellij forwards OSC 8 by default, so the text
 * fallback keeps its clickable `file://` link.
 */
export function applyMultiplexerImagePolicy(
  capabilities: TerminalCapabilities,
  env: ImageEnvironment,
  zellijVersion: ZellijVersion = null,
): TerminalCapabilities | undefined {
  const images = resolveImageProtocol(capabilities.images, env, zellijVersion);
  if (images === capabilities.images) return undefined;
  return { ...capabilities, images };
}
