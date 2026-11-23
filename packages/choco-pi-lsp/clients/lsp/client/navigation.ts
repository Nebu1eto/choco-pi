import { readFile } from "node:fs/promises";
import { emitBounded } from "../../bounded-telemetry.ts";
import { withTimeout } from "../../deadline-utils.ts";
import { getAmbientAbortSignal } from "../../safe-spawn.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { convertCharacterOffset, lineTextAt } from "../position-encoding.ts";
import {
  LIVENESS_PING_QUERY,
  LIVENESS_PING_TIMEOUT_MS,
  NAV_REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { isClientAlive } from "./process.ts";
import type { JsonRpcParams } from "./schemas.ts";
import { safeSendRequest } from "./transport.ts";
import type { LSPClientState } from "./types.ts";

export async function toWirePosition(
  state: LSPClientState,
  filePath: string,
  line: number,
  character: number,
): Promise<{ line: number; character: number }> {
  if (state.positionEncoding === "utf-16") return { line, character };
  try {
    const content = await readFile(filePath, "utf8");
    return {
      line,
      character: convertCharacterOffset(
        state.positionEncoding,
        lineTextAt(content, line),
        character,
      ),
    };
  } catch {
    return { line, character };
  }
}

function navStaleDropEnabled(): boolean {
  return process.env.CHOCO_PI_LSP_LSP_NAV_STALE_DROP !== "0";
}

export async function navRequest<T>(
  state: LSPClientState,
  method: string,
  params: JsonRpcParams,
  staleCheckPath?: string,
  timeoutMs: number = NAV_REQUEST_TIMEOUT_MS,
  signal: AbortSignal | undefined = getAmbientAbortSignal(),
): Promise<T | null | undefined> {
  if (!isClientAlive(state)) return null;
  const normalizedPath = staleCheckPath !== undefined ? normalizeMapKey(staleCheckPath) : undefined;
  const requestVersion =
    normalizedPath !== undefined ? state.documentVersions.get(normalizedPath) : undefined;
  const requestStartedAt = Date.now();
  const requestPromise = safeSendRequest<T>(state.connection, method, params, signal);
  const result = await withTimeout(requestPromise, timeoutMs).catch((err) => {
    if (isNavTimeoutError(err, timeoutMs)) {
      recordNavTimeoutTelemetry({
        method,
        scope: normalizedPath,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - requestStartedAt,
      });
      armNavLateAnswerTelemetry({
        requestPromise,
        method,
        scope: normalizedPath,
        requestStartedAt,
      });
      return undefined;
    }
    if (err instanceof Error && err.message.startsWith("Timeout after")) {
      return undefined;
    }
    throw err;
  });
  if (normalizedPath !== undefined && requestVersion !== undefined && navStaleDropEnabled()) {
    const currentVersion = state.documentVersions.get(normalizedPath);
    if (currentVersion !== undefined && currentVersion > requestVersion) {
      return undefined;
    }
  }
  return result;
}

function isNavTimeoutError<T>(err: T, timeoutMs: number): boolean {
  return err instanceof Error && err.message === `Timeout after ${timeoutMs}ms`;
}

const NAV_REQUEST_NO_PATH_SCOPE = "*no-path*";

function recordNavTimeoutTelemetry(args: {
  method: string;
  scope: string | undefined;
  budgetMs: number;
  elapsedMs: number;
}): void {
  emitBounded(
    "lsp_nav_request_timeout",
    `${args.method}:${args.scope ?? NAV_REQUEST_NO_PATH_SCOPE}`,
    {
      type: "phase",
      filePath: args.scope ?? NAV_REQUEST_NO_PATH_SCOPE,
      durationMs: args.elapsedMs,
      metadata: { method: args.method, effectiveBudgetMs: args.budgetMs },
    },
    {
      ledgerKind: "lsp-nav-request-timeout",
      risingEdgePer: "identity",
      reason: `timeout budget=${args.budgetMs}ms elapsed=${args.elapsedMs}ms`,
    },
  );
}

function armNavLateAnswerTelemetry(args: {
  requestPromise: Promise<unknown>;
  method: string;
  scope: string | undefined;
  requestStartedAt: number;
}): void {
  args.requestPromise.then(
    () => {
      try {
        const elapsedMs = Date.now() - args.requestStartedAt;
        emitBounded(
          "lsp_nav_late_answer_discarded",
          `${args.method}:${args.scope ?? NAV_REQUEST_NO_PATH_SCOPE}`,
          {
            type: "phase",
            filePath: args.scope ?? NAV_REQUEST_NO_PATH_SCOPE,
            durationMs: elapsedMs,
            metadata: { method: args.method },
          },
          {
            ledgerKind: "lsp-nav-late-answer",
            risingEdgePer: "identity",
            reason: `late nav answer discarded after ${elapsedMs}ms`,
          },
        );
      } catch {}
    },
    () => {},
  );
}

export async function clientPingLiveness(
  state: LSPClientState,
  timeoutMs: number = LIVENESS_PING_TIMEOUT_MS,
): Promise<boolean> {
  if (!isClientAlive(state)) return false;
  try {
    await withTimeout(
      safeSendRequest(state.connection, "workspace/symbol", {
        query: LIVENESS_PING_QUERY,
      }),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Timeout after")) {
      return false;
    }
  }
  return isClientAlive(state);
}
