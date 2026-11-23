import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function opaqueFingerprint(secret: string): string {
  return `${sha256(secret).slice(0, 16)}:${secret.length}`;
}
