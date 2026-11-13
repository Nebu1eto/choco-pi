import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SYNTHETIC_EXTENSIONS_REGISTER_EVENT,
  SYNTHETIC_EXTENSIONS_REQUEST_EVENT,
} from "../../src/config-events.ts";
import { ensureSyntheticConfig } from "../../src/config-state.ts";
import { registerQuotasCommand } from "./command.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = await ensureSyntheticConfig();

  if (config.quotasCommand) {
    registerQuotasCommand(pi);
  }

  pi.events.on(SYNTHETIC_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, {
      feature: "quotasCommand",
    });
  });
}
