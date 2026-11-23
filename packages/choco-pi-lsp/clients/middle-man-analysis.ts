import type { ModuleSymbolEntry } from "./module-report.ts";

interface SELFTOKENValues extends Record<string, { token: string; sep: string }> {}
const SELF_TOKEN: SELFTOKENValues = {
  typescript: { token: "this", sep: "." },
  tsx: { token: "this", sep: "." },
  javascript: { token: "this", sep: "." },
  java: { token: "this", sep: "." },
  kotlin: { token: "this", sep: "." },
  csharp: { token: "this", sep: "." },
  swift: { token: "this", sep: "." },
  dart: { token: "this", sep: "." },
  rust: { token: "self", sep: "." },
  python: { token: "self", sep: "." },
  ruby: { token: "self", sep: "." },
  php: { token: "$this", sep: "->" },
};

const INTENTIONAL_FORWARDER_NAME = /adapter|facade|proxy|wrapper|decorator/i;

const CONSTRUCTOR_NAMES = new Set(["constructor", "__init__", "__new__", "initialize"]);

const MIN_CANDIDATE_METHODS = 2;

const DELEGATION_RATIO_THRESHOLD = 0.9;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildForwardRegex(token: string, sep: string): RegExp {
  const t = escapeRegExp(token);
  const s = escapeRegExp(sep);
  return new RegExp(`^(?:return\\s+)?(?:await\\s+)?${t}${s}(\\w+)${s}(\\w+)\\(([^()]*)\\)\\s*;?$`);
}

function splitArgs(s: string): string[] {
  const trimmed = s.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((a) => a.trim());
}

function paramNamesFromSignature(
  signature: string | undefined,
  languageId: string,
): string[] | undefined {
  const inner = (signature ?? "").trim().replace(/^\(/, "").replace(/\)$/, "");
  if (inner.trim() === "") return [];
  if (inner.includes("{") || inner.includes("[")) return undefined;
  const names = splitArgs(inner)
    .filter((p) => p.length > 0)
    .map((raw) => {
      let name = raw;
      const isRest = name.startsWith("...");
      name = name.replace(/^\.\.\./, "");
      name = name.split("=")[0].trim();
      name = name.split(":")[0].trim();
      name = name.replace(/\?$/, "");
      return isRest ? `...${name}` : name;
    });
  if (languageId === "python" && names[0] === "self") return names.slice(1);
  if (languageId === "python" && names[0] === "cls") return names.slice(1);
  return names;
}

function bodyStatementLines(
  lines: string[],
  entry: ModuleSymbolEntry,
  isPython: boolean,
): string[] {
  const raw = lines.slice(entry.startLine - 1, entry.endLine).join("\n");
  let body: string;
  if (isPython) {
    const nlIdx = raw.indexOf("\n");
    if (nlIdx === -1) return [];
    body = raw.slice(nlIdx + 1);
  } else {
    const braceIdx = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (braceIdx === -1 || lastBrace === -1 || lastBrace <= braceIdx) return [];
    body = raw.slice(braceIdx + 1, lastBrace);
  }
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .map((l) => (isPython ? l.replace(/#.*$/, "") : l))
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^("""|''')/.test(l));
}

function isAccessorLine(rawLine: string): boolean {
  return /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|override\s+|readonly\s+)*(?:get|set)\s+\w+\s*[/(]/.test(
    rawLine,
  );
}

export interface MiddleManSignal {
  delegationRatio: number;
  candidateCount: number;
  forwardingCount: number;
  delegateField: string;
}

export function analyzeMiddleMan(
  classEntry: ModuleSymbolEntry,
  lines: string[],
  languageId: string | undefined,
): MiddleManSignal | undefined {
  if (!languageId) return undefined;
  const selfSpec = SELF_TOKEN[languageId];
  if (!selfSpec) return undefined;
  if (!classEntry.members || classEntry.members.length === 0) return undefined;

  const isPython = languageId === "python";
  const forwardRe = buildForwardRegex(selfSpec.token, selfSpec.sep);
  const className = classEntry.name;

  const candidates = classEntry.members.filter((m) => {
    if (m.kind !== "method") return false;
    if (CONSTRUCTOR_NAMES.has(m.name)) return false;
    if (m.name === className || m.name === `~${className}`) return false;
    const rawLine = lines[m.startLine - 1] ?? "";
    if (isAccessorLine(rawLine)) return false;
    return true;
  });
  if (candidates.length < MIN_CANDIDATE_METHODS) return undefined;

  let forwardingCount = 0;
  const fieldCounts = new Map<string, number>();

  for (const member of candidates) {
    const bodyLines = bodyStatementLines(lines, member, isPython);
    if (bodyLines.length !== 1) continue;
    const match = forwardRe.exec(bodyLines[0]);
    if (!match) continue;
    const [, field, calledMethod, argsText] = match;
    const paramNames = paramNamesFromSignature(member.signature, languageId);
    if (paramNames === undefined) continue;
    const args = splitArgs(argsText);
    if (args.length !== paramNames.length) continue;
    if (!args.every((a, i) => a === paramNames[i])) continue;
    void calledMethod;
    forwardingCount += 1;
    fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
  }

  if (forwardingCount === 0) return undefined;

  if (fieldCounts.size !== 1) return undefined;
  const [delegateField] = [...fieldCounts.keys()];

  return {
    delegationRatio: forwardingCount / candidates.length,
    candidateCount: candidates.length,
    forwardingCount,
    delegateField,
  };
}

function implementsInterface(lines: string[], classEntry: ModuleSymbolEntry): boolean {
  const declText = lines
    .slice(classEntry.startLine - 1, Math.min(classEntry.startLine + 1, lines.length))
    .join(" ");
  return /\bimplements\b/.test(declText);
}

export function annotateMiddleMan(
  entries: ModuleSymbolEntry[],
  content: string,
  languageId: string | undefined,
): void {
  if (!languageId || !SELF_TOKEN[languageId]) return;
  const lines = content.split(/\r?\n/);
  for (const entry of entries) {
    if (entry.kind !== "class") continue;
    if (INTENTIONAL_FORWARDER_NAME.test(entry.name)) continue;
    if (implementsInterface(lines, entry)) continue;
    const signal = analyzeMiddleMan(entry, lines, languageId);
    if (!signal) continue;
    if (signal.delegationRatio < DELEGATION_RATIO_THRESHOLD) continue;
    entry.delegationRatio = signal.delegationRatio;
    entry.flags = entry.flags ? [...entry.flags, "middle man"] : ["middle man"];
  }
}
