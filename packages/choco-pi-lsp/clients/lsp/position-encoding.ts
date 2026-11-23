import { obj, opt, str, compile } from "@earendil-works/pi-schema";

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

export const ADVERTISED_POSITION_ENCODINGS: readonly PositionEncoding[] = ["utf-16", "utf-8"];

const PositionEncodingCapabilitiesSchema = obj({ positionEncoding: opt(str()) }, { open: true });
const isPositionEncodingCapabilities = compile(PositionEncodingCapabilitiesSchema).check;

export function negotiatePositionEncoding<T>(serverCapabilities: T): PositionEncoding {
  if (!isPositionEncodingCapabilities(serverCapabilities)) return "utf-16";
  const raw = serverCapabilities.positionEncoding;
  if (raw === "utf-8" || raw === "utf-16" || raw === "utf-32") return raw;
  return "utf-16";
}

export function convertCharacterOffset(
  encoding: PositionEncoding,
  lineText: string,
  utf16Character: number,
): number {
  if (encoding === "utf-16") return utf16Character;
  if (utf16Character <= 0) return 0;
  const clamped = Math.min(utf16Character, lineText.length);
  const prefix = lineText.slice(0, clamped);
  if (encoding === "utf-8") return Buffer.byteLength(prefix, "utf8");
  return [...prefix].length;
}

export function lineTextAt(content: string, line: number): string {
  if (line < 0) return "";
  const lines = content.split("\n");
  return lines[line] ?? "";
}
