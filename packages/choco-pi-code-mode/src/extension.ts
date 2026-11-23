/**
 * choco-pi-code-mode Pi extension entry.
 *
 * Alone, it registers universal Code Mode for every provider
 * (`src/standalone.ts`). Composed with a provider that owns Code Mode
 * (choco-pi-codex, which loads first in the default profile and attaches its
 * OpenAI ports), it finds that owner through the host slot and registers
 * nothing, so every Code Mode and core tool is registered exactly once.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claimCodeModeHost, probeCodeModeHostOwner } from "./host-slot.ts";
import { registerStandaloneCodeMode } from "./standalone.ts";

export const CODE_MODE_PACKAGE_NAME = "choco-pi-code-mode";

export default async function codeModeExtension(pi: ExtensionAPI): Promise<void> {
  if (probeCodeModeHostOwner(pi)) return;
  const release = claimCodeModeHost(pi, { kind: "standalone", name: CODE_MODE_PACKAGE_NAME });
  try {
    await registerStandaloneCodeMode(pi);
  } catch (error) {
    release();
    throw error;
  }
}
