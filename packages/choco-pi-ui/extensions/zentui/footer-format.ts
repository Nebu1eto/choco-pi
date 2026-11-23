export type FormatToken =
  | { kind: "text"; value: string }
  | { kind: "var"; name: string }
  | { kind: "fill" }
  | { kind: "group"; tokens: FormatToken[] };

export type CompactBoundaryKind = "space" | "separator";

export type CompactFormatChunk =
  | { kind: "tokens"; tokens: FormatToken[]; boundary: CompactBoundaryKind }
  | { kind: "extensions"; boundary: CompactBoundaryKind };

type ParsedTokenSlice = { tokens: FormatToken[]; nextIndex: number };
export type RenderedFormatSplit = { left: string; middle: string; right: string };

const TOKEN_REGEX = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function parseFooterFormat(format: string): FormatToken[] {
  if (!format) return [];
  return parseTokenSlice(format, 0, format.length, true).tokens;
}

function parseTokenSlice(
  format: string,
  start: number,
  end: number,
  topLevel = false,
): ParsedTokenSlice {
  const tokens: FormatToken[] = [];
  let index = start;
  let textStart = start;

  const flushText = (until: number) => {
    if (until > textStart) {
      tokens.push({ kind: "text", value: format.slice(textStart, until) });
    }
  };

  while (index < end) {
    const ch = format[index];

    if (ch === "(") {
      flushText(index);
      const nested = parseTokenSlice(format, index + 1, end, false);
      tokens.push({ kind: "group", tokens: nested.tokens });
      index = nested.nextIndex;
      textStart = index;
      continue;
    }

    if (ch === ")") {
      if (topLevel) {
        index += 1;
        continue;
      }
      flushText(index);
      return { tokens, nextIndex: index + 1 };
    }

    if (ch === "$") {
      TOKEN_REGEX.lastIndex = index;
      const match = TOKEN_REGEX.exec(format);
      if (match && match.index === index && match.index < end) {
        const full = match[0];
        const matchEnd = match.index + full.length;
        if (matchEnd > end) {
          index += 1;
          continue;
        }
        flushText(index);
        const name = match[1] ?? match[2] ?? "";
        if (name === "fill") {
          tokens.push({ kind: "fill" });
        } else {
          tokens.push({ kind: "var", name });
        }
        index = matchEnd;
        textStart = index;
        continue;
      }
    }

    index += 1;
  }

  flushText(end);
  return { tokens, nextIndex: end };
}

export function renderFormatSplit(
  tokens: FormatToken[],
  renderVariable: (name: string) => string,
): RenderedFormatSplit {
  const fillIndices = findTopLevelFillIndices(tokens);

  if (fillIndices.length === 0) {
    return {
      left: renderTokenSlice(tokens, 0, tokens.length, renderVariable),
      middle: "",
      right: "",
    };
  }

  const first = fillIndices[0];
  const second = fillIndices[1];

  if (first === undefined) {
    return {
      left: renderTokenSlice(tokens, 0, tokens.length, renderVariable),
      middle: "",
      right: "",
    };
  }

  if (second === undefined) {
    return {
      left: renderTokenSlice(tokens, 0, first, renderVariable),
      middle: "",
      right: renderTokenSlice(tokens, first + 1, tokens.length, renderVariable),
    };
  }

  return {
    left: renderTokenSlice(tokens, 0, first, renderVariable),
    middle: renderTokenSlice(tokens, first + 1, second, renderVariable),
    right: renderTokenSlice(tokens, second + 1, tokens.length, renderVariable),
  };
}

export function compileCompactFormat(tokens: FormatToken[]): CompactFormatChunk[] {
  const chunks: CompactFormatChunk[] = [];
  let current: FormatToken[] = [];
  let incomingBoundary: CompactBoundaryKind = "space";

  const flush = () => {
    const normalized = trimBoundaryWhitespace(current);
    current = [];
    if (normalized.length === 0) return;
    if (
      normalized.length === 1 &&
      normalized[0]?.kind === "var" &&
      normalized[0].name === "extensions"
    ) {
      chunks.push({ kind: "extensions", boundary: incomingBoundary });
      return;
    }
    chunks.push({ kind: "tokens", tokens: normalized, boundary: incomingBoundary });
  };

  for (const token of tokens) {
    if (token.kind === "var" && (token.name === "wrap" || token.name === "wrap_sep")) {
      flush();
      incomingBoundary = token.name === "wrap_sep" ? "separator" : "space";
      continue;
    }
    if (token.kind === "fill") continue;
    current.push(token);
  }
  flush();
  return chunks;
}

