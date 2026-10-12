import {
  getBackgroundAdoptionSignal,
  type BackgroundAdoptionNotice,
  type BackgroundAdoptionListener,
} from "../../../.pi/packages/choco-pi-compaction/src/index.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Recorder } from "./artifacts.ts";
import type { ConsumerNotice } from "./consumer-probe.ts";
export interface SignalNotice {
  notice: BackgroundAdoptionNotice;
  evidenceRef: number;
}

type AdoptionSignal = ReturnType<typeof getBackgroundAdoptionSignal>;

/** The consumer-relay record fields that identify one adoption. */
const RelayRecordSchema = Type.Object(
  { adoptionId: Type.String(), candidateId: Type.String(), committedEntryId: Type.String() },
  { additionalProperties: true },
);

/**
 * Classify a subscriber by the package frame on its registration stack. The
 * caller captures the stack so this helper adds no frame to it.
 */
function classifySubscriber(stack: string) {
  const source =
    stack.split("\n").find((line) => /choco-pi-(goal|hooks)\//u.test(line)) ??
    "unclassified public signal subscriber";
  let consumer = "signal-unclassified";
  if (source.includes("choco-pi-goal/")) consumer = "goal";
  else if (source.includes("choco-pi-hooks/")) consumer = "hooks";
  return { consumer, source };
}

/** The relay's adoption ID for a notice, or a notice-derived one when no relay record matches. */
function relayAdoptionId(recorder: Recorder, notice: BackgroundAdoptionNotice): string {
  const relay = recorder.records.findLast(
    (record) =>
      record.kind === "consumer-invoked" &&
      Value.Check(RelayRecordSchema, record.data) &&
      record.data.candidateId === notice.candidateId &&
      record.data.committedEntryId === notice.committedEntryId,
  );
  return relay && Value.Check(RelayRecordSchema, relay.data)
    ? relay.data.adoptionId
    : `${notice.sessionId}:${notice.committedEntryId}:${notice.candidateId}`;
}

/** Record one consumer invocation of a public signal notice. */
function recordConsumerInvocation(
  recorder: Recorder,
  consumers: ConsumerNotice[],
  consumer: string,
  notice: BackgroundAdoptionNotice,
): void {
  const adoptionId = relayAdoptionId(recorder, notice);
  const evidenceRef = recorder.record("signal-consumer-invoked", {
    consumer,
    adoptionId,
    ...notice,
  });
  consumers.push({
    consumer,
    adoptionId,
    candidateId: notice.candidateId,
    committedEntryId: notice.committedEntryId,
    evidenceRef,
  });
}

/** Put back the signal's own `subscribe` unless someone replaced the probe's wrapper. */
function restoreSubscribe(
  signal: AdoptionSignal,
  wrapped: AdoptionSignal["subscribe"],
  previousDescriptor: PropertyDescriptor | undefined,
): void {
  if (signal.subscribe !== wrapped) return;
  if (previousDescriptor) Object.defineProperty(signal, "subscribe", previousDescriptor);
  else Reflect.deleteProperty(signal, "subscribe");
}

/** Wrap the public signal without scheduling an extra microtask or changing listener returns. */
export function installAdoptionProbe(recorder: Recorder) {
  const signal = getBackgroundAdoptionSignal();
  const originalSubscribe = signal.subscribe;
  const previousDescriptor = Object.getOwnPropertyDescriptor(signal, "subscribe");
  const releases: (() => void)[] = [];
  const notices: SignalNotice[] = [];
  const consumers: ConsumerNotice[] = [];
  const registrations: { consumer: string; source: string }[] = [];
  let current = true;
  const wrappedSubscribe = (listener: BackgroundAdoptionListener): (() => void) => {
    if (!current) throw new Error("Adoption probe disposed");
    const { consumer, source } = classifySubscriber(new Error().stack ?? "");
    registrations.push({ consumer, source });
    recorder.record("signal-consumer-registration", { consumer, source });
    const release = originalSubscribe.call(signal, (notice, ctx) => {
      if (!current) throw new Error("Signal reached disposed adoption probe");
      recordConsumerInvocation(recorder, consumers, consumer, notice);
      return listener(notice, ctx);
    });
    releases.push(release);
    return release;
  };
  signal.subscribe = wrappedSubscribe;
  const releaseObserver = originalSubscribe.call(signal, (notice) => {
    if (!current) throw new Error("Signal reached disposed observer");
    const evidenceRef = recorder.record("background-adoption-signal", { ...notice });
    notices.push({ notice: { ...notice }, evidenceRef });
  });
  return {
    notices,
    consumers,
    registrations,
    dispose() {
      if (!current) return;
      current = false;
      releaseObserver();
      for (const release of releases) release();
      restoreSubscribe(signal, wrappedSubscribe, previousDescriptor);
    },
  };
}
