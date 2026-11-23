import type { RuntimeValue } from "../../tools/runtime-values.ts";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AstGrepClient } from "../ast-grep-client.ts";
import { type BootstrapClients, loadBootstrapClients } from "../bootstrap.ts";
import { CacheManager, MCP_TURN_STATE_OWNER_ID, type TurnStateOwner } from "../cache-manager.ts";
import { resetDispatchBaselines } from "../dispatch/integration.ts";
import { resetFormatService } from "../format-service.ts";
import { getLSPService, resetLSPService } from "../lsp/index.ts";
import {
  acknowledgeTestFindings,
  acknowledgeTurnEndFindings,
  consumeSessionStartGuidance,
  consumeTestFindings,
  consumeTurnEndFindings,
  peekTestFindings,
  peekTurnEndFindings,
} from "../runtime-context.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import { handleSessionStart } from "../runtime-session.ts";
import { handleTurnEnd } from "../runtime-turn.ts";
import { createMcpHost } from "./host-shim.ts";

interface McpSessionContext {
  runtime: RuntimeCoordinator;
  cacheManager: CacheManager;
  astGrepClient: AstGrepClient;
  clients: BootstrapClients;
}

let contextPromise: Promise<McpSessionContext> | undefined;
let resolvedRuntime: RuntimeCoordinator | undefined;

export function getMcpSessionContext(): Promise<McpSessionContext> {
  contextPromise ??= (async () => {
    const context: McpSessionContext = {
      runtime: new RuntimeCoordinator(),
      cacheManager: new CacheManager(),
      astGrepClient: new AstGrepClient(),
      clients: await loadBootstrapClients(),
    };
    resolvedRuntime = context.runtime;
    return context;
  })().catch((err: RuntimeValue) => {
    contextPromise = undefined;
    throw err;
  });
  return contextPromise;
}

export function peekMcpSessionRuntime(): RuntimeCoordinator | undefined {
  return resolvedRuntime;
}

export function _resetMcpSessionContext(): void {
  contextPromise = undefined;
  resolvedRuntime = undefined;
}

const noop = (): void => {};

function joinMessages(
  consumed: { messages: Array<{ content: string }> } | undefined,
): string | undefined {
  if (!consumed?.messages?.length) return undefined;
  return consumed.messages.map((message) => message.content).join("\n\n");
}

export interface SessionStartOutcome {
  guidance?: string;
  errorDebtBaseline?: { testsPassed: boolean; buildPassed: boolean };
  aliveLspClients: number;
}

export async function runSessionStart(cwd: string): Promise<SessionStartOutcome> {
  const ctx = await getMcpSessionContext();
  const host = createMcpHost(undefined, cwd);

  await handleSessionStart({
    ctxCwd: cwd,
    startupModeOverride: "full",
    getFlag: host.getFlag,
    notify: noop,
    dbg: noop,
    log: noop,
    runtime: ctx.runtime,
    metricsClient: ctx.clients.metricsClient,
    cacheManager: ctx.cacheManager,
    todoScanner: ctx.clients.todoScanner,
    astGrepClient: ctx.astGrepClient,
    biomeClient: ctx.clients.biomeClient,
    ruffClient: ctx.clients.ruffClient,
    opengrepClient: ctx.clients.opengrepClient,
    testRunnerClient: ctx.clients.testRunnerClient,
    goClient: ctx.clients.goClient,
    rustClient: ctx.clients.rustClient,
    ensureTool: async (name: string) => (await import("../installer/index.ts")).ensureTool(name),
    cleanStaleTsBuildInfo: () => [],
    resetDispatchBaselines: (cwdArg?: string) => resetDispatchBaselines(cwdArg ?? cwd),
    resetLSPService,
  });

  const baseline = ctx.runtime.errorDebtBaseline;
  return {
    guidance: joinMessages(consumeSessionStartGuidance(ctx.cacheManager, cwd)),
    errorDebtBaseline: baseline
      ? { testsPassed: baseline.testsPassed, buildPassed: baseline.buildPassed }
      : undefined,
    aliveLspClients: getLSPService().getAliveClientCount(),
  };
}

