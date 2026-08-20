/**
 * @aliou/pi-utils-settings
 *
 * Shared settings infrastructure for pi extensions:
 * - ConfigLoader: load/save/merge JSON configs from global + project paths
 * - registerSettingsCommand: create a settings command with Local/Global tabs
 * - Wizard: multi-step wizard component with tabbed navigation and borders
 * - SectionedSettings: sectioned settings list component
 * - SettingsDetailEditor: focused second-level settings editor
 * - ArrayEditor: string array editor submenu component
 * - Helpers: nested value access
 * - getSettingsTheme: combined settings-list + full Theme helper
 */

export {
  ArrayEditor,
  type ArrayEditorOptions,
} from "./components/array-editor";
export {
  FuzzyMultiSelector,
  type FuzzyMultiSelectorItem,
  type FuzzyMultiSelectorOptions,
  type FuzzyMultiSelectorSubOption,
} from "./components/fuzzy-multi-selector";
export {
  FuzzySelector,
  type FuzzySelectorOptions,
} from "./components/fuzzy-selector";
export {
  PathArrayEditor,
  type PathArrayEditorOptions,
} from "./components/path-array-editor";

export {
  SectionedSettings,
  type SectionedSettingsOptions,
  type SettingsSection,
} from "./components/sectioned-settings";
export {
  type SettingsDetailActionField,
  type SettingsDetailBooleanField,
  SettingsDetailEditor,
  type SettingsDetailEditorOptions,
  type SettingsDetailEnumField,
  type SettingsDetailField,
  type SettingsDetailSubmenuField,
  type SettingsDetailTextField,
} from "./components/settings-detail-editor";
export {
  Wizard,
  type WizardOptions,
  type WizardStep,
  type WizardStepContext,
} from "./components/wizard";
export {
  ConfigLoader,
  type ConfigStore,
  type Migration,
  type Scope,
} from "./config-loader";
export { getNestedValue, setNestedValue } from "./helpers";
export { buildSchemaUrl } from "./schema";
export {
  type ExtraSettingsTab,
  type ExtraSettingsTabContext,
  registerSettingsCommand,
  type SettingsCommandOptions,
} from "./settings-command";
export { getSettingsTheme, type SettingsTheme } from "./theme";
