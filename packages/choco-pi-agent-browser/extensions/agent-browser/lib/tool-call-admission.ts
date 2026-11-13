import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolCallAdmission {
  readonly gate: ToolCallAdmissionGate;
  /** Settles once every earlier call on the same gate has released its turn. */
  readonly ready: Promise<void>;
  /** Ends this call's turn; later calls may then pick their session queue. Idempotent. */
  release(): void;
}

const currentAdmission = new AsyncLocalStorage<ToolCallAdmission>();

// Admits overlapping tool calls to the session queues in call order. Pi starts the calls
// of one assistant message in order but runs them concurrently, so awaited preflight work
// can otherwise let a later call choose its session before an earlier call is queued.
// A turn completes only after its own release and every earlier turn, so releasing out
// of order cannot reorder later calls.
export class ToolCallAdmissionGate {
  private tail: Promise<void> = Promise.resolve();

  reserve(): ToolCallAdmission {
    const ready = this.tail;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = ready.then(() => released);
    return { gate: this, ready, release };
  }

  /** Reserves a turn synchronously, exposes it to `work`, and releases it when `work` settles. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const admission = this.reserve();
    try {
      return await currentAdmission.run(admission, work);
    } finally {
      admission.release();
    }
  }
}

export function getCurrentToolCallAdmission(): ToolCallAdmission | undefined {
  return currentAdmission.getStore();
}
