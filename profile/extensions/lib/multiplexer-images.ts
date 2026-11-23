import type { ImageProtocol, TerminalCapabilities } from "@earendil-works/pi-tui";

export type ImageEnvironment = {
  readonly CHOCO_PI_IMAGE_PROTOCOL?: string;
  readonly ZELLIJ?: string;
  readonly ZELLIJ_SESSION_NAME?: string;
  readonly TMUX?: string;
  readonly TERM?: string;
};

export type Multiplexer = "zellij" | "tmux" | "screen";

export type ZellijVersion = readonly [number, number, number] | null;

export const ZELLIJ_KITTY_MIN_VERSION: readonly [number, number, number] = [0, 45, 0];

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

export const IMAGE_PROTOCOL_ENV = "CHOCO_PI_IMAGE_PROTOCOL";

export function detectMultiplexer(env: ImageEnvironment): Multiplexer | null {
  if (env.ZELLIJ !== undefined || env.ZELLIJ_SESSION_NAME !== undefined) return "zellij";
  const term = env.TERM?.toLowerCase() ?? "";
  if (env.TMUX !== undefined || term.startsWith("tmux")) return "tmux";
  if (term.startsWith("screen")) return "screen";
  return null;
}

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

export function readImageProtocolPreference(raw: string | undefined): ImageProtocolPreference {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "kitty") return { kind: "force", protocol: "kitty" };
  if (value === "iterm2") return { kind: "force", protocol: "iterm2" };
  if (value === "none" || value === "off" || value === "0" || value === "false") {
    return { kind: "force", protocol: null };
  }
  return { kind: "auto" };
}

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

export function applyMultiplexerImagePolicy(
  capabilities: TerminalCapabilities,
  env: ImageEnvironment,
  zellijVersion: ZellijVersion = null,
): TerminalCapabilities | undefined {
  const images = resolveImageProtocol(capabilities.images, env, zellijVersion);
  if (images === capabilities.images) return undefined;
  return { ...capabilities, images };
}
