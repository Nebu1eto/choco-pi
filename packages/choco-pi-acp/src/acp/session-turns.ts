import type { BoundaryValue } from "../boundary.ts";
import type { PiPromptImage } from "../pi-rpc/protocol.ts";
import type { StopReason } from "./session.ts";

export type PendingTurn = {
  resolve: (reason: StopReason) => void;
  reject: (error: BoundaryValue) => void;
  settling: boolean;
  acknowledged: boolean;
};

export type QueuedTurn = {
  message: string;
  images: PiPromptImage[];
  resolve: (reason: StopReason) => void;
  reject: (error: BoundaryValue) => void;
};

export type TurnSettlement =
  | { type: "resolve"; reason: StopReason }
  | { type: "reject"; error: BoundaryValue };

export function settleTurn(
  turn: Pick<QueuedTurn, "resolve" | "reject">,
  settlement: TurnSettlement,
): void {
  if (settlement.type === "reject") {
    turn.reject(settlement.error);
  } else {
    turn.resolve(settlement.reason);
  }
}
