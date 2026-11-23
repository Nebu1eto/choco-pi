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
