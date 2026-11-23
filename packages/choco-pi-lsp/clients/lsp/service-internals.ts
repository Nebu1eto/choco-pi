import type { LSPClientInfo } from "./client.ts";
import { createDiskBindingCache, type DiskBindingCache } from "./diagnostic-binding.ts";
import type { LSPDiagnosticsHealth, LSPState, LSPTouchClientScope } from "./service-types.ts";
import type { LSPService } from "./index.ts";

export interface LSPServiceInternals {
  readonly service: LSPService;
  state: LSPState;
  readonly workspaceProbeLogged: Set<string>;
  readonly projectBoundaryCache: Map<string, Promise<boolean>>;
  readonly warmStartLogged: Set<string>;
  readonly optionalFailureLogged: Set<string>;
  readonly unavailableLogged: Set<string>;
  readonly optionalDisabled: Set<string>;
  readonly failureCounts: Map<string, number>;
  readonly runtimeExitCounts: Map<string, number>;
  readonly runtimeExitWindow: Map<string, number[]>;
  readonly permanentlyBroken: Set<string>;
  readonly lastKnownDiagnostics: Map<string, import("./client.ts").LSPDiagnostic[]>;
  readonly lastKnownContentHash: Map<string, string>;
  readonly diskBindingCache: DiskBindingCache;
  readonly lastDiagnosticsHealth: Map<string, LSPDiagnosticsHealth>;
  readonly recentTouches: Map<
    string,
    { fingerprint: string; touchedAt: number; clientScope: LSPTouchClientScope }
  >;
  readonly notifyWriteBackpressureStreak: Map<string, number>;
  readonly auxNotifyInflight: Map<
    string,
    {
      client: LSPClientInfo;
      unacked: number;
      drain?: Promise<boolean>;
      gateOpen?: boolean;
      stallLogged?: boolean;
    }
  >;
  readonly outstandingAuxNotifyWrites: Map<
    string,
    {
      startedAt: number;
      client: LSPClientInfo;
      settled: Promise<void>;
      wedgeTimer: ReturnType<typeof setTimeout>;
    }
  >;
  readonly clientLastUsedAt: Map<string, number>;
  readonly clientLeases: Map<string, number>;
  readonly typeScriptIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  clientSpawnGate: Promise<void>;
  isDestroyed: boolean;
  generationHandoff: Promise<void> | undefined;
}

export function createLSPServiceInternals(
  service: LSPService,
  generationHandoff: Promise<void> | undefined,
): LSPServiceInternals {
  return {
    service,
    state: {
      clients: new Map(),
      servers: new Map(),
      broken: new Map(),
      inFlight: new Map(),
      clientSpawnedAt: new Map(),
      demonstratedReady: new Set(),
      demonstratedCold: new Set(),
    },
    workspaceProbeLogged: new Set<string>(),
    projectBoundaryCache: new Map<string, Promise<boolean>>(),
    warmStartLogged: new Set<string>(),
    optionalFailureLogged: new Set<string>(),
    unavailableLogged: new Set<string>(),
    optionalDisabled: new Set<string>(),
    failureCounts: new Map<string, number>(),
    runtimeExitCounts: new Map<string, number>(),
    runtimeExitWindow: new Map<string, number[]>(),
    permanentlyBroken: new Set<string>(),
    lastKnownDiagnostics: new Map<string, import("./client.ts").LSPDiagnostic[]>(),
    lastKnownContentHash: new Map<string, string>(),
    diskBindingCache: createDiskBindingCache(),
    lastDiagnosticsHealth: new Map<string, LSPDiagnosticsHealth>(),
    recentTouches: new Map<
      string,
      { fingerprint: string; touchedAt: number; clientScope: LSPTouchClientScope }
    >(),
    notifyWriteBackpressureStreak: new Map<string, number>(),
    auxNotifyInflight: new Map<
      string,
      {
        client: LSPClientInfo;
        unacked: number;
        drain?: Promise<boolean>;
        gateOpen?: boolean;
        stallLogged?: boolean;
      }
    >(),
    outstandingAuxNotifyWrites: new Map<
      string,
      {
        startedAt: number;
        client: LSPClientInfo;
        settled: Promise<void>;
        wedgeTimer: ReturnType<typeof setTimeout>;
      }
    >(),
    clientLastUsedAt: new Map<string, number>(),
    clientLeases: new Map<string, number>(),
    typeScriptIdleTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    clientSpawnGate: Promise.resolve(),
    isDestroyed: false,
    generationHandoff,
  };
}
