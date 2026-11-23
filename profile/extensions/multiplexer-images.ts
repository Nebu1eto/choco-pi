import { execFileSync } from "node:child_process";
import {
  applyMultiplexerImagePolicy,
  detectMultiplexer,
  parseZellijVersion,
} from "./lib/multiplexer-images.ts";
import type { ImageEnvironment, ZellijVersion } from "./lib/multiplexer-images.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectCapabilities, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

let cachedZellijVersion: ZellijVersion | undefined;

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
  const detected = detectCapabilities();
  const resolved = applyMultiplexerImagePolicy(detected, env, zellijClientVersion(env)) ?? detected;
  const current = getCapabilities();
  if (current.images === resolved.images) return false;
  setCapabilities({ ...current, images: resolved.images });
  return true;
}

installMultiplexerImagePolicy(process.env);

export default function multiplexerImages(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    installMultiplexerImagePolicy(process.env);
  });
}
