import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, type SettingItem } from "@earendil-works/pi-tui";
import { modelPickerSubmenu } from "../../choco-pi-ui/extensions/zentui/model-picker.ts";
import {
  isModelInScope,
  readEnabledModels,
  resolveEnabledModels,
} from "../../choco-pi-subagents/src/enabled-models.ts";
import {
  DEFAULT_SETTINGS,
  EFFORTS,
  type AdvisorSettings,
  writeGlobalAdvisorSettings,
} from "./settings.ts";

export const ADVISOR_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.advisor-preferences-provider",
);
export type AdvisorSettingsChange = { kind: "update" } | { kind: "rebuild" };
export interface AdvisorPreferencesSection {
  id: "advisor";
  label: "Advisor Agent";
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => AdvisorSettingsChange;
}
export interface AdvisorPreferencesProvider {
  buildSections: (ctx: ExtensionContext) => AdvisorPreferencesSection[];
}
export interface AdvisorPreferencesOptions {
  agentDir: string;
  settings: AdvisorSettings;
  models: string[];
  ctx?: { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "notify"> };
  isActive?: () => boolean;
}
interface SettingDefinition {
  id: string;
  label: string;
  description: string;
  currentValue: (settings: AdvisorSettings) => string;
  values: () => string[] | undefined;
  apply: (value: string) => Partial<AdvisorSettings> | undefined;
}

interface AdvisorModelChoice {
  provider: string;
  id: string;
}

export function listAdvisorModelChoices(
  all: readonly AdvisorModelChoice[],
  current: string,
  allowed?: Set<string>,
): string[] {
  const candidates = [...all]
    .sort((left, right) =>
      left.provider === right.provider
        ? left.id.localeCompare(right.id)
        : left.provider.localeCompare(right.provider),
    )
    .filter((model) => allowed === undefined || isModelInScope(model, allowed))
    .map((model) => `${model.provider}/${model.id}`);
  return [...new Set([current, ...candidates])];
}

const definitions: SettingDefinition[] = [
  {
    id: "enabled",
    label: "Advisor enabled",
    description: "Allow inline advisor consults.",
    currentValue: (settings) => (settings.enabled ? "on" : "off"),
    values: () => ["off", "on"],
    apply: (value) => (value === "on" || value === "off" ? { enabled: value === "on" } : undefined),
  },
  {
    id: "model",
    label: "Advisor model",
    description: "Provider/model used for fresh advisor leaves.",
    currentValue: (settings) => settings.model,
    values: () => undefined,
    apply: (value) => (value.trim() ? { model: value.trim() } : undefined),
  },
  {
    id: "effort",
    label: "Advisor effort",
    description: "Reasoning effort requested for the advisor.",
    currentValue: (settings) => settings.effort,
    values: () => [...EFFORTS],
    apply: (value) => {
      const effort = EFFORTS.find((candidate) => candidate === value);
      return effort === undefined ? undefined : { effort };
    },
  },
  {
    id: "maxUses",
    label: "Advisor per-turn cap",
    description: "Enter a positive integer; 0 or empty means unlimited.",
    currentValue: (settings) => String(settings.maxUses ?? 0),
    values: () => undefined,
    apply: (value) => {
      if (!/^\d*$/.test(value.trim())) return undefined;
      const number = Number(value.trim());
      return Number.isSafeInteger(number) && number >= 0
        ? { maxUses: number === 0 ? undefined : number }
        : undefined;
    },
  },
];

let writeQueue: Promise<void> = Promise.resolve();
let writeError: string | undefined;

export function surfaceAdvisorWriteError(
  ctx: Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
): void {
  if (!writeError || !ctx.hasUI) return;
  const message = writeError;
  writeError = undefined;
  ctx.ui.notify(message, "warning");
}

export async function waitForAdvisorWrites(): Promise<void> {
  await writeQueue;
}

export { waitForAdvisorWrites as drainWriteQueueForTests };

