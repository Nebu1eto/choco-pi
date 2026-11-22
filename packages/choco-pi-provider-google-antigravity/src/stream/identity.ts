import { createHash, randomUUID } from "node:crypto";

/**
 * Fallback seed for requests that arrive without a Pi session id (one-off completions). It is
 * stable for the life of the process, so such requests still share one server-side session.
 */
const PROCESS_SEED = randomUUID();

/** The conversation-scoped identifiers one streamGenerateContent request carries. */
export interface ConversationIdentity {
  /** UUID agy calls the cascade id: requestId segment 2, labels.cascade_id/root_cascade_id. */
  conversationId: string;
  /** UUID agy calls the trajectory id: requestId segment 4, labels.trajectory_id. */
  trajectoryId: string;
  /** request.sessionId: a signed 64-bit integer in decimal, as the capture shows. */
  sessionId: string;
}

function digest(label: string, seed: string): Buffer {
  return createHash("sha256").update(`google-antigravity:${label}:${seed}`).digest();
}

/** RFC 4122 layout (version 4, variant 10) over the first 16 digest bytes. */
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

/**
 * Derives every conversation identifier from Pi's session id, so they are identical across
 * turns and retries of one session and differ between sessions. Without a session id the
 * process-wide fallback seed is used.
 */
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
