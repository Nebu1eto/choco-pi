import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const TRANSPORT_PROBE_SYMBOL: unique symbol = Symbol.for("choco-pi.transport-probe");

const TransportProbeRecordSchema = Type.Object({
  probeInstance: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.Number()),
  stream: Type.String(),
  ts: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  continuation: Type.String(),
  previousResponseId: Type.Boolean(),
  nativeSteering: Type.Optional(Type.Boolean()),
  fullInputItemCount: Type.Number(),
  sentInputItemCount: Type.Number(),
});

export type TransportProbeRecord = Static<typeof TransportProbeRecordSchema>;

const TransportProbeRegistrySchema = Type.Object({
  publish: Type.Function([TransportProbeRecordSchema], Type.Void()),
});

/** Validate at the process-global boundary and keep probe failures off the request path. */
export function publishTransportProbe(record: TransportProbeRecord): void {
  if (!Value.Check(TransportProbeRecordSchema, record)) return;
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    TRANSPORT_PROBE_SYMBOL,
  )?.value;
  if (!Value.Check(TransportProbeRegistrySchema, candidate)) return;
  try {
    candidate.publish(record);
  } catch {
    // The optional observer must never affect transport.
  }
}
