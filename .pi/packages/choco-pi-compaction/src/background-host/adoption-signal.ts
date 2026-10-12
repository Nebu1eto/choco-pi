import type {
  CompactionEntry,
  CompactionEntryDraft,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Process-global adoption signal (consumed by goal, hooks and the context cap)
// ---------------------------------------------------------------------------

const NonEmptyString = Type.String({ minLength: 1 });
const AdoptionIdentitySchema = Type.Object(
  {
    candidateId: NonEmptyString,
    prefixFingerprint: NonEmptyString,
    ownerKey: NonEmptyString,
  },
  { additionalProperties: true },
);
type AdoptionIdentity = Static<typeof AdoptionIdentitySchema>;

/** Coordinator-owned identity carried by every adopted checkpoint's details. */
export function readAdoptionIdentity(
  source: Pick<CompactionEntryDraft, "details">,
): AdoptionIdentity | undefined {
  const details = source.details;
  return Value.Check(AdoptionIdentitySchema, details) ? details : undefined;
}

/** How a committed adoption reached the session. */
export type AdoptionRoute = "boundary" | "host" | "recovered";

export interface BackgroundAdoptionNotice {
  readonly sessionId: string;
  readonly committedEntryId: string;
  readonly candidateId: string;
  readonly backendId: string;
  /**
   * "boundary" commits emit no host compaction event; "host" commits arrived
   * through a real session_before_compact/session_compact pair; "recovered"
   * commits were found on reload and already happened in an earlier process.
   */
  readonly route: AdoptionRoute;
}

export type BackgroundAdoptionListener = (
  notice: BackgroundAdoptionNotice,
  ctx: ExtensionContext,
) => void;

/** One owned main session, as seen by consumers. */
export interface BackgroundAdoptionOwner {
  willAdopt(event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(entry: CompactionEntry): boolean;
  adoptReady(ctx: ExtensionContext, onSettled: (adopted: boolean) => void): boolean;
}

export interface BackgroundAdoptionSignal {
  readonly version: 1;
  /** Whether this session_before_compact is answered by a background adoption (memoized per event). */
  willAdopt(sessionId: string, event: SessionBeforeCompactEvent): Promise<boolean>;
  /** Whether a committed compaction entry is a background adoption proposed in this process. */
  isAdoption(sessionId: string, entry: CompactionEntry): boolean;
  /** Start idle adoption of a ready candidate; false when none can be adopted now. */
  adoptReady(
    sessionId: string,
    ctx: ExtensionContext,
    onSettled: (adopted: boolean) => void,
  ): boolean;
  /** Committed adoptions, delivered once per adoption after commit. */
  subscribe(listener: BackgroundAdoptionListener): () => void;
  registerOwner(sessionId: string, owner: BackgroundAdoptionOwner): () => void;
  publish(notice: BackgroundAdoptionNotice, ctx: ExtensionContext): void;
  /** Process-unique owner generation, shared across extension reloads. */
  nextGeneration(): number;
}

export const BACKGROUND_ADOPTION_SIGNAL_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-background-adoption",
);
const SignalCallable = Type.Function([], Type.Unknown());
const SignalSlotSchema = Type.Object({
  version: Type.Literal(1),
  willAdopt: SignalCallable,
  isAdoption: SignalCallable,
  adoptReady: SignalCallable,
  subscribe: SignalCallable,
  registerOwner: SignalCallable,
  publish: SignalCallable,
  nextGeneration: SignalCallable,
});

function isAdoptionSignal<T>(value: T): value is T & BackgroundAdoptionSignal {
  return Value.Check(SignalSlotSchema, value);
}

function unregisterOwner(
  owners: Map<string, BackgroundAdoptionOwner>,
  sessionId: string,
  owner: BackgroundAdoptionOwner,
): void {
  if (owners.get(sessionId) === owner) owners.delete(sessionId);
}

/** Deliver to every listener; the first listener failure is rethrown after all ran. */
function deliverNotice(
  listeners: ReadonlySet<BackgroundAdoptionListener>,
  notice: BackgroundAdoptionNotice,
  ctx: ExtensionContext,
): void {
  let failure: { readonly cause: unknown } | undefined;
  for (const listener of listeners) {
    try {
      listener(notice, ctx);
    } catch (cause) {
      failure ??= { cause };
    }
  }
  if (failure) throw failure.cause;
}

function createAdoptionSignal(): BackgroundAdoptionSignal {
  const owners = new Map<string, BackgroundAdoptionOwner>();
  const listeners = new Set<BackgroundAdoptionListener>();
  let generation = 0;
  return {
    version: 1,
    async willAdopt(sessionId, event) {
      const owner = owners.get(sessionId);
      return owner === undefined ? false : (await owner.willAdopt(event)) === true;
    },
    isAdoption(sessionId, entry) {
      return owners.get(sessionId)?.isAdoption(entry) === true;
    },
    adoptReady(sessionId, ctx, onSettled) {
      return owners.get(sessionId)?.adoptReady(ctx, onSettled) === true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerOwner(sessionId, owner) {
      owners.set(sessionId, owner);
      return () => unregisterOwner(owners, sessionId, owner);
    },
    publish(notice, ctx) {
      deliverNotice(listeners, notice, ctx);
    },
    nextGeneration() {
      generation += 1;
      return generation;
    },
  };
}

/** The process-wide signal; a foreign or corrupt slot is refused, not replaced. */
export function getBackgroundAdoptionSignal(): BackgroundAdoptionSignal {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, BACKGROUND_ADOPTION_SIGNAL_SYMBOL);
  const found: unknown = descriptor?.value;
  if (descriptor !== undefined) {
    if (!isAdoptionSignal(found)) throw new Error("Invalid background adoption signal slot");
    return found;
  }
  const signal = createAdoptionSignal();
  Object.defineProperty(globalThis, BACKGROUND_ADOPTION_SIGNAL_SYMBOL, {
    value: signal,
    configurable: true,
  });
  return signal;
}

/**
 * Create the slot during extension registration: consumers loaded earlier
 * (goal, hooks) resolve it in their own session_start, which the host runs
 * only after every extension factory has returned. A foreign slot is left for
 * getBackgroundAdoptionSignal() to refuse on the session path.
 */
export function publishBackgroundAdoptionSignalSlot(): void {
  if (Object.getOwnPropertyDescriptor(globalThis, BACKGROUND_ADOPTION_SIGNAL_SYMBOL) !== undefined)
    return;
  getBackgroundAdoptionSignal();
}
