import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arr, compile, map, obj, opt, str } from "@earendil-works/pi-schema";

const fallbacksValidator = compile(
  obj(
    {
      tiers: obj(
        {
          flagship: obj({ primary: arr(str()), secondary: opt(arr(str())) }, { open: true }),
        },
        { open: true },
      ),
    },
    { open: true },
  ),
);

function defaultFallbacksPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "profile",
    "model-fallbacks.json",
  );
}

export function normalizeTierModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("openai/")
    ? `openai-codex/${trimmed.slice("openai/".length)}`
    : trimmed;
}

const cache = new Map<string, Promise<ReadonlySet<string>>>();

async function readFlagship(path: string): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (!fallbacksValidator.check(parsed)) return new Set();
    const { primary, secondary } = parsed.tiers.flagship;
    return new Set([...primary, ...(secondary ?? [])].map(normalizeTierModel));
  } catch {
    return new Set();
  }
}

export function loadFlagshipModels(
  path: string = defaultFallbacksPath(),
): Promise<ReadonlySet<string>> {
  let entry = cache.get(path);
  if (!entry) {
    entry = readFlagship(path);
    cache.set(path, entry);
  }
  return entry;
}

const variantsValidator = compile(obj({ preferWhenAvailable: opt(map(str())) }, { open: true }));

const variantsCache = new Map<string, Promise<ReadonlyMap<string, string>>>();

async function readVariants(path: string): Promise<ReadonlyMap<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (!variantsValidator.check(parsed)) return new Map();
    return new Map(Object.entries(parsed.preferWhenAvailable ?? {}));
  } catch {
    return new Map();
  }
}

export function loadPreferredVariants(
  path: string = defaultFallbacksPath(),
): Promise<ReadonlyMap<string, string>> {
  let entry = variantsCache.get(path);
  if (!entry) {
    entry = readVariants(path);
    variantsCache.set(path, entry);
  }
  return entry;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface VariantRegistry<M extends ModelRef> {
  find(provider: string, modelId: string): M | undefined;
  getAvailable(): readonly ModelRef[];
}

export type VariantChoice<M extends ModelRef> = { model: M; replaced?: string };

export function chooseVariant<M extends ModelRef>(
  model: M,
  variants: ReadonlyMap<string, string>,
  registry: VariantRegistry<M>,
  inScope: (candidate: ModelRef) => boolean,
): VariantChoice<M> {
  const key = `${model.provider}/${model.id}`;
  const target = variants.get(key);
  if (target === undefined) return { model };
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return { model };
  const provider = target.slice(0, slash);
  const id = target.slice(slash + 1);
  if (provider !== model.provider || id === model.id) return { model };
  const available = registry
    .getAvailable()
    .some((entry) => entry.provider === provider && entry.id === id);
  if (!available) return { model };
  const variant = registry.find(provider, id);
  if (variant === undefined || !inScope(variant)) return { model };
  return { model: variant, replaced: key };
}

export function variantNote(choice: VariantChoice<ModelRef>): string {
  if (choice.replaced === undefined) return "";
  return (
    `Note: using ${choice.model.provider}/${choice.model.id} instead of ${choice.replaced}; ` +
    "this account can use it (model-fallbacks.json preferWhenAvailable).\n\n"
  );
}
