import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type CodexConversionConfig,
  normalizeProviderList,
} from "../../adapter/activation/config.ts";
import { editorCommand } from "./config-editor.ts";
import { type ConfigSetting, setting, TextSettingSubmenu } from "./config-items-shared.ts";

export function buildAdapterSettings(config: CodexConversionConfig, theme: Theme): ConfigSetting[] {
  return [
    setting(
      {
        id: "additionalProviders",
        label: "Additional providers",
        currentValue: config.scope.additionalProviders.join(", "),
        submenu: (currentValue, done) =>
          new TextSettingSubmenu(
            "Additional providers",
            "Comma-separated provider ids that should use the adapter.",
            currentValue,
            (value) => done(normalizeCodexProviderText(value)),
            () => done(),
            theme,
          ),
      },
      (value, current) => ({
        ...current,
        scope: {
          ...current.scope,
          additionalProviders: normalizeProviderList(value.split(",")),
        },
      }),
    ),
    {
      item: {
        id: "editConfig",
        label: "Edit config",
        currentValue: editorCommand() ? "Opens in default editor (please /reload)" : "Set $EDITOR",
        values: editorCommand() ? ["Open"] : ["Unavailable"],
      },
      action: "edit-config",
    },
  ];
}

function normalizeCodexProviderText(value: string): string {
  return normalizeProviderList(value.split(",")).join(", ");
}