function trimBoundaryWhitespace(tokens: FormatToken[]): FormatToken[] {
  const result = tokens.map((token) => (token.kind === "text" ? { ...token } : token));
  while (result[0]?.kind === "text") {
    result[0].value = result[0].value.replace(/^\s+/, "");
    if (result[0].value) break;
    result.shift();
  }
  while (result.at(-1)?.kind === "text") {
    const last = result.at(-1);
    if (last?.kind !== "text") break;
    last.value = last.value.replace(/\s+$/, "");
    if (last.value) break;
    result.pop();
  }
  return result;
}

export function renderFormatTokens(
  tokens: FormatToken[],
  renderVariable: (name: string) => string,
): string {
  return renderTokenSlice(tokens, 0, tokens.length, renderVariable);
}

export function collectFooterFormatReferences(
  tokens: FormatToken[],
  aliases: Record<string, string> = {},
): Set<string> {
  const references = new Set<string>();
  const visit = (items: FormatToken[]) => {
    for (const token of items) {
      if (token.kind === "group") {
        visit(token.tokens);
        continue;
      }
      if (token.kind !== "var") continue;
      const canonical = aliases[token.name] ?? token.name;
      if (canonical !== "wrap" && canonical !== "wrap_sep" && canonical !== "extensions") {
        references.add(canonical);
      }
    }
  };
  visit(tokens);
  return references;
}

function findTopLevelFillIndices(tokens: FormatToken[]): number[] {
  const fillIndices: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.kind === "fill") fillIndices.push(index);
  }
  return fillIndices;
}

function renderTokenSlice(
  tokens: FormatToken[],
  start: number,
  end: number,
  renderVariable: (name: string) => string,
): string {
  let result = "";
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (!token) continue;
    result += renderToken(token, renderVariable);
  }
  return result;
}

function renderToken(token: FormatToken, renderVariable: (name: string) => string): string {
  if (token.kind === "text") return token.value;
  if (token.kind === "var") return renderVariable(token.name);
  if (token.kind === "fill") return "";
  const rendered = token.tokens.map((child) => renderToken(child, renderVariable)).join("");
  if (isGroupEmpty(token, renderVariable)) return "";
  return rendered;
}

const NON_CONTENT_VARS = new Set(["sep", "separator"]);

function isGroupEmpty(
  group: FormatToken & { kind: "group" },
  renderVariable: (name: string) => string,
): boolean {
  let sawContentVarOrGroup = false;
  for (const child of group.tokens) {
    if (child.kind === "var") {
      if (NON_CONTENT_VARS.has(child.name)) continue;
      sawContentVarOrGroup = true;
      if (renderVariable(child.name) !== "") return false;
    } else if (child.kind === "group") {
      sawContentVarOrGroup = true;
      if (!isGroupEmpty(child, renderVariable)) return false;
    }
  }
  return sawContentVarOrGroup || groupOnlyNonContentVars(group);
}

function groupOnlyNonContentVars(group: FormatToken & { kind: "group" }): boolean {
  let sawSep = false;
  for (const child of group.tokens) {
    if (child.kind === "text") {
      if (child.value.trim() !== "") return false;
      continue;
    }
    if (child.kind === "var") {
      if (!NON_CONTENT_VARS.has(child.name)) return false;
      sawSep = true;
      continue;
    }
    if (child.kind === "group") return false;
    if (child.kind === "fill") continue;
  }
  return sawSep;
}

const ANSI_ONE_SRC = "\u001b\\[[0-9;]*m";

const SEP_UNIT_SRC = `(?:${ANSI_ONE_SRC})?\\s+\\|\\s+(?:${ANSI_ONE_SRC})?`;

export function joinNonEmpty(parts: string[], separator: string): string {
  return parts.filter(Boolean).join(separator);
}

export function stripOrphanSeparators(rendered: string): string {
  if (!rendered) return rendered;

  const consecutive = new RegExp(`(${SEP_UNIT_SRC})(?:${SEP_UNIT_SRC})+`, "g");
  let result = rendered.replace(consecutive, "$1");

  result = result.replace(new RegExp(`^(?:${SEP_UNIT_SRC})+`), "");
  result = result.replace(new RegExp(`(?:${SEP_UNIT_SRC})+$`), "");

  result = result.replace(/^\s+/, "").replace(/\s+$/, "");

  if (result.replace(new RegExp(ANSI_ONE_SRC, "g"), "").trim() === "") return "";

  return result;
}
