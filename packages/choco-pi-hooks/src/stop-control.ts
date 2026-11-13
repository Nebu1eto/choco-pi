import { arr, bool, compile, int, lit, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

/**
 * Package-local copy of the choco-pi stop-control v1 contract. The literal strings are the
 * interface shared with the coordinator and the other participants; do not import another
 * package's copy. Absent or malformed registries read as an open epoch 0.
 */
export const STOP_CONTROL_PROTOCOL = "choco-pi:stop-control/v1";
export const STOP_CONTROL_REGISTRY_KEY = Symbol.for(STOP_CONTROL_PROTOCOL);
export const STOP_CONTROL_REVOKE_CHANNEL = "choco-pi:stop-control/v1/revoke";
export const STOP_CONTROL_STOP_SHELLS_CHANNEL = "choco-pi:stop-control/v1/stop-shells";
export const STOP_CONTROL_REPORT_CHANNEL = "choco-pi:stop-control/v1/report";

export interface StopState {
  epoch: number;
  closed: boolean;
}

export interface RevokeRequest {
  requestId: string;
  rootSessionId: string;
  epoch: number;
  scope: "all" | "agent";
  agentRef?: string;
}

export interface StopShellsRequest {
  requestId: string;
  rootSessionId: string;
  epoch: number;
  ownerSessionIds: string[];
}

export interface StopReport {
  requestId: string;
  participant: "subagents" | "shells" | "goal";
  phase: "acknowledged" | "settled" | "failed";
  counts?: { agents?: number; workflows?: number; shells?: number };
  ownerSessionIds?: string[];
  retainedWorktrees?: string[];
  detail?: string;
}

const OPEN_STATE: StopState = { epoch: 0, closed: false };

const epochSchema = () => int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const isStopRegistry = compile(obj({ protocol: lit(STOP_CONTROL_PROTOCOL) }, { open: true })).check;
const isStopState = compile(obj({ epoch: epochSchema(), closed: bool() }, { open: false })).check;

export const isRevokeRequest = compile(
  obj(
    {
      requestId: str({ minLength: 1 }),
      rootSessionId: str({ minLength: 1 }),
      epoch: epochSchema(),
      scope: oneOf(["all", "agent"]),
      agentRef: opt(str()),
    },
    { open: false },
  ),
).check;

export const isStopShellsRequest = compile(
  obj(
    {
      requestId: str({ minLength: 1 }),
      rootSessionId: str({ minLength: 1 }),
      epoch: epochSchema(),
      ownerSessionIds: arr(str({ minLength: 1 })),
    },
    { open: false },
  ),
).check;

interface RegistryCandidate {
  state?: unknown;
}

/** Read the coordinator's state for one root session; never throws. */
export function readStopState(rootSessionId: string): StopState {
  const entry: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    STOP_CONTROL_REGISTRY_KEY,
  )?.value;
  if (!isStopRegistry(entry)) return OPEN_STATE;
  const candidate: RegistryCandidate = Object(entry);
  const probe = candidate.state;
  if (!(probe instanceof Function)) return OPEN_STATE;
  try {
    const state: unknown = probe.call(candidate, rootSessionId);
    return isStopState(state) ? { epoch: state.epoch, closed: state.closed } : OPEN_STATE;
  } catch {
    return OPEN_STATE;
  }
}

/** Work authorised at `capturedEpoch` may trigger a turn only while the same epoch stays open. */
export function mayTriggerTurn(rootSessionId: string, capturedEpoch: number): boolean {
  const state = readStopState(rootSessionId);
  return !state.closed && state.epoch === capturedEpoch;
}
