import { compile, bool, num, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import { isFunction } from "@choco-pi/code-mode/value-guards";

export const TRANSPORT_PROBE_SYMBOL: unique symbol = Symbol.for("choco-pi.transport-probe");

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

function hasPublish<Value>(
  value: Value,
): value is Value & { publish(record: TransportProbeRecord): void } {
  return isJsonObject(value) && isFunction(value["publish"]);
}

export function publishTransportProbe(record: TransportProbeRecord): void {
  if (!transportProbeRecordValidator.check(record)) return;
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    TRANSPORT_PROBE_SYMBOL,
  )?.value;
  if (!hasPublish(candidate)) return;
  try {
    candidate.publish(record);
  } catch {}
}
