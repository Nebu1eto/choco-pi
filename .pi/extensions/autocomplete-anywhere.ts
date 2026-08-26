import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAutocompleteAnywhere } from "./lib/autocomplete-anywhere.ts";

/** Installs prompt autocomplete patches only for interactive terminal sessions. */
export default function autocompleteAnywhere(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") installAutocompleteAnywhere();
  });
}
