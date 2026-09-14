export interface ModelIdentity {
  provider: string;
  id: string;
}

const SAME_MODEL_PREFIX = "advisor is disabled for this session: the advisor model (";
const SAME_MODEL_SUFFIX =
  ") is the same as the session model; pick a different advisor model in /preferences";

export function isSameModel(session: ModelIdentity | undefined, advisor: ModelIdentity): boolean {
  return (
    session !== undefined &&
    session.provider.toLowerCase() === advisor.provider.toLowerCase() &&
    session.id.toLowerCase() === advisor.id.toLowerCase()
  );
}

export function sameModelDisabledMessage(model: ModelIdentity): string {
  return `${SAME_MODEL_PREFIX}${model.provider}/${model.id}${SAME_MODEL_SUFFIX}`;
}

export function isSameModelDisabledMessage(text: string): boolean {
  return text.startsWith(SAME_MODEL_PREFIX) && text.endsWith(SAME_MODEL_SUFFIX);
}
