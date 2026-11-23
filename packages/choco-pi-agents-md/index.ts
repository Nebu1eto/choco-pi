import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsMdAutoload } from "./src/subdir.ts";

export default function piChocoAgentsMd(pi: ExtensionAPI): void {
  registerAgentsMdAutoload(pi);
}
