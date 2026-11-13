export const SESSION_WAIT_LIMIT_MS = 5_000;

export type SessionDeliveryMode = "queue" | "steer";

/** Queue is retained for wire compatibility but is intentionally never a follow-up delivery. */
export function effectiveSessionDeliveryMode(_requested?: SessionDeliveryMode): "steer" {
  return "steer";
}

export function limitSessionWait(timeoutMs: number): number {
  return Math.max(0, Math.min(SESSION_WAIT_LIMIT_MS, Math.floor(timeoutMs)));
}

export type SessionDeliveryTracker = {
  deliveries: Set<Promise<void>>;
  onError: (error: Error) => void;
};

/** Submit immediately; track settlement without serializing later steering messages behind a turn. */
export function submitSessionDelivery(
  tracker: SessionDeliveryTracker,
  deliver: () => Promise<void>,
): void {
  let delivery: Promise<void>;
  try {
    delivery = deliver();
  } catch (error) {
    tracker.onError(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  tracker.deliveries.add(delivery);
  void delivery.then(
    () => tracker.deliveries.delete(delivery),
    (error: Error) => {
      tracker.deliveries.delete(delivery);
      tracker.onError(error instanceof Error ? error : new Error(String(error)));
    },
  );
}
