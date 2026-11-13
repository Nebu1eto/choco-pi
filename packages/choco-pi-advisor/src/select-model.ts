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

function refKey(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

function lowerKeys(variants: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  return new Map([...variants].map(([from, to]) => [from.toLowerCase(), to.toLowerCase()]));
}

/** Same model, or one is the access-program variant of the other (same weights). */
function isSameOrVariant(
  session: ModelIdentity | undefined,
  model: ModelIdentity,
  variants: ReadonlyMap<string, string>,
): boolean {
  if (session === undefined) return false;
  if (isSameModel(session, model)) return true;
  const a = refKey(session);
  const b = refKey(model);
  return variants.get(a) === b || variants.get(b) === a;
}

/**
 * Use the configured advisor model, or its access-program variant when the account can use it
 * (Fable -> Mythos; the registry hides Mythos from accounts without access). When that equals
 * the session model or its variant, use the first Flagship primary, again preferring an
 * available variant, that differs from the session and is registered and available.
 */
export async function selectAdvisorModel<M extends ModelIdentity>(
  selected: M,
  session: ModelIdentity | undefined,
  registry: AdvisorModelRegistry<M>,
  loadCandidates: () => Promise<ModelIdentity[]>,
  loadVariants: () => Promise<ReadonlyMap<string, string>> = async () => new Map(),
): Promise<AdvisorModelSelection<M>> {
  const variants = lowerKeys(await loadVariants());
  const available = registry.getAvailable();
  const usable = (candidate: ModelIdentity): boolean =>
    registry.find(candidate.provider, candidate.id) !== undefined &&
    available.some((entry) => sameIdentity(entry, candidate));
  /** The available same-provider variant of `model`, else `model`. */
  const prefer = (model: ModelIdentity): ModelIdentity => {
    const target = variants.get(refKey(model));
    if (target === undefined || !target.startsWith(`${model.provider.toLowerCase()}/`)) {
      return model;
    }
    const variant = available.find((entry) => refKey(entry) === target);
    return variant !== undefined && usable(variant) ? variant : model;
  };
  const preferred = prefer(selected);
  const configured =
    preferred === selected
      ? selected
      : (registry.find(preferred.provider, preferred.id) ?? selected);
  if (!isSameOrVariant(session, configured, variants)) {
    return { tag: "selected", model: configured };
  }
  const candidates = (await loadCandidates()).map(prefer);
  const alternate = chooseAlternateModel(
    undefined,
    candidates.filter((candidate) => !isSameOrVariant(session, candidate, variants)),
    usable,
  );
  const model = alternate && registry.find(alternate.provider, alternate.id);
  if (!model) return { tag: "disabled", message: sameModelDisabledMessage(selected) };
  return { tag: "selected", model, notice: alternateModelNotice(model) };
}
