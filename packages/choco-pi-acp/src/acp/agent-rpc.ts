/**
 * Pi RPC probing helpers shared by the ACP agent.
 */
import { type BoundaryValue, errorMessage } from "../boundary.ts";

/** One RPC probe settled without rejecting the surrounding parallel startup batch. */
export type RpcAttempt<Value> = {
  value: Value | null;
  error: BoundaryValue;
};

/** Report a Pi RPC capability the current session process does not expose. */
export function missingPiCapability(name: string): Error {
  return new Error(`pi ${name} is unavailable for this session`);
}

/** Read the message of a rejected promise or thrown value the way `String(e?.message ?? e)` did. */
export function failureText(failure: BoundaryValue): string {
  return errorMessage(failure);
}

/** Settle an RPC probe while retaining its typed success payload. */
export async function attemptRpc<Value>(request: Promise<Value>): Promise<RpcAttempt<Value>> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    // SAFETY: promise rejections may contain any JavaScript value; BoundaryValue is the
    // repository's recursive undecoded boundary contract and is inspected only by decoders.
    const failure = error as BoundaryValue;
    return { value: null, error: failure };
  }
}
