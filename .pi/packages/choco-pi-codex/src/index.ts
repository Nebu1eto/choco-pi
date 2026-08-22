// choco-pi-codex: choco-pi fork of @howaboua/pi-codex-conversion.
// Registers the kept feature set only: the Codex adapter (openai-codex /
// openai-responses providers with server-side compaction), apply_patch,
// web_run, imagegen, view_image, Code Mode, and the OpenAI websocket options.
// Voice, Notebook Mode, and the background-shell widget were removed.
import { createRequire } from "node:module";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  ApplyPatchToolDetails,
  ApplyPatchToolOptions,
} from "./tools/apply-patch/tool.ts";
import type { BoundaryValue } from "./tools/boundary.ts";
import { registerCodexConversion } from "./extension/register.ts";

interface ActivationModule {
  mergeAdapterTools(
    activeTools: string[],
    adapterTools: string[],
    adapterOwnedTools?: string[],
  ): string[];
  restoreTools(
    previousTools: string[],
    activeTools: string[],
    adapterOwnedTools?: string[],
  ): string[];
  stripAdapterTools(toolNames: string[], adapterOwnedTools?: string[]): string[];
}

interface ApplyPatchModule {
  createApplyPatchTool(options?: ApplyPatchToolOptions): ToolDefinition<TSchema, ApplyPatchToolDetails>;
  isApplyPatchToolDetails(details: BoundaryValue): details is ApplyPatchToolDetails;
  registerApplyPatchResultEvent(pi: ExtensionAPI): void;
}

interface SkillsModule {
  getCodexSkillPaths(cwd: string, home?: string): string[];
}

const require = createRequire(import.meta.url);
let activationModule: ActivationModule | undefined;
let applyPatchModule: ApplyPatchModule | undefined;
let skillsModule: SkillsModule | undefined;
const getActivationModule = () => {
  // SAFETY: This fixed local module exports the ActivationModule functions declared above.
  return (activationModule ??= require("./adapter/activation/tool-list.ts") as ActivationModule);
};
const getApplyPatchModule = () => {
  // SAFETY: This fixed local module exports the ApplyPatchModule functions declared above.
  return (applyPatchModule ??= require("./tools/apply-patch/tool.ts") as ApplyPatchModule);
};
const getSkillsModule = () => {
  // SAFETY: This fixed local module exports getCodexSkillPaths with the declared signature.
  return (skillsModule ??= require("./adapter/prompt/skills.ts") as SkillsModule);
};

export default async function codexConversion(pi: ExtensionAPI): Promise<void> {
  await registerCodexConversion(pi);
}

export type {
  ApplyPatchPartialFailureDetails,
  ApplyPatchRenderCall,
  ApplyPatchRenderResult,
  ApplyPatchSuccessDetails,
  ApplyPatchToolDetails,
  ApplyPatchToolOptions,
  ExecutePatchResult,
} from "./tools/apply-patch/tool.ts";

export const createApplyPatchTool: ApplyPatchModule["createApplyPatchTool"] = (options) =>
  getApplyPatchModule().createApplyPatchTool(options);
export const isApplyPatchToolDetails: ApplyPatchModule["isApplyPatchToolDetails"] = (details) =>
  getApplyPatchModule().isApplyPatchToolDetails(details);
export const registerApplyPatchResultEvent: ApplyPatchModule["registerApplyPatchResultEvent"] =
  (pi) => getApplyPatchModule().registerApplyPatchResultEvent(pi);
export const getCodexSkillPaths: SkillsModule["getCodexSkillPaths"] = (cwd, home) =>
  getSkillsModule().getCodexSkillPaths(cwd, home);
export const mergeAdapterTools: ActivationModule["mergeAdapterTools"] = (
  activeTools,
  adapterTools,
  adapterOwnedTools,
) => getActivationModule().mergeAdapterTools(activeTools, adapterTools, adapterOwnedTools);
export const restoreTools: ActivationModule["restoreTools"] = (
  previousTools,
  activeTools,
  adapterOwnedTools,
) => getActivationModule().restoreTools(previousTools, activeTools, adapterOwnedTools);
export const stripAdapterTools: ActivationModule["stripAdapterTools"] = (
  toolNames,
  adapterOwnedTools,
) => getActivationModule().stripAdapterTools(toolNames, adapterOwnedTools);
