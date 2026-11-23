/** Digest helpers shared by the Anthropic and xAI checkpoint details. */
import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Non-secret identity of an opaque value for diagnostics: digest prefix and length, never the value. */
export function opaqueFingerprint(secret: string): string {
  return `${sha256(secret).slice(0, 16)}:${secret.length}`;
}
