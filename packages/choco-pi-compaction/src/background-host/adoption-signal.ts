import type {
  CompactionEntry,
  CompactionEntryDraft,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { compile, obj } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { hasMethods, nonEmptyStr, readProperty } from "../guards.ts";

const NonEmptyString = nonEmptyStr();
const AdoptionIdentitySchema = obj(
  {
    candidateId: NonEmptyString,
    prefixFingerprint: NonEmptyString,
    ownerKey: NonEmptyString,
  },
  { open: true },
);
type AdoptionIdentity = Static<typeof AdoptionIdentitySchema>;
const isAdoptionIdentity = compile(AdoptionIdentitySchema).check;

export function readAdoptionIdentity(
  source: Pick<CompactionEntryDraft, "details">,
): AdoptionIdentity | undefined {
  const details = source.details;
  return isAdoptionIdentity(details) ? details : undefined;
}

export type AdoptionRoute = "boundary" | "host" | "recovered";

export interface BackgroundAdoptionNotice {
  readonly sessionId: string;
  readonly committedEntryId: string;
  readonly candidateId: string;
  readonly backendId: string;
  readonly route: AdoptionRoute;
}

export type BackgroundAdoptionListener = (
  notice: BackgroundAdoptionNotice,
  ctx: ExtensionContext,
) => void;

export interface BackgroundAdoptionOwner {
  willAdopt(event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(entry: CompactionEntry): boolean;
  adoptReady(ctx: ExtensionContext, onSettled: (adopted: boolean) => void): boolean;
}

export interface BackgroundAdoptionSignal {
  readonly version: 1;
  willAdopt(sessionId: string, event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(sessionId: string, entry: CompactionEntry): boolean;
  adoptReady(
    sessionId: string,
    ctx: ExtensionContext,
    onSettled: (adopted: boolean) => void,
  ): boolean;
  subscribe(listener: BackgroundAdoptionListener): () => void;
  registerOwner(sessionId: string, owner: BackgroundAdoptionOwner): () => void;
  publish(notice: BackgroundAdoptionNotice, ctx: ExtensionContext): void;
  nextGeneration(): number;
}

export const BACKGROUND_ADOPTION_SIGNAL_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-background-adoption",
);
const SIGNAL_METHODS = [
  "willAdopt",
  "isAdoption",
  "adoptReady",
  "subscribe",
  "registerOwner",
  "publish",
  "nextGeneration",
] as const;

function isAdoptionSignal<T>(value: T): value is T & BackgroundAdoptionSignal {
  return hasMethods(value, SIGNAL_METHODS) && readProperty(value, "version") === 1;
}

function unregisterOwner(
  owners: Map<string, BackgroundAdoptionOwner>,
  sessionId: string,
  owner: BackgroundAdoptionOwner,
): void {
  if (owners.get(sessionId) === owner) owners.delete(sessionId);
}

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

export function publishBackgroundAdoptionSignalSlot(): void {
  if (Object.getOwnPropertyDescriptor(globalThis, BACKGROUND_ADOPTION_SIGNAL_SYMBOL) !== undefined)
    return;
  getBackgroundAdoptionSignal();
}
