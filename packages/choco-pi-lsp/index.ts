import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TURN_SUMMARY_CUSTOM_TYPE } from "./clients/turn-summary.ts";
import { renderTurnSummaryMessage } from "./clients/turn-summary-render.ts";

type HostTool = Parameters<ExtensionAPI["registerTool"]>[0];
type HostCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type HostCommandHandler = HostCommand["handler"];
type HostFlag = Parameters<ExtensionAPI["registerFlag"]>[1];
interface DeferredEvent {
  readonly __chocoPiLspEventBrand?: never;
}

interface DeferredContext {
  readonly __chocoPiLspContextBrand?: never;
}

type DeferredEventResult = object | void;
type DeferredEventHandler = (
  event: DeferredEvent,
  ctx: DeferredContext,
) => DeferredEventResult | Promise<DeferredEventResult>;

interface ManifestTool {
  metadata: Omit<HostTool, "execute" | "renderCall" | "renderResult">;
  functionKeys: string[];
}

interface ManifestCommand {
  name: string;
  metadata: Omit<HostCommand, "handler">;
  functionKeys: string[];
}

interface ManifestFlag {
  name: string;
  options: HostFlag;
}

interface ManifestSchemaMetadata {
  toolName: string;
  path: Array<string | number>;
  key: string;
  value: string | boolean;
}

interface RegistrationManifest {
  tools: ManifestTool[];
  commands: ManifestCommand[];
  events: string[];
  flags: ManifestFlag[];
  renderers: string[];
  schemaMetadata: ManifestSchemaMetadata[];
}

interface CapturedRuntime {
  tools: Map<string, HostTool>;
  commands: Map<string, HostCommandHandler>;
  events: Map<string, DeferredEventHandler>;
}

// SAFETY: This vendored manifest is generated from the runtime's own registration calls and verified by the registration-identity fixture.
const manifest = JSON.parse(
  readFileSync(new URL("./registration-manifest.json", import.meta.url), "utf8"),
) as RegistrationManifest;

function restoreRegistrationSchemaMetadata(registration: RegistrationManifest): void {
  const tools = new Map(registration.tools.map((tool) => [tool.metadata.name, tool]));
  for (const metadata of registration.schemaMetadata) {
    const tool = tools.get(metadata.toolName);
    if (!tool) throw new Error(`Missing registration metadata for ${metadata.toolName}`);
    let target: object = tool.metadata.parameters;
    for (const segment of metadata.path) {
      const next = Object.getOwnPropertyDescriptor(target, segment)?.value;
      if (next === null || Object(next) !== next) {
        throw new Error(`Invalid registration schema path for ${metadata.toolName}`);
      }
      // SAFETY: The object identity check above proves this schema path segment is an object before traversal continues.
      target = next as object;
    }
    Object.defineProperty(target, metadata.key, {
      value: metadata.value,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
}

restoreRegistrationSchemaMetadata(manifest);

async function captureRuntime(pi: ExtensionAPI): Promise<CapturedRuntime> {
  const tools = new Map<string, HostTool>();
  const commands = new Map<string, HostCommandHandler>();
  const events = new Map<string, DeferredEventHandler>();
  // SAFETY: runtimePi inherits the live host API and replaces only registration methods with signature-compatible collectors.
  const runtimePi = Object.create(pi) as ExtensionAPI;

  Object.defineProperties(runtimePi, {
    registerTool: {
      value(candidate: HostTool): void {
        tools.set(candidate.name, candidate);
      },
    },
    registerCommand: {
      value(name: string, options: HostCommand): void {
        commands.set(name, options.handler);
      },
    },
    registerFlag: { value(): void {} },
    registerMessageRenderer: { value(): void {} },
    on: {
      value(channel: string, handler: DeferredEventHandler): void {
        events.set(channel, handler);
      },
    },
  });

  const runtimeExtension = await import("./runtime-extension.ts");
  await runtimeExtension.default(runtimePi);
  return { tools, commands, events };
}

function requireRuntimeTool(runtime: CapturedRuntime, name: string): HostTool {
  const tool = runtime.tools.get(name);
  if (!tool) throw new Error(`choco-pi-lsp runtime did not register tool ${name}`);
  return tool;
}

export default function chocoPiLspExtension(pi: ExtensionAPI): void {
  let runtime: CapturedRuntime | undefined;
  let runtimePromise: Promise<CapturedRuntime> | undefined;
  const getRuntime = (): Promise<CapturedRuntime> => {
    runtimePromise ??= captureRuntime(pi).then((captured) => {
      runtime = captured;
      return captured;
    });
    return runtimePromise;
  };

  for (const flag of manifest.flags) {
    pi.registerFlag(flag.name, flag.options);
  }

  for (const command of manifest.commands) {
    pi.registerCommand(command.name, {
      ...command.metadata,
      async handler(...args: Parameters<HostCommandHandler>) {
        const captured = await getRuntime();
        const handler = captured.commands.get(command.name);
        if (!handler) {
          throw new Error(`choco-pi-lsp runtime did not register command ${command.name}`);
        }
        return handler(...args);
      },
    });
  }

  for (const item of manifest.tools) {
    const name = item.metadata.name;
    const tool: HostTool = {
      ...item.metadata,
      async execute(...args: Parameters<HostTool["execute"]>) {
        const captured = await getRuntime();
        return requireRuntimeTool(captured, name).execute(...args);
      },
    };
    if (item.functionKeys.includes("renderCall")) {
      tool.renderCall = (...args: Parameters<NonNullable<HostTool["renderCall"]>>) => {
        const renderCall = runtime?.tools.get(name)?.renderCall;
        if (!renderCall) {
          void getRuntime();
          throw new Error(`choco-pi-lsp runtime renderer for ${name} is not ready`);
        }
        return renderCall(...args);
      };
    }
    if (item.functionKeys.includes("renderResult")) {
      tool.renderResult = (...args: Parameters<NonNullable<HostTool["renderResult"]>>) => {
        const renderResult = runtime?.tools.get(name)?.renderResult;
        if (!renderResult) {
          void getRuntime();
          throw new Error(`choco-pi-lsp runtime renderer for ${name} is not ready`);
        }
        return renderResult(...args);
      };
    }
    try {
      pi.registerTool(tool);
    } catch {
      // Another extension already registered this literal tool name.
    }
  }

  // SAFETY: Every manifest channel was captured from this extension's own pi.on calls; the proxy forwards the same event/context pair.
  const registerEvent = pi.on.bind(pi) as (channel: string, handler: DeferredEventHandler) => void;
  for (const channel of manifest.events) {
    registerEvent(channel, async (event, ctx) => {
      const captured = await getRuntime();
      const handler = captured.events.get(channel);
      if (!handler) throw new Error(`choco-pi-lsp runtime did not register ${channel}`);
      return handler(event, ctx);
    });
  }

  if (
    pi.registerMessageRenderer instanceof Function &&
    manifest.renderers.includes(TURN_SUMMARY_CUSTOM_TYPE)
  ) {
    pi.registerMessageRenderer(TURN_SUMMARY_CUSTOM_TYPE, renderTurnSummaryMessage);
  }
}
