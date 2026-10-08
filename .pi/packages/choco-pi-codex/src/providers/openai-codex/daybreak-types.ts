import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";

export const DAYBREAK_BRIDGE_SYMBOL = Symbol.for("choco-pi.daybreak-state");
export type DaybreakSource = "default" | "explicit" | "inherited";
export type DaybreakOutcome =
  | "off"
  | "blue"
  | "red"
  | "not-granted"
  | "lookup-failed"
  | "model-not-supported"
  | "auth-not-eligible";
export type DaybreakState = Readonly<{
  sessionId: string;
  requested: boolean;
  source: DaybreakSource;
  revision: number;
  generation: number;
  outcome: DaybreakOutcome;
}>;
export type DaybreakInitialization = Readonly<{ requested: boolean; source: DaybreakSource }>;
export type DaybreakRegistration = Readonly<{
  sessionId: string;
  owner: object;
  generation: number;
  initial: DaybreakInitialization;
  entries?: readonly SessionEntry[];
  persist?: (state: DaybreakState) => void;
}>;
export type DaybreakController = Readonly<{
  getState(): DaybreakState;
  set(requested: boolean, source?: DaybreakSource): DaybreakState;
  report(outcome: DaybreakOutcome, revision: number): void;
  dispose(): void;
}>;
export type DaybreakBridge = Readonly<{
  version: 1;
  register(input: DaybreakRegistration): DaybreakController;
  get(sessionId: string): DaybreakController | undefined;
  createExtension(
    input: Omit<DaybreakRegistration, "sessionId" | "entries" | "persist">,
  ): ExtensionFactory;
}>;
export type CodexDaybreakDecision = Readonly<{
  sessionId: string;
  requested: boolean;
  source: DaybreakSource;
  revision: number;
  generation: number;
  outcome: DaybreakOutcome;
  cyber: "daybreak_blue" | "daybreak_red" | undefined;
}>;
