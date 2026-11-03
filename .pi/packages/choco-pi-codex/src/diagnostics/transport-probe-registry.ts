import { compile, bool, num, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { isJsonObject } from "../adapter/runtime-values.ts";
import { isFunction } from "../providers/value-guards.ts";

export const TRANSPORT_PROBE_SYMBOL: unique symbol = Symbol.for("choco-pi.transport-probe");

// Counters are in-process numbers: bound them so NaN and Infinity stay rejected.
const finiteNumber = () => num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
const transportProbeRecordSchema = obj(
  {
    probeInstance: opt(str()),
    requestId: opt(finiteNumber()),
    stream: str(),
    ts: str(),
    provider: str(),
    model: str(),
    continuation: str(),
    previousResponseId: bool(),
    nativeSteering: opt(bool()),
    fullInputItemCount: finiteNumber(),
    sentInputItemCount: finiteNumber(),
  },
  { open: true },
);
const transportProbeRecordValidator = compile(transportProbeRecordSchema);

export type TransportProbeRecord = Static<typeof transportProbeRecordSchema>;

// The registry is a live process-global object; its function member may be inherited.
function hasPublish<Value>(
  value: Value,
): value is Value & { publish(record: TransportProbeRecord): void } {
  return isJsonObject(value) && isFunction(value["publish"]);
}

/** Validate at the process-global boundary and keep probe failures off the request path. */
export function publishTransportProbe(record: TransportProbeRecord): void {
  if (!transportProbeRecordValidator.check(record)) return;
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    TRANSPORT_PROBE_SYMBOL,
  )?.value;
  if (!hasPublish(candidate)) return;
  try {
    candidate.publish(record);
  } catch {
    // The optional observer must never affect transport.
  }
}
