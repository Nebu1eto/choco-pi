import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsMdAutoload } from "./src/subdir.ts";

/**
 * choco-pi extension: recursive subdirectory AGENTS.md context injection.
 * See README.md for behavior and VENDORED.md for provenance.
 */
export default function piChocoAgentsMd(pi: ExtensionAPI): void {
	registerAgentsMdAutoload(pi);
}
