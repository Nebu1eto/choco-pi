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
 * No multiplexer currently does. tmux and screen strip the sequences outright.
 * Zellij 0.45 intercepts the Kitty graphics protocol and re-implements it
 * against its own grid, which drops the placement semantics pi's alt-screen
 * renderer depends on: it re-places already-uploaded images by id every frame
 * (`a=d,d=a` followed by `a=p,i=<id>`) and crops them with `y`/`h`/`r`. A
 * measured Zellij 0.45 pane also advances the cursor zero rows for `r=2`,
 * `r=6` and `r=12` alike, so it reserves no grid space for the image.
 */
export function carriesImageProtocol(
  multiplexer: Multiplexer | null,
  protocol: ImageProtocol,
): boolean {
  if (protocol === null) return true;
  return multiplexer === null;
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
): ImageProtocol {
  const preference = readImageProtocolPreference(env[IMAGE_PROTOCOL_ENV]);
  if (preference.kind === "force") return preference.protocol;
  const multiplexer = detectMultiplexer(env);
  return carriesImageProtocol(multiplexer, detected) ? detected : null;
}

/**
 * Capabilities to install, or `undefined` when detection already agrees.
 * Only `images` is adjusted: Zellij forwards OSC 8 by default, so the text
 * fallback keeps its clickable `file://` link.
 */
export function applyMultiplexerImagePolicy(
  capabilities: TerminalCapabilities,
  env: ImageEnvironment,
): TerminalCapabilities | undefined {
  const images = resolveImageProtocol(capabilities.images, env);
  if (images === capabilities.images) return undefined;
  return { ...capabilities, images };
}
