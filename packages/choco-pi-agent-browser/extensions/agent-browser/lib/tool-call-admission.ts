import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolCallAdmission {
  readonly gate: ToolCallAdmissionGate;
  readonly ready: Promise<void>;
  release(): void;
}

const currentAdmission = new AsyncLocalStorage<ToolCallAdmission>();

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
