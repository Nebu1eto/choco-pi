import { Type, type Static } from "typebox";
import {
  VERSION,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  checkHarness,
  type Capability,
  type HarnessOptions,
  type HarnessReport,
} from "../skills/check/scripts/check-harness.ts";
import { captureHostIdentity, type CapturedHostIdentity } from "./lib/pi-runtime-identity.ts";

type HarnessCheckInput = {
  mode: "full" | "automatic";
  required_capabilities?: readonly Capability[];
};

const harnessCheckParameters = Type.Object({
  mode: Type.Union([Type.Literal("automatic"), Type.Literal("full")]),
  required_capabilities: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("tui"),
        Type.Literal("subagents"),
        Type.Literal("resources"),
        Type.Literal("lsp"),
      ]),
      { uniqueItems: true },
    ),
  ),
});

type HarnessCheckTool = ToolDefinition<typeof harnessCheckParameters, HarnessReport>;
type HarnessCheckToolResult = Awaited<ReturnType<HarnessCheckTool["execute"]>> & {
  isError: boolean;
};
type HarnessLifecycleContext = {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};
type EventHandler<TEvent> = (
  event: TEvent,
  context: HarnessLifecycleContext,
) => Promise<void> | void;
type RegisteredHarnessCheckTool = Omit<HarnessCheckTool, "execute"> & {
  execute: (
    toolCallId: string,
    params: Static<typeof harnessCheckParameters>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: HarnessLifecycleContext,
  ) => Promise<HarnessCheckToolResult>;
};

export type HarnessCheckRegistration = {
  registerHarnessCheckTool: (tool: RegisteredHarnessCheckTool) => void;
  onSessionStart: (handler: EventHandler<SessionStartEvent>) => void;
  onSessionShutdown: (handler: EventHandler<SessionShutdownEvent>) => void;
  onSessionTree: (handler: EventHandler<SessionTreeEvent>) => void;
  checkHarness?: (options: HarnessOptions) => Promise<HarnessReport>;
};

export type HarnessCheckExecutionDependencies = {
  capture: () => CapturedHostIdentity;
  currentOwner: () => CapturedHostIdentity["owner"];
  check: (options: HarnessOptions) => Promise<HarnessReport>;
};

function sameOwner(
  left: CapturedHostIdentity["owner"],
  right: CapturedHostIdentity["owner"],
): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

export async function executeHarnessCheck(
  input: HarnessCheckInput,
  signal: AbortSignal | undefined,
  dependencies: HarnessCheckExecutionDependencies,
): Promise<HarnessReport> {
  const identity = dependencies.capture();
  if (signal?.aborted) throw new Error("harness check cancelled");
  const report = await dependencies.check({
    mode: input.mode,
    requiredCapabilities: input.required_capabilities,
    nodeVersion: identity.nodeVersion,
    runtimeIdentity: identity.runtime,
    signal,
  });
  if (signal?.aborted) throw new Error("harness check cancelled");
  if (!sameOwner(identity.owner, dependencies.currentOwner())) {
    throw new Error("harness check result is stale because the session changed");
  }
  return report;
}

function isTestRegistration(
  host: ExtensionAPI | HarnessCheckRegistration,
): host is HarnessCheckRegistration {
  return "registerHarnessCheckTool" in host;
}

export default function harnessCheckExtension(host: ExtensionAPI | HarnessCheckRegistration): void {
  const registration: HarnessCheckRegistration = isTestRegistration(host)
    ? host
    : {
        registerHarnessCheckTool: (tool) => host.registerTool(tool),
        onSessionStart: (handler) => {
          host.on("session_start", handler);
        },
        onSessionShutdown: (handler) => {
          host.on("session_shutdown", handler);
        },
        onSessionTree: (handler) => {
          host.on("session_tree", handler);
        },
      };
  let generation = 0;
  let sessionId = "uninitialized";

  registration.onSessionStart((_event, context) => {
    generation += 1;
    sessionId = context.sessionManager.getSessionId();
  });
  registration.onSessionShutdown(() => {
    generation += 1;
    sessionId = "shutdown";
  });
  registration.onSessionTree((_event, context) => {
    generation += 1;
    sessionId = context.sessionManager.getSessionId();
  });

  const owner = (): CapturedHostIdentity["owner"] => ({ sessionId, generation });

  registration.registerHarnessCheckTool({
    name: "harness_check",
    label: "Harness Check",
    description:
      "Check this active Pi host and repository harness readiness without installs, configuration writes, shell startup, or provider calls.",
    promptSnippet: "Check active-host harness readiness with trustworthy runtime provenance.",
    parameters: harnessCheckParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, context) => {
      const executionOwner = {
        sessionId: context.sessionManager.getSessionId(),
        generation,
      };
      const report = await executeHarnessCheck(params, signal, {
        capture: () =>
          captureHostIdentity({
            version: VERSION,
            packageDir: getPackageDir(),
            nodeVersion: process.version,
            owner: executionOwner,
          }),
        currentOwner: owner,
        check: registration.checkHarness ?? checkHarness,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        details: report,
        isError: report.status === "fail",
      };
    },
  });
}
