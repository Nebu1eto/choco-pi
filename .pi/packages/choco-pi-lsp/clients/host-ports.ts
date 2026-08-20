/** Host-neutral capabilities available to the choco-pi-lsp engine (#1358 S2). */

import type { ExtensionLogEntry } from "./extension-log.js";
import type { ExtensionRunMode } from "./extension-mode.js";
import type { ProjectTrustState } from "./project-trust.js";
import type { UserNotifyLevel } from "./user-notify.js";

export type HostLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | HostLogValue[]
  | { [key: string]: HostLogValue };
export type HostLogSink = (entry: Record<string, HostLogValue>) => void;

export interface HostPorts {
  readonly notify: {
    user(message: string, level?: UserNotifyLevel): void;
  };
  readonly trust: {
    isProjectTrusted(): ProjectTrustState;
  };
  readonly mode: {
    current(): ExtensionRunMode;
    supportsTuiWidget(): boolean;
    suppressesUserNotify(): boolean;
  };
  readonly log: {
    extension(entry: ExtensionLogEntry): void;
    debug(message: string, metadata?: Record<string, HostLogValue>): void;
    sink(subsystem: string): HostLogSink;
  };
  readonly emit: {
    /**
     * Every `pi.events` publish, including the `choco-pi-lsp/*` producer family
     * (clients/lsp-events.ts). A separate `.lens` port existed briefly but
     * was never wired to anything but this same `emit` function — removed
     * as vestigial (#1415 review) rather than kept as a distinction with no
     * behavioral difference.
     */
    bus<T>(channel: string, payload: T): void;
  };
  readonly status: {
    set(name: string, value: string): void;
  };
  readonly spawn: {
    abortSignal(): AbortSignal | undefined;
    isAllowed(context: string): boolean;
  };
  readonly render: {
    invalidate(): void;
  };
  readonly session: {
    id(): string | undefined;
  };
  readonly workspace: {
    cwd(): string | undefined;
    projectRoot(): string | undefined;
  };
  readonly flags: {
    get(name: string, filePath?: string): string | boolean | undefined;
  };
  readonly tools: {
    has(name: string): Promise<boolean>;
    getActive(): string[];
    setActive(names: string[]): void;
  };
}

export type HostPortsOverrides = {
  [K in keyof HostPorts]?: Partial<HostPorts[K]>;
};

/**
 * Headless/test implementation. Its feature-detection defaults deliberately
 * match the pre-ports absent-host paths: unknown trust/mode, fail-open spawn,
 * and no-op delivery surfaces.
 */
export function createDefaultHostPorts(overrides: HostPortsOverrides = {}): HostPorts {
  const unknownMode = (): ExtensionRunMode => "unknown";
  const defaults: HostPorts = {
    notify: { user: () => {} },
    trust: { isProjectTrusted: () => "unknown" },
    mode: {
      current: unknownMode,
      supportsTuiWidget: () => true,
      suppressesUserNotify: () => false,
    },
    log: { extension: () => {}, debug: () => {}, sink: () => () => {} },
    emit: { bus: () => {} },
    status: { set: () => {} },
    spawn: { abortSignal: () => undefined, isAllowed: () => true },
    render: { invalidate: () => {} },
    session: { id: () => undefined },
    workspace: { cwd: () => undefined, projectRoot: () => undefined },
    flags: { get: () => undefined },
    tools: { has: async () => false, getActive: () => [], setActive: () => {} },
  };
  return {
    notify: { ...defaults.notify, ...overrides.notify },
    trust: { ...defaults.trust, ...overrides.trust },
    mode: { ...defaults.mode, ...overrides.mode },
    log: { ...defaults.log, ...overrides.log },
    emit: { ...defaults.emit, ...overrides.emit },
    status: { ...defaults.status, ...overrides.status },
    spawn: { ...defaults.spawn, ...overrides.spawn },
    render: { ...defaults.render, ...overrides.render },
    session: { ...defaults.session, ...overrides.session },
    workspace: { ...defaults.workspace, ...overrides.workspace },
    flags: { ...defaults.flags, ...overrides.flags },
    tools: { ...defaults.tools, ...overrides.tools },
  };
}
