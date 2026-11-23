export function buildSymbolId(
  filePath: string,
  name: string,
  kind: string,
  startLine: number,
): string {
  return `${filePath}:${name}:${kind}:${startLine}`;
}

const KIND_TOKEN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface ParsedSymbolKey {
  filePath: string;
  symbolName?: string;
  kind?: string;
  line?: number;
}

export function parseSymbolKey(key: string, knownFilePath?: string): ParsedSymbolKey {
  if (key.startsWith("file:")) {
    return { filePath: key.slice("file:".length) };
  }
  const canonical = /^(.*):([^:]*):([^:]+):(\d+)$/.exec(key);
  if (canonical && KIND_TOKEN_RE.test(canonical[3])) {
    return {
      filePath: canonical[1],
      symbolName: canonical[2] || undefined,
      kind: canonical[3],
      line: Number(canonical[4]),
    };
  }
  if (knownFilePath && key.startsWith(`${knownFilePath}:`)) {
    return {
      filePath: knownFilePath,
      symbolName: key.slice(knownFilePath.length + 1) || undefined,
    };
  }
  const separator = key.lastIndexOf(":");
  return separator < 0
    ? { filePath: key }
    : {
        filePath: key.slice(0, separator),
        symbolName: key.slice(separator + 1) || undefined,
      };
}
