import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { CodexStreamEvent } from "./types.ts";

export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

const TurnStateEventSchema = Type.Object({
  type: Type.Union([Type.Literal("response.metadata"), Type.Literal("codex.response.metadata")]),
  headers: Type.Record(Type.String(), Type.Unknown()),
});
type TurnStateEvent = Static<typeof TurnStateEventSchema>;

export interface CodexTurnState {
  current(): string | undefined;
  capture(value: string | null | undefined): void;
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
  const capture = (next: string | null | undefined) => {
    if (value !== undefined || !next?.trim()) return;
    value = next.trim();
  };
  return {
    current: () => value,
    capture,
    capturePrewarm(next) {
      capture(next);
      if (value !== undefined) prewarmed = true;
    },
    beginTurn() {
      if (prewarmed) {
        prewarmed = false;
        return;
      }
      value = undefined;
    },
    reset() {
      value = undefined;
      prewarmed = false;
    },
  };
}

export function extractCodexTurnStateFromWebSocketEvent(
  event: CodexStreamEvent,
): string | undefined {
  if (!Check(TurnStateEventSchema, event)) return undefined;
  const parsed: TurnStateEvent = event;
  for (const [name, value] of Object.entries(parsed.headers)) {
    if (
      name.toLowerCase() === CODEX_TURN_STATE_HEADER &&
      Check(Type.String(), value) &&
      value.trim()
    )
      return value.trim();
  }
  return undefined;
}