export interface TurnEndOutcome {
  turnEnd?: string;
  tests?: string;
  filesRegistered: number;
}

export interface TurnEndDelivery {
  outcome: TurnEndOutcome;
  deliveryId?: string;
}

interface TurnEndTransaction {
  outcome: TurnEndOutcome;
  commit: () => void;
}

interface PendingTurnEndDelivery {
  cwd: string;
  transaction: TurnEndTransaction;
  createdAt: number;
}

const TURN_END_DELIVERY_TTL_MS = 10 * 60_000;
const TURN_END_DELIVERY_MAX = 8;

const TURN_END_QUEUE_WAIT_MS = 5_000;

interface QueueItem<T> {
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: RuntimeValue) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TurnEndQueue {
  private running = false;
  private pending: QueueItem<unknown>[] = [];

  enqueue<T>(work: () => Promise<T>, waitMs = TURN_END_QUEUE_WAIT_MS): Promise<T> {
    if (this.pending.length >= 1) {
      return Promise.reject(new Error("turn_end queue is busy"));
    }
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        work,
        resolve,
        reject,
        timer: setTimeout(() => {
          // SAFETY: The IPC parser or MCP response producer establishes this message shape before its optional fields are read.
          const index = this.pending.indexOf(item as QueueItem<unknown>);
          if (index === -1) return;
          this.pending.splice(index, 1);
          reject(new Error("turn_end queue wait timed out"));
        }, waitMs),
      };
      item.timer.unref();
      // SAFETY: The IPC parser or MCP response producer establishes this message shape before its optional fields are read.
      this.pending.push(item as QueueItem<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.running) return;
    const item = this.pending.shift();
    if (!item) return;
    clearTimeout(item.timer);
    this.running = true;
    void item
      .work()
      .then(item.resolve, item.reject)
      .finally(() => {
        this.running = false;
        this.drain();
      });
  }

  reset(): void {
    for (const item of this.pending.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new Error("turn_end queue reset"));
    }
    this.running = false;
  }
}

const turnEndQueue = new TurnEndQueue();
const pendingTurnEndDeliveries = new Map<string, PendingTurnEndDelivery>();
const inFlightIpcTurnEnds = new Map<string, Promise<TurnEndDelivery>>();

async function runTurnEndNow(
  cwd: string,
  files: string[] = [],
  deferredDelivery = false,
): Promise<TurnEndTransaction> {
  const ctx = await getMcpSessionContext();
  const host = createMcpHost(undefined, cwd);

  let registered = 0;
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    let lineCount = 1;
    try {
      lineCount = fs.readFileSync(abs, "utf8").split("\n").length;
    } catch {
      continue;
    }
    ctx.cacheManager.addModifiedRange(
      abs,
      { start: 1, end: lineCount },
      true,
      cwd,
      MCP_TURN_STATE_OWNER_ID,
      "mcp",
    );
    registered++;
  }

  const owner: TurnStateOwner = {
    kind: "mcp",
    id: MCP_TURN_STATE_OWNER_ID,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
  };

  await handleTurnEnd({
    ctxCwd: cwd,
    getFlag: host.getFlag,
    dbg: noop,
    runtime: ctx.runtime,
    cacheManager: ctx.cacheManager,
    testRunnerClient: ctx.clients.testRunnerClient,
    owner,
    resetLSPService,
    resetFormatService,
  });

  const outcome: TurnEndOutcome = deferredDelivery
    ? {
        turnEnd: joinMessages(peekTurnEndFindings(ctx.cacheManager, cwd, ctx.runtime, true)),
        tests: joinMessages(peekTestFindings(ctx.cacheManager, cwd, ctx.runtime, true)),
        filesRegistered: registered,
      }
    : {
        turnEnd: joinMessages(consumeTurnEndFindings(ctx.cacheManager, cwd, ctx.runtime)),
        tests: joinMessages(consumeTestFindings(ctx.cacheManager, cwd, ctx.runtime)),
        filesRegistered: registered,
      };

  return {
    outcome,
    commit: () => {
      if (!deferredDelivery) return;
      acknowledgeTurnEndFindings(ctx.cacheManager, cwd);
      acknowledgeTestFindings(ctx.cacheManager, cwd);
    },
  };
}

