import { Type } from "typebox";
import { Check } from "typebox/value";

const ModelIdSchema = Type.String();

type ResponsesLiteModel = string | { id: string } | undefined;

export function supportsResponsesLiteModel(model: ResponsesLiteModel): boolean {
  const modelId = Check(ModelIdSchema, model) ? model : model?.id;
  if (!modelId) return false;
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  return /^(?:gpt-5\.6-(?:luna|terra|sol)|gpt-daybreak-(?:blue|red)-latest)$/.test(
    id.toLowerCase(),
  );
}