export function buildAdvisorPreferencesSection(
  options: AdvisorPreferencesOptions,
): AdvisorPreferencesSection {
  let settings = { ...options.settings };
  const agentDir = options.agentDir;
  return {
    id: "advisor",
    label: "Advisor Agent",
    buildItems: () =>
      definitions.map((definition) => {
        const item: SettingItem = {
          id: `advisor.${definition.id}`,
          label: definition.label,
          description: definition.description,
          currentValue: definition.currentValue(settings),
          values: definition.values(),
        };
        if (definition.id === "model") {
          item.submenu = (current, done) =>
            modelPickerSubmenu({
              choices: [settings.model, ...options.models].map((value) => {
                const separator = value.indexOf("/");
                return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
              }),
              // Let the host's change handler retain ownership of the serialized write queue.
              onPick: done,
            })(current, (value) => {
              if (value === undefined) done();
            });
        }
        if (definition.id === "maxUses") {
          item.submenu = (current, done) => {
            const input = new Input({ prompt: "Max uses (0 = unlimited): " });
            input.setValue(current);
            input.onSubmit = (value) => {
              if (definition.apply(value)) done(value);
            };
            input.onEscape = () => done();
            return input;
          };
        }
        return item;
      }),
    handleChange: (id, newValue) => {
      const definition = definitions.find((candidate) => `advisor.${candidate.id}` === id);
      const partial = definition?.apply(newValue);
      if (!partial) {
        if (options.ctx?.hasUI) options.ctx.ui.notify("Invalid advisor setting", "warning");
        return { kind: "rebuild" };
      }
      const previous = { ...settings };
      settings = { ...settings, ...partial };
      Object.assign(options.settings, partial);
      writeQueue = writeQueue
        .then(() => writeGlobalAdvisorSettings(agentDir, partial))
        .catch((error) => {
          writeError = `Could not save advisor settings: ${error instanceof Error ? error.message : String(error)}`;
          if (partial.enabled !== undefined && settings.enabled === partial.enabled)
            settings.enabled = options.settings.enabled = previous.enabled;
          if (partial.model !== undefined && settings.model === partial.model)
            settings.model = options.settings.model = previous.model;
          if (partial.effort !== undefined && settings.effort === partial.effort)
            settings.effort = options.settings.effort = previous.effort;
          if ("maxUses" in partial && settings.maxUses === partial.maxUses)
            settings.maxUses = options.settings.maxUses = previous.maxUses;
          if ((!options.isActive || options.isActive()) && options.ctx?.hasUI)
            surfaceAdvisorWriteError(options.ctx);
        });
      return { kind: "rebuild" };
    },
  };
}

export function registerAdvisorPreferencesProvider(
  agentDir: string,
  settingsByCwd: Map<string, AdvisorSettings>,
  isActive: () => boolean,
): (() => void) | undefined {
  const registered = () =>
    Object.getOwnPropertyDescriptor(globalThis, ADVISOR_PREFERENCES_PROVIDER_SYMBOL)?.value;
  if (registered() !== undefined) return undefined;
  const provider: AdvisorPreferencesProvider = {
    buildSections: (ctx) => {
      if (!isActive()) return [];
      surfaceAdvisorWriteError(ctx);
      const settings = settingsByCwd.get(ctx.cwd) ?? { ...DEFAULT_SETTINGS };
      settingsByCwd.set(ctx.cwd, settings);
      const patterns = readEnabledModels(ctx.cwd);
      const allowed = resolveEnabledModels(patterns, ctx.modelRegistry, ctx.cwd);
      const models = listAdvisorModelChoices(ctx.modelRegistry.getAll(), settings.model, allowed);
      return [buildAdvisorPreferencesSection({ agentDir, settings, models, ctx, isActive })];
    },
  };
  Object.defineProperty(globalThis, ADVISOR_PREFERENCES_PROVIDER_SYMBOL, {
    configurable: true,
    writable: true,
    value: provider,
  });
  return () => {
    if (registered() === provider)
      Reflect.deleteProperty(globalThis, ADVISOR_PREFERENCES_PROVIDER_SYMBOL);
  };
}
