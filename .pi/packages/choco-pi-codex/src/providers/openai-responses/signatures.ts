import { Type } from "typebox";
import { Check } from "typebox/value";

export type TextSignaturePhase = "commentary" | "final_answer";

const TextSignatureSchema = Type.Object({
  v: Type.Literal(1),
  id: Type.String(),
  phase: Type.Optional(Type.Unknown()),
});

export function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

export function encodeTextSignatureV1(id: string, phase?: string): string {
  return JSON.stringify(phase ? { v: 1, id, phase } : { v: 1, id });
}

export function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: TextSignaturePhase | undefined } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed: object = JSON.parse(signature);
      if (Check(TextSignatureSchema, parsed)) {
        return parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Fall through to legacy plain-string handling.
    }
  }
  return { id: signature };
}
