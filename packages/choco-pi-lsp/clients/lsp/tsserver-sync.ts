import { bool, obj, opt, str, unknown, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "./schema-guards.ts";
import type { LSPDiagnostic } from "./client.ts";
import { logLatency } from "../latency-logger.ts";
import { normalizeMapKey } from "../path-utils.ts";

export interface TsserverSyncRawDiagnostic {
  message: string;
  category: string;
  code?: number;
  startLocation?: { line: number; offset: number };
  endLocation?: { line: number; offset: number };
}

export interface TsserverSyncCapableService {
  getAdvertisedCommands?: (filePath?: string) => Promise<string[]>;
  executeCommand?: (
    filePath: string | undefined,
    command: string,
    args?: unknown[],
  ) => Promise<{ executed: boolean; result?: unknown; reason?: string }>;
  executeReadOnlyCommandOnLiveClient?: (
    filePath: string,
    command: string,
    args?: unknown[],
  ) => Promise<{ executed: boolean; result?: unknown; reason?: string }>;
}

const ProjectInfoSchema = obj(
  {
    configFileName: opt(str()),
    languageServiceDisabled: opt(bool()),
  },
  { open: true },
);
const isProjectInfo = compile(ProjectInfoSchema).check;
const TsserverResponseSchema = obj(
  {
    success: opt(bool()),
    body: opt(unknown()),
  },
  { open: true },
);
const isTsserverResponse = compile(TsserverResponseSchema).check;
const LocationSchema = obj({ line: finiteNum(), offset: finiteNum() }, { open: true });
const TsserverRawDiagnosticSchema = obj(
  {
    message: str(),
    category: str(),
    code: opt(finiteNum()),
    startLocation: opt(LocationSchema),
    endLocation: opt(LocationSchema),
  },
  { open: true },
);
const isTsserverRawDiagnostic = compile(TsserverRawDiagnosticSchema).check;

interface IdentityLatencyMetadata {
  [key: string]: string | number | boolean | undefined;
}

export const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

export interface TsserverProjectIdentityCommandChannel {
  executeCommand?: (
    command: string,
    args?: unknown[],
  ) => Promise<{ executed: boolean; result?: unknown; reason?: string }>;
}

export interface TsserverProjectIdentityProbeOptions {
  serverId: string;
  launchVariant?: "classic" | "native-ts7";
  clientRoot: string;
  file: string;
  normalizedFile?: string;
  probedFiles: Set<string>;
  commandChannel: TsserverProjectIdentityCommandChannel;
}

export interface TsserverProjectIdentity {
  projectKind: "configured" | "inferred" | "unassociated";
  configFile?: string;
  association: "associated" | "unassociated" | "language-service-disabled";
}

const INFERRED_PROJECT_SENTINEL = /^(?:[A-Za-z]:)?[/\\]dev[/\\]null[/\\]inferredProject\d*\*?$/i;

export function classifyProjectInfo<T>(body: T): TsserverProjectIdentity {
  if (!isProjectInfo(body)) {
    return { projectKind: "unassociated", association: "unassociated" };
  }
  const configFile = body.configFileName || undefined;
  const inferred = configFile ? INFERRED_PROJECT_SENTINEL.test(configFile) : false;
  const projectKind = configFile
    ? inferred
      ? "inferred"
      : /(?:^|[/\\])(?:tsconfig|jsconfig)\.json$/i.test(configFile)
        ? "configured"
        : "unassociated"
    : "unassociated";
  const identity: TsserverProjectIdentity = {
    projectKind,
    association:
      body.languageServiceDisabled === true
        ? "language-service-disabled"
        : projectKind === "unassociated"
          ? "unassociated"
          : "associated",
  };
  if (configFile) identity.configFile = configFile;
  return identity;
}

export async function probeTsserverProjectIdentity(
  options: TsserverProjectIdentityProbeOptions,
): Promise<void> {
  const normalizedFile = options.normalizedFile ?? normalizeMapKey(options.file);
  const startedAt = Date.now();
  const logOutcome = (
    outcome: "ok" | "not-executed" | "no-response" | "unsuccessful" | "threw",
    metadata: IdentityLatencyMetadata = {},
  ) =>
    logLatency({
      type: "phase",
      phase: "lsp_typescript_project_identity",
      filePath: normalizedFile,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverId: options.serverId,
        launchVariant: options.launchVariant,
        clientRoot: options.clientRoot,
        outcome,
        ...metadata,
      },
    });
  if (
    options.serverId !== "typescript" ||
    options.launchVariant !== "classic" ||
    !options.commandChannel.executeCommand
  ) {
    return;
  }
  if (options.probedFiles.has(normalizedFile)) return;
  options.probedFiles.add(normalizedFile);
  try {
    const outcome = await options.commandChannel.executeCommand(TSSERVER_REQUEST_COMMAND, [
      "projectInfo",
      { file: options.file, needFileNameList: false },
    ]);
    if (!outcome.executed) {
      logOutcome("not-executed");
      return;
    }
    const response = outcome.result;
    if (!isTsserverResponse(response)) {
      logOutcome("no-response");
      return;
    }
    if (response.success !== true) {
      logOutcome("unsuccessful");
      return;
    }
    const identity = classifyProjectInfo(response.body);
    logLatency({
      type: "phase",
      phase: "lsp_typescript_project_identity",
      filePath: normalizedFile,
      durationMs: Date.now() - startedAt,
      metadata: {
        outcome: "ok",
        serverId: options.serverId,
        launchVariant: options.launchVariant,
        clientRoot: options.clientRoot,
        projectKind: identity.projectKind,
        configFile: identity.configFile,
        association: identity.association,
      },
    });
  } catch {
    logOutcome("threw");
  }
}

