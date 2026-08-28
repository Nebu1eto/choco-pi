export const SESSION_WAIT_LIMIT_MS = 5_000;

export function limitSessionWait(timeoutMs: number): number {
  return Math.max(0, Math.min(SESSION_WAIT_LIMIT_MS, Math.floor(timeoutMs)));
}

type DeliveryQueue = { deliveryChain: Promise<void> };

/** Queue delivery without making the sender wait for the receiving turn. */
export function enqueueSessionDelivery(queue: DeliveryQueue, deliver: () => Promise<void>): void {
  const delivery = queue.deliveryChain.then(deliver);
  queue.deliveryChain = delivery.catch(() => undefined);
}
