import { type Component, sliceByColumn, Text, visibleWidth } from "@earendil-works/pi-tui";

const MIN_DISPLAY_DESCRIPTION_LENGTH = 60;
const ELLIPSIS = "…";
const RIGHT_MARGIN = 2;

export function displayDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

export function fitDisplayDescription(description: string, columns: number): string {
  const characters = [...description];
  if (characters.length <= MIN_DISPLAY_DESCRIPTION_LENGTH) return description;
  const least =
    visibleWidth(characters.slice(0, MIN_DISPLAY_DESCRIPTION_LENGTH - 1).join("")) +
    visibleWidth(ELLIPSIS);
  const budget = Math.max(columns, least);
  if (visibleWidth(description) <= budget) return description;
  const kept = sliceByColumn(description, 0, budget - visibleWidth(ELLIPSIS), true);
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

export function describedTitle(
  title: string,
  description: string,
  style: (text: string) => string,
  rest = "",
): Component {
  const separator = " · ";
  const taken = visibleWidth(title) + visibleWidth(separator) + RIGHT_MARGIN;
  const text = new Text("", 0, 0);
  let drawnWidth: number | undefined;
  return {
    render(width: number): readonly string[] {
      if (width !== drawnWidth) {
        drawnWidth = width;
        const fitted = fitDisplayDescription(description, width - taken);
        text.setText(`${title}${style(`${separator}${fitted}`)}${rest}`);
      }
      return text.render(width);
    },
    invalidate(): void {
      drawnWidth = undefined;
      text.invalidate();
    },
  };
}

export function codeDisplayDescription(code: string): string | undefined {
  const description = code.match(/^[ \t]*\/\/\s*@description:\s*([^\r\n]*)/)?.[1];
  return displayDescription(description ?? firstExecCommandDescription(code));
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
