export function retargetReplacementIndentation(
  newText: string,
  oldText: string,
  correctedOldText: string,
): string | undefined {
  const newline = newText.includes("\r\n") ? "\r\n" : "\n";
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const correctedLines = correctedOldText.replace(/\r\n/g, "\n").split("\n");
  if (oldLines.length !== correctedLines.length) return undefined;

  const indentMap = new Map<string, string>();
  const ambiguousIndents = new Set<string>();
  for (let i = 0; i < oldLines.length; i += 1) {
    const oldIndent = oldLines[i].match(/^[\t ]*/)?.[0] ?? "";
    const correctedIndent = correctedLines[i].match(/^[\t ]*/)?.[0] ?? "";
    if (oldIndent === correctedIndent) continue;
    const previous = indentMap.get(oldIndent);
    if (previous !== undefined && previous !== correctedIndent) {
      indentMap.delete(oldIndent);
      ambiguousIndents.add(oldIndent);
      continue;
    }
    if (!ambiguousIndents.has(oldIndent)) {
      indentMap.set(oldIndent, correctedIndent);
    }
  }
  if (indentMap.size === 0) return undefined;

  let baseFrom = "";
  let baseTo = "";
  for (const [from, to] of indentMap) {
    if (from.length > 0 && (baseFrom === "" || from.length < baseFrom.length)) {
      baseFrom = from;
      baseTo = to;
    }
  }

  function resolveIndent(indent: string): string | undefined {
    if (indent === "") return "";
    const direct = indentMap.get(indent);
    if (direct !== undefined) return direct;
    if (
      baseFrom.length > 0 &&
      indent.length % baseFrom.length === 0 &&
      baseFrom.repeat(indent.length / baseFrom.length) === indent
    ) {
      return baseTo.repeat(indent.length / baseFrom.length);
    }
    return undefined;
  }

  let changed = false;
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  const retargetedLines: string[] = [];

  for (const line of newLines) {
    const indent = line.match(/^[\t ]*/)?.[0] ?? "";
    if (indent === line) {
      retargetedLines.push(line);
      continue;
    }
    const resolved = resolveIndent(indent);
    if (resolved === undefined) {
      return undefined;
    }
    if (resolved !== indent) {
      changed = true;
      retargetedLines.push(resolved + line.slice(indent.length));
    } else {
      retargetedLines.push(line);
    }
  }

  return changed ? retargetedLines.join(newline) : undefined;
}
