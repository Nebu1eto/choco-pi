import { isStringValue, type BoundaryValue } from "../boundary.ts";

export interface CodeModeApplyPatchInput {
  input: string;
}

export function prepareCodeModeApplyPatchInput(input: BoundaryValue): CodeModeApplyPatchInput {
  if (!isStringValue(input)) {
    throw new Error(
      "Code mode apply_patch input error [invalid_arguments]: tools.apply_patch accepts one patch string, not an object. Call await tools.apply_patch(patch), where patch is the full *** Begin Patch / *** End Patch envelope.",
    );
  }
  return { input };
}
