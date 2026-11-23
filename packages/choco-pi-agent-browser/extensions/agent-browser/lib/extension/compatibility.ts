import {
  COMMAND_VALUE_FLAGS,
  GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
  GLOBAL_VALUE_FLAGS,
} from "../argv-grammar.ts";
import {
  extractCommandTokens,
  findCommandStartIndex,
  parseCommandInfoFromTokens,
} from "../argv-descriptor.ts";
import { normalizeCommandName } from "../command-taxonomy.ts";
import type {
  AgentBrowserCapability,
  AgentBrowserCompatibilityProfile,
} from "../compatibility-contract.ts";
import { hasRuntimeType, isRecord } from "../parsing.ts";
import { runAgentBrowserProcess } from "../process.ts";
import { parseBatchCommandArgument, parseUserBatchStdin } from "../orchestration/batch-stdin.ts";
import { resolveAgentBrowserCompatibility } from "../upstream-version.ts";
import type { WebMcpOwner } from "../webmcp-policy.ts";
export type BashToolCallLike = {
  input: { command: string };
  toolName: "bash";
};

export function isBashToolCallEvent<Event>(event: Event): event is Event & BashToolCallLike {
  if (!isRecord(event) || event.toolName !== "bash" || !isRecord(event.input)) return false;
  return hasRuntimeType(event.input.command, "string");
}

const CAPABILITY_FLAG_REQUIREMENTS = new Map<string, AgentBrowserCapability>([
  ["--ca-cert", "custom-ca-trust"],
  ["--contact-sheet", "recording-contact-sheet"],
  ["--contact-sheet-threshold", "recording-contact-sheet"],
  ["--cursor", "recording-cursor"],
  ["--delta", "delta-snapshot"],
  ["--fps", "recording-fps"],
  ["--if-changed", "screenshot-if-changed"],
  ["--input-mode", "input-mode"],
  ["--no-ca-cert", "custom-ca-trust"],
  ["--no-webmcp", "webmcp"],
  ["--threshold", "screenshot-if-changed"],
]);

const CAPABILITY_FLAG_COMMANDS = new Map<string, ReadonlySet<string> | undefined>([
  ["--ca-cert", undefined],
  ["--contact-sheet", new Set(["record"])],
  ["--contact-sheet-threshold", new Set(["record"])],
  ["--cursor", new Set(["record"])],
  ["--delta", new Set(["snapshot"])],
  ["--fps", new Set(["record"])],
  ["--if-changed", new Set(["screenshot"])],
  ["--input-mode", undefined],
  ["--no-ca-cert", undefined],
  ["--no-webmcp", undefined],
  ["--threshold", new Set(["screenshot"])],
]);

const CAPABILITY_VALUE_FLAGS = new Set<string>([...GLOBAL_VALUE_FLAGS, ...COMMAND_VALUE_FLAGS]);

function inspectCapabilityCommand(
  tokens: readonly string[],
  requested: Set<AgentBrowserCapability>,
): void {
  const args = [...tokens];
  const commandStartIndex = findCommandStartIndex(args);
  const commandInfo = parseCommandInfoFromTokens(extractCommandTokens(args));
  const command = normalizeCommandName(commandInfo.command);
  if (commandStartIndex !== undefined && command === "webmcp") requested.add("webmcp");
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") break;
    const flag = token.split("=", 1)[0] ?? token;
    const capability = CAPABILITY_FLAG_REQUIREMENTS.get(flag);
    const acceptedCommands = CAPABILITY_FLAG_COMMANDS.get(flag);
    if (
      capability &&
      (acceptedCommands === undefined || (command !== undefined && acceptedCommands.has(command)))
    )
      requested.add(capability);
    if (!token.includes("=") && CAPABILITY_VALUE_FLAGS.has(flag)) index += 1;
    else if (
      !token.includes("=") &&
      GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(flag) &&
      ["true", "false"].includes(args[index + 1] ?? "")
    )
      index += 1;
  }
}

export function getRequestedAgentBrowserCapabilities(
  args: readonly string[],
  stdin?: string,
): AgentBrowserCapability[] {
  const requested = new Set<AgentBrowserCapability>();
  const commandTokens = extractCommandTokens([...args]);
  if (commandTokens[0] === "batch") {
    for (const command of commandTokens.slice(1)) {
      if (command === "--bail") continue;
      const parsed = parseBatchCommandArgument(command);
      if (parsed.step) inspectCapabilityCommand(parsed.step, requested);
    }
  } else {
    inspectCapabilityCommand(args, requested);
  }
  if (stdin) {
    const parsed = parseUserBatchStdin(stdin);
    if (parsed.steps) {
      for (const step of parsed.steps) inspectCapabilityCommand(step, requested);
    } else {
      for (const statement of stdin.split(/\r?\n/u)) {
        const command = parseBatchCommandArgument(statement);
        if (command.step) inspectCapabilityCommand(command.step, requested);
      }
    }
  }
  return [...requested];
}

export function getUnsupportedCapabilityError(
  profile: AgentBrowserCompatibilityProfile | undefined,
  args: readonly string[],
  stdin?: string,
): string | undefined {
  if (!profile?.detectedVersion) return undefined;
  const unsupported = getRequestedAgentBrowserCapabilities(args, stdin).filter(
    (capability) => profile.capabilities[capability] === "unsupported",
  );
  return unsupported.length === 0
    ? undefined
    : `agent-browser ${profile.detectedVersion} does not support the requested capability: ${unsupported.join(", ")}. Upgrade agent-browser or omit that operation-specific option.`;
}

export async function probeAgentBrowserCompatibility(options: {
  fingerprint: NonNullable<AgentBrowserCompatibilityProfile["executable"]>;
  runVersion: () => Promise<Awaited<ReturnType<typeof runAgentBrowserProcess>>>;
  signal?: AbortSignal;
}): Promise<AgentBrowserCompatibilityProfile | undefined> {
  if (options.signal?.aborted) return undefined;
  const probe = await options.runVersion();
  if (options.signal?.aborted || probe.spawnError || probe.exitCode !== 0 || probe.timedOut)
    return undefined;
  return {
    ...resolveAgentBrowserCompatibility(probe.stdout),
    executable: options.fingerprint,
  };
}

export function getOptionValue(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) return args[index + 1];
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

export function getWebMcpOwner(options: {
  args: readonly string[];
  generation: number;
  namespace?: string;
  session: string;
}): WebMcpOwner {
  return {
    frame: getOptionValue(options.args, "--frame"),
    generation: options.generation,
    namespace: options.namespace,
    session: options.session,
  };
}

export function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function hasArgvFlag(argv: readonly string[], longFlag: string, shortFlag: string): boolean {
  return argv.includes(longFlag) || argv.includes(shortFlag);
}

export function shouldIncludeProjectConfig(
  ctx: { isProjectTrusted?: () => boolean } | undefined,
  argv: readonly string[] = process.argv,
): boolean {
  if (hasArgvFlag(argv, "--no-approve", "-na")) return false;
  return ctx?.isProjectTrusted?.() ?? true;
}
