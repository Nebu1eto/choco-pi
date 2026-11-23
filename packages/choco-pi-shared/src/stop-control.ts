import { arr, bool, compile, int, lit, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

export const STOP_CONTROL_PROTOCOL = "choco-pi:stop-control/v1";
export const STOP_CONTROL_REGISTRY_KEY = Symbol.for(STOP_CONTROL_PROTOCOL);
export const STOP_CONTROL_REVOKE_CHANNEL = "choco-pi:stop-control/v1/revoke";
export const STOP_CONTROL_STOP_SHELLS_CHANNEL = "choco-pi:stop-control/v1/stop-shells";
export const STOP_CONTROL_REPORT_CHANNEL = "choco-pi:stop-control/v1/report";

export const ADMISSION_CLOSED_MESSAGE =
  "Agent admission is closed: the user stopped this session's work (/stop). Ask the user to run /resume-work.";

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
const isStopStateValue = compile(
  obj({ epoch: epochSchema(), closed: bool() }, { open: false }),
).check;

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

export const isStopReport = compile(
  obj(
    {
      requestId: str({ minLength: 1 }),
      participant: oneOf(["subagents", "shells", "goal"]),
      phase: oneOf(["acknowledged", "settled", "failed"]),
      counts: opt(
        obj(
          { agents: opt(epochSchema()), workflows: opt(epochSchema()), shells: opt(epochSchema()) },
          { open: false },
        ),
      ),
      ownerSessionIds: opt(arr(str({ minLength: 1 }))),
      retainedWorktrees: opt(arr(str({ minLength: 1 }))),
      detail: opt(str()),
    },
    { open: false },
  ),
).check;

interface RegistryCandidate {
  state?: unknown;
}

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
    return isStopStateValue(state) ? { epoch: state.epoch, closed: state.closed } : OPEN_STATE;
  } catch {
    return OPEN_STATE;
  }
}

export function isAdmissionOpen(rootSessionId: string | undefined): boolean {
  return rootSessionId === undefined || !readStopState(rootSessionId).closed;
}

export function requireAdmissionOpen(rootSessionId: string | undefined): void {
  if (!isAdmissionOpen(rootSessionId)) throw new Error(ADMISSION_CLOSED_MESSAGE);
}

export function mayTriggerTurn(
  rootSessionId: string | undefined,
  capturedEpoch: number | undefined,
): boolean {
  if (rootSessionId === undefined) return true;
  const state = readStopState(rootSessionId);
  if (state.closed) return false;
  return capturedEpoch === undefined || state.epoch === capturedEpoch;
}
