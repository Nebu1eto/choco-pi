const MAX_DISPLAY_DESCRIPTION_LENGTH = 60;

export function conciseDisplayDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= MAX_DISPLAY_DESCRIPTION_LENGTH
    ? normalized
    : `${characters.slice(0, MAX_DISPLAY_DESCRIPTION_LENGTH - 1).join("")}…`;
}

export function codeDisplayDescription(code: string): string | undefined {
  const description = code.match(/^[ \t]*\/\/\s*@description:\s*([^\r\n]*)/)?.[1];
  return conciseDisplayDescription(description ?? firstExecCommandDescription(code));
}

function firstExecCommandDescription(code: string): string | undefined {
  const match = code.match(
    /\btools(?:\.exec_command|\s*\[\s*["']exec_command["']\s*\])\s*\(\s*\{[\s\S]{0,500}?\bdescription\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/,
  );
  if (!match?.[2]) return undefined;
  return match[2].replace(/\\([\\"'`nrt])/g, (_source, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}
