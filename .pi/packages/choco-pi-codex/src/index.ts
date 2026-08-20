// choco-pi-codex: choco-pi fork of @howaboua/pi-codex-conversion.
// Registers the kept feature set only: the Codex adapter (openai-codex /
// openai-responses providers with server-side compaction), apply_patch,
// web_run, imagegen, view_image, Code Mode, and the OpenAI websocket options.
// Voice, Notebook Mode, and the background-shell widget were removed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  mergeAdapterTools,
  restoreTools,
  stripAdapterTools,
} from "./adapter/activation/activation.ts";
import { getCodexSkillPaths } from "./adapter/prompt/skills.ts";
import { registerCodexConversion } from "./extension/register.ts";

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
export {
  createApplyPatchTool,
  isApplyPatchToolDetails,
  registerApplyPatchResultEvent,
} from "./tools/apply-patch/tool.ts";
export { getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools };
