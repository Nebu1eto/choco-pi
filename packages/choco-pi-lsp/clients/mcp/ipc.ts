import type { RuntimeValue } from "../../tools/runtime-values.ts";
import { isRuntimeNumber, isRuntimeObject } from "../../tools/runtime-values.ts";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import type { LSPCodeAction, LSPDiagnostic } from "../lsp/client.ts";
import type { McpAnalyzeResult } from "./analyze.ts";

export const WARM_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const WARM_CODE_ACTION_LOOKUP_LIMIT = 6;

export function ipcPathForCwd(cwd: string): string {
  const hash = workspaceHash(cwd);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\choco-pi-lsp-mcp-${hash}`;
  }
  return path.join(os.tmpdir(), `choco-pi-lsp-mcp-${hash}.sock`);
}

function workspaceHash(cwd: string): string {
  const root = path.resolve(cwd).toLowerCase();
  return crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function diagnosticsIpcPathForCwd(cwd: string, pid: number): string {
  const base = ipcPathForCwd(cwd);
  if (process.platform === "win32") return `${base}-diagnostics-${pid}`;
  return base.replace(/\.sock$/, `-diagnostics-${pid}.sock`);
}

export interface WarmDiagnosticsRequest {
  route: "diagnostics";
  version: number;
  file: string;
  cwd: string;
  content: string;
  contentHash: string;
  deadlineAt: number;
}

export interface WarmDiagnosticsResponse {
  route: "diagnostics";
  version: number;
  diagnostics: LSPDiagnostic[];
  contentHash: string;
  servedAt: number;
  fresh: boolean;
  inconclusive: boolean;
  confirmation?: "confirmed" | "partial";
  unconfirmedServerIds?: string[];
}

export interface WarmCodeActionRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface WarmCodeActionsRequest {
  route: "code-actions";
  version: number;
  file: string;
  cwd: string;
  contentHash: string;
  ranges: WarmCodeActionRange[];
  deadlineAt: number;
}

export interface WarmCodeActionsResponse {
  route: "code-actions";
  version: number;
  contentHash: string;
  servedAt: number;
  actions: LSPCodeAction[][];
}

export type WarmCodeActionsResult =
  | { available: true; response: WarmCodeActionsResponse }
  | { available: false; reason: WarmDiagnosticsFailureReason };

export type WarmDiagnosticsFailureReason =
  | "timeout"
  | "ipc-error"
  | "schema-mismatch"
  | "stale-answer";

export type WarmDiagnosticsResult =
  | { available: true; response: WarmDiagnosticsResponse }
  | { available: false; reason: WarmDiagnosticsFailureReason };

export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

type WarmIpcOutcome<TResponse> =
  | { available: true; response: TResponse }
  | { available: false; reason: WarmDiagnosticsFailureReason };

function requestOverWarmIpc<TResponse>(
  endpoint: string,
  timeoutMs: number,
  buildRequest: (deadlineAt: number) => RuntimeValue,
  validate: (result: TResponse, deadlineAt: number) => WarmDiagnosticsFailureReason | undefined,
): Promise<WarmIpcOutcome<TResponse>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: WarmIpcOutcome<TResponse>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const deadlineAt = Date.now() + timeoutMs;
    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let buffer = "";
    const timer = setTimeout(() => finish({ available: false, reason: "timeout" }), timeoutMs);
    timer.unref();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(buildRequest(deadlineAt))}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
        const message = JSON.parse(buffer.slice(0, newline)) as {
          result?: TResponse;
          error?: string;
        };
        const result = message.result;
        if (message.error || !result) {
          finish({ available: false, reason: "ipc-error" });
          return;
        }
        const reason = validate(result, deadlineAt);
        if (reason === undefined) {
          finish({ available: true, response: result });
        } else {
          finish({ available: false, reason });
        }
      } catch {
        finish({ available: false, reason: "schema-mismatch" });
      }
    });
    socket.on("error", () => finish({ available: false, reason: "ipc-error" }));
    socket.on("close", () => finish({ available: false, reason: "ipc-error" }));
  });
}

export function requestWarmDiagnostics(
  cwd: string,
  incumbentPid: number,
  file: string,
  content: string,
  timeoutMs: number,
): Promise<WarmDiagnosticsResult> {
  const expectedHash = contentHash(content);
  return requestOverWarmIpc<WarmDiagnosticsResponse>(
    diagnosticsIpcPathForCwd(cwd, incumbentPid),
    timeoutMs,
    (deadlineAt): WarmDiagnosticsRequest => ({
      route: "diagnostics",
      version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
      file,
      cwd,
      content,
      contentHash: expectedHash,
      deadlineAt,
    }),
    (result, deadlineAt) => {
      if (result.route !== "diagnostics" || result.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION) {
        return "schema-mismatch";
      }
      if (
        !result.fresh ||
        result.inconclusive ||
        result.contentHash !== expectedHash ||
        result.servedAt > deadlineAt
      ) {
        return "stale-answer";
      }
      return undefined;
    },
  );
}

export function requestWarmCodeActions(
  cwd: string,
  incumbentPid: number,
  file: string,
  expectedContentHash: string,
  ranges: WarmCodeActionRange[],
  timeoutMs: number,
): Promise<WarmCodeActionsResult> {
  return requestOverWarmIpc<WarmCodeActionsResponse>(
    diagnosticsIpcPathForCwd(cwd, incumbentPid),
    timeoutMs,
    (deadlineAt): WarmCodeActionsRequest => ({
      route: "code-actions",
      version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
      file,
      cwd,
      contentHash: expectedContentHash,
      ranges,
      deadlineAt,
    }),
    (result, deadlineAt) => {
      if (
        result.route !== "code-actions" ||
        result.version !== WARM_DIAGNOSTICS_SCHEMA_VERSION ||
        !Array.isArray(result.actions) ||
        result.actions.length !== ranges.length ||
        result.actions.some((actions) => !Array.isArray(actions))
      ) {
        return "schema-mismatch";
      }
      if (result.contentHash !== expectedContentHash || result.servedAt > deadlineAt) {
        return "stale-answer";
      }
      return undefined;
    },
  );
}

export interface WarmAnalyzeRequest {
  file: string;
  cwd: string;
}

export const WARM_TURN_END_SCHEMA_VERSION = 2;

export interface WarmTurnEndRequest {
  route: "turn-end";
  version: number;
  cwd: string;
}

export interface WarmTurnEndResponse {
  route: "turn-end";
  version: number;
  turnEnd?: string;
  tests?: string;
  deliveryId?: string;
}

export interface WarmTurnEndAckRequest {
  route: "turn-end-ack";
  version: number;
  cwd: string;
  deliveryId: string;
}

export interface WarmTurnEndAckResponse {
  route: "turn-end-ack";
  version: number;
  acknowledged: boolean;
}

export type WarmTurnEndResult =
  | { available: true; response: WarmTurnEndResponse }
  | { available: false; reason: WarmDiagnosticsFailureReason };

export async function requestWarmTurnEnd(
  cwd: string,
  timeoutMs = 55_000,
): Promise<WarmTurnEndResult> {
  const startedAt = Date.now();
  const first = await requestOverWarmIpc<WarmTurnEndResponse>(
    ipcPathForCwd(cwd),
    timeoutMs,
    (): WarmTurnEndRequest => ({
      route: "turn-end",
      version: WARM_TURN_END_SCHEMA_VERSION,
      cwd,
    }),
    (result) =>
      result.route === "turn-end" && result.version === WARM_TURN_END_SCHEMA_VERSION
        ? undefined
        : "schema-mismatch",
  );
  if (!first.available || !first.response.deliveryId) return first;

  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return { available: false, reason: "timeout" };
  const ack = await requestOverWarmIpc<WarmTurnEndAckResponse>(
    ipcPathForCwd(cwd),
    remainingMs,
    (): WarmTurnEndAckRequest => ({
      route: "turn-end-ack",
      version: WARM_TURN_END_SCHEMA_VERSION,
      cwd,
      deliveryId: first.response.deliveryId!,
    }),
    (result) =>
      result.route === "turn-end-ack" && result.acknowledged === true ? undefined : "ipc-error",
  );
  return ack.available
    ? { available: true, response: first.response }
    : { available: false, reason: ack.reason };
}

export interface TurnEndStatus {
  ran: number;
  skipped: number;
  lastSkipReason?: string;
  lastRunAt?: string;
  lastSkipAt?: string;
}

export function turnEndStatusPathForCwd(cwd: string): string {
  return path.join(os.tmpdir(), `choco-pi-lsp-turn-end-${workspaceHash(cwd)}.json`);
}

export function readTurnEndStatus(cwd: string): TurnEndStatus | undefined {
  try {
    const raw = fs.readFileSync(turnEndStatusPathForCwd(cwd), "utf8");
    // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
    const parsed = JSON.parse(raw) as Partial<TurnEndStatus> | null;
    if (!parsed || !isRuntimeObject(parsed)) return undefined;
    return {
      ran: isRuntimeNumber(parsed.ran) ? parsed.ran : 0,
      skipped: isRuntimeNumber(parsed.skipped) ? parsed.skipped : 0,
      lastSkipReason: parsed.lastSkipReason,
      lastRunAt: parsed.lastRunAt,
      lastSkipAt: parsed.lastSkipAt,
    };
  } catch {
    return undefined;
  }
}

export function recordTurnEndOutcome(
  cwd: string,
  outcome: { ran: true } | { ran: false; reason: string },
): void {
  try {
    const now = new Date().toISOString();
    const previous = readTurnEndStatus(cwd) ?? { ran: 0, skipped: 0 };
    const next: TurnEndStatus = outcome.ran
      ? { ...previous, ran: previous.ran + 1, lastRunAt: now }
      : {
          ...previous,
          skipped: previous.skipped + 1,
          lastSkipReason: outcome.reason,
          lastSkipAt: now,
        };
    writeFileAtomic(turnEndStatusPathForCwd(cwd), `${JSON.stringify(next)}\n`);
  } catch {}
}

export function requestWarmAnalyze(
  cwd: string,
  file: string,
  timeoutMs = 30_000,
): Promise<McpAnalyzeResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: McpAnalyzeResult | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const socket = net.createConnection(ipcPathForCwd(cwd));
    socket.setEncoding("utf8");
    let buffer = "";

    const timer = setTimeout(() => {
      socket.destroy();
      finish(undefined);
    }, timeoutMs);
    timer.unref();

    socket.on("connect", () => {
      const request: WarmAnalyzeRequest = { file, cwd };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
        const message = JSON.parse(buffer.slice(0, newline)) as {
          result?: McpAnalyzeResult;
          error?: string;
        };
        finish(message.error ? undefined : message.result);
      } catch {
        finish(undefined);
      }
      socket.end();
    });
    socket.on("error", () => finish(undefined));
    socket.on("close", () => finish(undefined));
  });
}

export function createWarmIpcLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  let dispatched = false;
  return (chunk: string) => {
    if (dispatched) return;
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    dispatched = true;
    onLine(buffer.slice(0, newline));
  };
}

export function createWarmIpcRequestQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(work: () => Promise<T>): Promise<T> {
      const next = chain.then(work);
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
