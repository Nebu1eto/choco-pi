import { type BoundaryValue, errorMessage } from "../boundary.ts";

export type RpcAttempt<Value> = {
  value: Value | null;
  error: BoundaryValue;
};

export function missingPiCapability(name: string): Error {
  return new Error(`pi ${name} is unavailable for this session`);
}

export function failureText(failure: BoundaryValue): string {
  return errorMessage(failure);
}

export async function attemptRpc<Value>(request: Promise<Value>): Promise<RpcAttempt<Value>> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    // SAFETY: promise rejections may contain any JavaScript value; BoundaryValue is the
    const failure = error as BoundaryValue;
    return { value: null, error: failure };
  }
}
