import {
  alternateModelNotice,
  chooseAlternateModel,
  isSameModel,
  type ModelIdentity,
  sameModelDisabledMessage,
} from "./model-gate.ts";

export interface AdvisorModelRegistry<M extends ModelIdentity> {
  find(provider: string, id: string): M | undefined;
  getAvailable(): readonly ModelIdentity[];
}

export type AdvisorModelSelection<M extends ModelIdentity> =
  | { tag: "selected"; model: M; notice?: string }
  | { tag: "disabled"; message: string };

function sameIdentity(a: ModelIdentity, b: ModelIdentity): boolean {
  return isSameModel(a, b);
}

/**
 * Keep the configured advisor model unless it equals the session model; then use the first
 * Flagship primary that differs from the session and is registered and available.
 */
export async function selectAdvisorModel<M extends ModelIdentity>(
  selected: M,
  session: ModelIdentity | undefined,
  registry: AdvisorModelRegistry<M>,
  loadCandidates: () => Promise<ModelIdentity[]>,
): Promise<AdvisorModelSelection<M>> {
  if (!isSameModel(session, selected)) return { tag: "selected", model: selected };
  const candidates = await loadCandidates();
  const available = registry.getAvailable();
  const alternate = chooseAlternateModel(
    session,
    candidates,
    (candidate) =>
      registry.find(candidate.provider, candidate.id) !== undefined &&
      available.some((entry) => sameIdentity(entry, candidate)),
  );
  const model = alternate && registry.find(alternate.provider, alternate.id);
  if (!model) return { tag: "disabled", message: sameModelDisabledMessage(selected) };
  return { tag: "selected", model, notice: alternateModelNotice(model) };
}
