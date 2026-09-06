export const MODEL_GUIDANCE_START = "<choco_pi_model_guidance>";
export const MODEL_GUIDANCE_END = "</choco_pi_model_guidance>";
export const CURRENT_MODEL_PLACEHOLDER = "{{PI_CURRENT_MODEL}}";

const SECTION_PATTERN =
  /<!-- choco-pi:model-guidance ([a-z0-9./:_-]+(?:,[a-z0-9./:_-]+)*) -->\r?\n([\s\S]*?)\r?\n<!-- choco-pi:model-guidance:end -->/g;
const OWNED_BLOCK_PATTERN =
  /(?:\r?\n){0,2}<choco_pi_model_guidance>\r?\n[\s\S]*?\r?\n<\/choco_pi_model_guidance>/g;
const LEGACY_RUNTIME_BLOCK_PATTERN =
  /(?:\r?\n){0,2}<runtime_environment>\r?\nHarness: choco-pi\r?\nCurrent model: [^\r\n]*\r?\n<\/runtime_environment>/g;
const CORE_RUNTIME_IDENTITY_PATTERN =
  /(<runtime_environment>\r?\nAgent: choco-pi\r?\n)Current model: [^\r\n]*(\r?\n<\/runtime_environment>)/g;
const MAX_SOURCE_LENGTH = 65_536;
const MAX_SECTION_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 512;

export interface RuntimeModel {
  provider: string;
  id: string;
}

export interface ParsedModelGuidance {
  shared: string;
  models: ReadonlyMap<string, string>;
}

export function parseModelGuidance(source: string): ParsedModelGuidance | undefined {
  if (source.length > MAX_SOURCE_LENGTH) return undefined;
  const sections = new Map<string, string>();
  for (const match of source.matchAll(SECTION_PATTERN)) {
    const keys = match[1].split(",");
    const body = match[2].trim();
    if (!body || body.length > MAX_SECTION_LENGTH || keys.some((key) => sections.has(key))) {
      return undefined;
    }
    for (const key of keys) sections.set(key, body);
  }
  const shared = sections.get("shared");
  if (!shared) return undefined;
  sections.delete("shared");
  return { shared, models: sections };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function encodedModel(model: RuntimeModel): string {
  const raw = `${model.provider}/${model.id}`;
  const bounded = raw.length > MAX_MODEL_LENGTH ? `${raw.slice(0, MAX_MODEL_LENGTH - 1)}…` : raw;
  return escapeXml(
    JSON.stringify(bounded).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"),
  );
}

/** Replaces this extension's complete prompt region while preserving all foreign content. */
export function composeModelGuidancePrompt(
  systemPrompt: string,
  model: RuntimeModel | undefined,
  guidance: ParsedModelGuidance | undefined,
): string {
  const withoutOwned = systemPrompt
    .replace(OWNED_BLOCK_PATTERN, "")
    .replace(LEGACY_RUNTIME_BLOCK_PATTERN, "")
    .replace(CORE_RUNTIME_IDENTITY_PATTERN, `$1Current model: "(see active model guidance)"$2`);
  const identity = model ? encodedModel(model) : escapeXml(JSON.stringify("unknown"));
  const withIdentity = withoutOwned.replaceAll(
    CURRENT_MODEL_PLACEHOLDER,
    '"(see active model guidance)"',
  );

  const exactModel = model ? `${model.provider}/${model.id}` : undefined;
  const specific = exactModel ? guidance?.models.get(exactModel) : undefined;
  const body = [
    MODEL_GUIDANCE_START,
    "<runtime_environment>",
    "Harness: choco-pi",
    `Current model: ${identity}`,
    "</runtime_environment>",
    "",
    ...(guidance
      ? [
          "",
          "<active_model_guidance>",
          guidance.shared,
          ...(specific ? ["", specific] : []),
          "</active_model_guidance>",
        ]
      : []),
    MODEL_GUIDANCE_END,
  ].join("\n");
  return `${withIdentity.trimEnd()}\n\n${body}`;
}
