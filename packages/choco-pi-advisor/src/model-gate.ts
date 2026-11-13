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

export function chooseAlternateModel(
  session: ModelIdentity | undefined,
  candidates: ModelIdentity[],
  resolves: (model: ModelIdentity) => boolean,
): ModelIdentity | undefined {
  return candidates.find((candidate) => !isSameModel(session, candidate) && resolves(candidate));
}

export function alternateModelNotice(model: ModelIdentity): string {
  return `advisor model switched to ${model.provider}/${model.id} because the configured model equals the session model.`;
}

export function isSameModelDisabledMessage(text: string): boolean {
  return text.startsWith(SAME_MODEL_PREFIX) && text.endsWith(SAME_MODEL_SUFFIX);
}