export function runTurnEnd(cwd: string, files: string[] = []): Promise<TurnEndOutcome> {
  return turnEndQueue.enqueue(async () => (await runTurnEndNow(cwd, files)).outcome);
}

function hasTurnEndFindings(outcome: TurnEndOutcome): boolean {
  return Boolean(outcome.turnEnd || outcome.tests);
}

function prunePendingTurnEndDeliveries(now = Date.now()): void {
  for (const [deliveryId, delivery] of pendingTurnEndDeliveries) {
    if (now - delivery.createdAt >= TURN_END_DELIVERY_TTL_MS) {
      pendingTurnEndDeliveries.delete(deliveryId);
    }
  }
  while (pendingTurnEndDeliveries.size > TURN_END_DELIVERY_MAX) {
    const oldest = pendingTurnEndDeliveries.keys().next();
    if (oldest.done) break;
    pendingTurnEndDeliveries.delete(oldest.value);
  }
}

function pendingForCwd(cwd: string): [string, PendingTurnEndDelivery] | undefined {
  for (const [deliveryId, delivery] of pendingTurnEndDeliveries) {
    if (delivery.cwd === cwd) return [deliveryId, delivery];
  }
  return undefined;
}

export function runTurnEndForIpc(cwd: string): Promise<TurnEndDelivery> {
  const inFlight = inFlightIpcTurnEnds.get(cwd);
  if (inFlight) return inFlight;
  const run = runTurnEndForIpcNow(cwd).finally(() => {
    inFlightIpcTurnEnds.delete(cwd);
  });
  inFlightIpcTurnEnds.set(cwd, run);
  return run;
}

function runTurnEndForIpcNow(cwd: string): Promise<TurnEndDelivery> {
  return turnEndQueue.enqueue(async () => {
    prunePendingTurnEndDeliveries();
    const pending = pendingForCwd(cwd);
    if (pending) {
      return {
        outcome: pending[1].transaction.outcome,
        deliveryId: pending[0],
      };
    }

    const ctx = await getMcpSessionContext();
    const cachedOutcome: TurnEndOutcome = {
      turnEnd: joinMessages(peekTurnEndFindings(ctx.cacheManager, cwd, ctx.runtime, true)),
      tests: joinMessages(peekTestFindings(ctx.cacheManager, cwd, ctx.runtime, true)),
      filesRegistered: 0,
    };
    const transaction = hasTurnEndFindings(cachedOutcome)
      ? {
          outcome: cachedOutcome,
          commit: () => {
            acknowledgeTurnEndFindings(ctx.cacheManager, cwd);
            acknowledgeTestFindings(ctx.cacheManager, cwd);
          },
        }
      : await runTurnEndNow(cwd, [], true);

    if (!hasTurnEndFindings(transaction.outcome)) {
      return { outcome: transaction.outcome };
    }

    const deliveryId = crypto.randomUUID();
    pendingTurnEndDeliveries.set(deliveryId, {
      cwd,
      transaction,
      createdAt: Date.now(),
    });
    prunePendingTurnEndDeliveries();
    return { outcome: transaction.outcome, deliveryId };
  });
}

export function acknowledgeTurnEnd(cwd: string, deliveryId: string): boolean {
  prunePendingTurnEndDeliveries();
  const delivery = pendingTurnEndDeliveries.get(deliveryId);
  if (!delivery || delivery.cwd !== cwd) return false;
  delivery.transaction.commit();
  pendingTurnEndDeliveries.delete(deliveryId);
  return true;
}

export function _resetTurnEndChain(): void {
  turnEndQueue.reset();
  pendingTurnEndDeliveries.clear();
  inFlightIpcTurnEnds.clear();
}