export async function fetchTsserverProjectIdentity(
  svc: TsserverSyncCapableService,
  file: string,
): Promise<TsserverProjectIdentity | undefined> {
  try {
    if (!svc.executeReadOnlyCommandOnLiveClient) {
      return undefined;
    }
    const outcome = await svc.executeReadOnlyCommandOnLiveClient(file, TSSERVER_REQUEST_COMMAND, [
      "projectInfo",
      { file, needFileNameList: false },
    ]);
    if (!outcome.executed) return undefined;
    const response = outcome.result;
    if (!isTsserverResponse(response) || response.success !== true) {
      return undefined;
    }
    return classifyProjectInfo(response.body);
  } catch {
    return undefined;
  }
}

export function isTsserverSyncRawDiagnostic<T>(value: T): value is T & TsserverSyncRawDiagnostic {
  return isTsserverRawDiagnostic(value);
}

export function tsserverSeverityFromCategory(category: string): 1 | 2 | 3 | 4 {
  switch (category) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "suggestion":
      return 4;
    default:
      return 3;
  }
}

export function tsserverSyncDiagnosticToLsp(d: TsserverSyncRawDiagnostic): LSPDiagnostic {
  const startLine = Math.max(0, (d.startLocation?.line ?? 1) - 1);
  const startChar = Math.max(0, (d.startLocation?.offset ?? 1) - 1);
  const endLine = Math.max(0, (d.endLocation?.line ?? d.startLocation?.line ?? 1) - 1);
  const endChar = Math.max(0, (d.endLocation?.offset ?? d.startLocation?.offset ?? 1) - 1);
  return {
    severity: tsserverSeverityFromCategory(d.category),
    message: d.message,
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    code: d.code,
    source: "typescript",
  };
}

export async function runTsserverSyncCommand(
  svc: TsserverSyncCapableService,
  file: string,
  command: "semanticDiagnosticsSync" | "syntacticDiagnosticsSync",
): Promise<TsserverSyncRawDiagnostic[] | undefined> {
  if (!svc.executeCommand) return undefined;
  const outcome = await svc.executeCommand(file, TSSERVER_REQUEST_COMMAND, [
    command,
    { file, includeLinePosition: true },
  ]);
  if (!outcome.executed) return undefined;
  const result = outcome.result;
  if (!isTsserverResponse(result) || result.success !== true || !Array.isArray(result.body)) {
    return undefined;
  }
  return result.body.filter(isTsserverSyncRawDiagnostic);
}

export async function attemptTsserverSyncDiagnostics(
  file: string,
  svc: TsserverSyncCapableService,
): Promise<LSPDiagnostic[] | undefined> {
  try {
    if (!svc.getAdvertisedCommands) return undefined;
    const advertised = await svc.getAdvertisedCommands(file);
    if (!advertised.includes(TSSERVER_REQUEST_COMMAND)) return undefined;

    const [semantic, syntactic] = await Promise.all([
      runTsserverSyncCommand(svc, file, "semanticDiagnosticsSync"),
      runTsserverSyncCommand(svc, file, "syntacticDiagnosticsSync"),
    ]);
    if (semantic === undefined || syntactic === undefined) return undefined;

    return [...syntactic, ...semantic].map(tsserverSyncDiagnosticToLsp);
  } catch {
    return undefined;
  }
}
