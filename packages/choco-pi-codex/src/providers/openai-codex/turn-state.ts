import { isString } from "../value-guards.ts";
import { compile, map, obj, oneOf, unknown } from "@earendil-works/pi-schema";
import type { CodexStreamEvent } from "./types.ts";

export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

// Open wire event: unknown fields are ignored, as before.
const turnStateEventValidator = compile(
  obj(
    {
      type: oneOf(["response.metadata", "codex.response.metadata"]),
      headers: map(unknown()),
    },
    { open: true },
  ),
);

export interface CodexTurnState {
  current(): string | undefined;
  capture(value: string | null | undefined): void;
  /** Binds capture to the current turn generation so stale decodes cannot capture. */
  captureForTurn(): (value: string | null | undefined) => void;
  capturePrewarm(value: string | null | undefined): void;
  beginTurn(): void;
  reset(): void;
}

export function withCodexTurnState<
  T extends { client_metadata?: Record<string, string> | undefined },
>(body: T, turnState: CodexTurnState | undefined): T {
  const current = turnState?.current();
  return current
    ? {
        ...body,
        client_metadata: { ...body.client_metadata, [CODEX_TURN_STATE_HEADER]: current },
      }
    : body;
}

export function withCodexTurnStateHeader(
  headers: Headers,
  turnState: CodexTurnState | undefined,
): Headers {
  const attemptHeaders = new Headers(headers);
  const current = turnState?.current();
  if (current) attemptHeaders.set(CODEX_TURN_STATE_HEADER, current);
  return attemptHeaders;
}

export function createCodexTurnState(): CodexTurnState {
  let value: string | undefined;
  let prewarmed = false;
  let generation = 0;
  const capture = (next: string | null | undefined) => {
    if (value !== undefined || !next?.trim()) return;
    value = next.trim();
  };
  return {
    current: () => value,
    capture,
    captureForTurn() {
      const owner = generation;
      return (next) => {
        if (owner === generation) capture(next);
      };
    },
    capturePrewarm(next) {
      capture(next);
      if (value !== undefined) prewarmed = true;
    },
    beginTurn() {
      generation++;
      if (prewarmed) {
        prewarmed = false;
        return;
      }
      value = undefined;
    },
    reset() {
      generation++;
      value = undefined;
      prewarmed = false;
    },
  };
}

export function extractCodexTurnStateFromWebSocketEvent(
  event: CodexStreamEvent,
): string | undefined {
  if (!turnStateEventValidator.check(event)) return undefined;
  const parsed = event;
  for (const [name, value] of Object.entries(parsed.headers)) {
    if (name.toLowerCase() === CODEX_TURN_STATE_HEADER && isString(value) && value.trim())
      return value.trim();
  }
  return undefined;
}
