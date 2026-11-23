import { createHash, randomUUID } from "node:crypto";

const PROCESS_SEED = randomUUID();

export interface ConversationIdentity {
  conversationId: string;
  trajectoryId: string;
  sessionId: string;
}

function digest(label: string, seed: string): Buffer {
  return createHash("sha256").update(`google-antigravity:${label}:${seed}`).digest();
}

function uuidFrom(bytes: Buffer): string {
  const raw = Buffer.from(bytes.subarray(0, 16));
  raw.writeUInt8((raw.readUInt8(6) & 0x0f) | 0x40, 6);
  raw.writeUInt8((raw.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = raw.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function conversationIdentity(sessionId: string | undefined): ConversationIdentity {
  const seed =
    sessionId !== undefined && sessionId.trim() !== ""
      ? `session:${sessionId}`
      : `process:${PROCESS_SEED}`;
  return {
    conversationId: uuidFrom(digest("conversation", seed)),
    trajectoryId: uuidFrom(digest("trajectory", seed)),
    sessionId: digest("session", seed).readBigInt64BE(0).toString(10),
  };
}
