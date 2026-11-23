export const HOST_EDIT_DIFF_SDK_FLOOR = "0.79.9";

export const HOST_SMART_SINGLE_QUOTES = [0x2018, 0x2019, 0x201a, 0x201b];
export const HOST_SMART_DOUBLE_QUOTES = [0x201c, 0x201d, 0x201e, 0x201f];
export const HOST_UNICODE_DASHES = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212];
export const HOST_SPECIAL_SPACES = [
  0x00a0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f,
  0x3000,
];
export const HOST_BOM_CODE_POINT = 0xfeff;

const charClass = (codePoints: number[]): RegExp =>
  new RegExp(`[${String.fromCharCode(...codePoints)}]`, "g");

const SMART_SINGLE_QUOTES_RE = charClass(HOST_SMART_SINGLE_QUOTES);
const SMART_DOUBLE_QUOTES_RE = charClass(HOST_SMART_DOUBLE_QUOTES);
const UNICODE_DASHES_RE = charClass(HOST_UNICODE_DASHES);
const SPECIAL_SPACES_RE = charClass(HOST_SPECIAL_SPACES);
const BOM = String.fromCharCode(HOST_BOM_CODE_POINT);

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(SMART_SINGLE_QUOTES_RE, "'")
    .replace(SMART_DOUBLE_QUOTES_RE, '"')
    .replace(UNICODE_DASHES_RE, "-")
    .replace(SPECIAL_SPACES_RE, " ");
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith(BOM)
    ? { bom: BOM, text: content.slice(1) }
    : { bom: "", text: content };
}

export function normalizeForGuardMatch(text: string): string {
  return normalizeForFuzzyMatch(normalizeToLF(stripBom(text).text));
}

export interface HostMatchOutcome {
  wouldApply: boolean;
  occurrences: number;
  usedFuzzyMatch: boolean;
}

export function hostWouldApplyOldText(content: string, oldText: string): HostMatchOutcome {
  const c = normalizeToLF(stripBom(content).text);
  const o = normalizeToLF(stripBom(oldText).text);
  if (o.length === 0) {
    return { wouldApply: false, occurrences: 0, usedFuzzyMatch: false };
  }
  const exactFound = c.indexOf(o) !== -1;
  const fuzzyContent = normalizeForFuzzyMatch(c);
  const fuzzyOldText = normalizeForFuzzyMatch(o);
  const fuzzyFound = fuzzyContent.indexOf(fuzzyOldText) !== -1;
  const occurrences = fuzzyOldText.length === 0 ? 0 : fuzzyContent.split(fuzzyOldText).length - 1;
  return {
    wouldApply: (exactFound || fuzzyFound) && occurrences === 1,
    occurrences,
    usedFuzzyMatch: !exactFound && fuzzyFound,
  };
}
