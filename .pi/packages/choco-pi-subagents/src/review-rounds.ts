/**
 * review-rounds.ts — Durable per-work-task cap on review-role launches.
 *
 * Identity is (rootSessionId, work_task). Every admitted launch appends a
 * round to a per-session ledger file under a cross-process lock; the caller
 * receives an unforgeable single-use {@link ReviewTicket} that the manager
 * must consume before it starts a review-role agent. Any ledger problem fails
 * closed (REVIEW_STATE_UNAVAILABLE); the ledger is never reset.
 *
 * Caps are constants on purpose: settings files are agent-writable.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { arr, compile, int, lit, map, obj, oneOf, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { createExclusiveFile, readTextIfExists } from "./fs-async.ts";

export const REVIEW_ROLES: readonly string[] = ["reviewer"];
export const MAX_REVIEW_ROUNDS_PER_TASK = 3;
export const MAX_REVIEW_ROUNDS_PER_SESSION = 9;
export const MAX_GRANT_ROUNDS = 3;
export const WORK_TASK_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
const ROOT_SESSION_PATTERN = "^[A-Za-z0-9_-]{1,128}$";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const COUNTER_CEILING = 1_000_000;

const isWorkTask = compile(str({ pattern: WORK_TASK_PATTERN })).check;
const isRootSessionId = compile(str({ pattern: ROOT_SESSION_PATTERN })).check;

export type ReviewEntry = "agent" | "agent-resume" | "nested" | "nested-resume" | "workflow";
export type ReviewErrorCode =
  | "REVIEW_ROUND_LIMIT"
  | "REVIEW_SESSION_LIMIT"
  | "REVIEW_WORK_TASK_REQUIRED"
  | "REVIEW_STATE_UNAVAILABLE";

const roundSchema = obj({
  roundId: str({ minLength: 1 }),
  number: int({ minimum: 1, maximum: COUNTER_CEILING }),
  agentType: str(),
  entry: oneOf(["agent", "agent-resume", "nested", "nested-resume", "workflow"]),
  admittedAt: str(),
  status: oneOf(["admitted", "start_failed"]),
});
const workTaskSchema = obj({
  createdAt: str(),
  granted: int({ minimum: 0, maximum: COUNTER_CEILING }),
  rounds: arr(roundSchema),
});
const ledgerSchema = obj({
  schemaVersion: lit(1),
  rootSessionId: str({ pattern: ROOT_SESSION_PATTERN }),
  sessionGranted: int({ minimum: 0, maximum: COUNTER_CEILING }),
  workTasks: map(workTaskSchema),
});
type Ledger = Static<typeof ledgerSchema>;
type WorkTaskLedger = Static<typeof workTaskSchema>;
const isLedger = compile(ledgerSchema).check;

// --- Predicates ----------------------------------------------------------

/** Whether `type` (case-insensitive) is a review role subject to the cap. */
export function isReviewRole(type: string): boolean {
  const lowered = type.toLowerCase();
  return REVIEW_ROLES.some((role) => role.toLowerCase() === lowered);
}

export function isValidWorkTask(value: string): boolean {
  return isWorkTask(value);
}

// --- Messages ------------------------------------------------------------

export function roundLimitMessage(workTask: string, used: number, allowed: number): string {
  return (
    `Review round refused [REVIEW_ROUND_LIMIT]: work task "${workTask}" has used ${used}/${allowed} review rounds. ` +
    "No reviewer was started. Do not retry: triage the latest findings, finish in-scope fixes and validation, and report the remaining risk. " +
    `Only the user can authorize more rounds with /review-continue ${workTask} [rounds].`
  );
}

export function sessionLimitMessage(used: number, allowed: number, taskCount: number): string {
  return (
    `Review round refused [REVIEW_SESSION_LIMIT]: this session has used ${used}/${allowed} review rounds across ${taskCount} work tasks. ` +
    "No reviewer was started. Do not retry or open a new work task to continue reviewing; report the remaining risk. " +
    "Only the user can authorize more rounds with /review-continue <id> [rounds]."
  );
}

export function workTaskRequiredMessage(agentType: string): string {
  return (
    `Review round refused [REVIEW_WORK_TASK_REQUIRED]: "${agentType}" is a review role; pass work_task (lowercase letters, digits and hyphens, 1-64 characters) naming the work task. ` +
    "Reuse the same work_task for every review round of that task, including after follow-ups."
  );
}

export function stateUnavailableMessage(reason: string): string {
  return (
    `Review round refused [REVIEW_STATE_UNAVAILABLE]: the review-round ledger could not be read or locked (${reason}). ` +
    "No reviewer was started; report this to the user."
  );
}

export function scheduleUnsupportedMessage(): string {
  return "Review round refused [REVIEW_SCHEDULE_UNSUPPORTED]: review roles cannot be scheduled; spawn the reviewer when the review is due.";
}

export function admissionRequiredMessage(agentType: string): string {
  return (
    `Review admission required [REVIEW_ADMISSION_REQUIRED]: "${agentType}" is a review role and this launch path has no review-round admission. ` +
    "Use the Agent tool with work_task."
  );
}

export function admittedNotice(
  workTask: string,
  round: number,
  allowed: number,
  sessionUsed: number,
  sessionAllowed: number,
): string {
  const tail = `session total ${sessionUsed}/${sessionAllowed}).`;
  return round === 1
    ? `Review round 1/${allowed} admitted for work task "${workTask}" (new review budget; ${tail}`
    : `Review round ${round}/${allowed} admitted for work task "${workTask}" (${tail}`;
}

export function grantedMessage(
  rounds: number,
  workTask: string,
  used: number,
  allowed: number,
  sessionUsed: number,
  sessionAllowed: number,
): string {
  return `Granted ${rounds} more review round(s) for work task "${workTask}" (now ${used}/${allowed}; session ${sessionUsed}/${sessionAllowed}).`;
}

export const NO_ROUNDS_MESSAGE = "No review rounds recorded in this session.";
export const REVIEW_CONTINUE_USAGE = "Usage: /review-continue [<work_task> [rounds 1-3]]";

// --- Tickets -------------------------------------------------------------

export type ExemptReason = "user-mention" | "hook-continuation";

export interface ReviewTicket {
  readonly roundId: string;
  readonly workTask: string;
  readonly rootSessionId: string;
  readonly exemptReason?: ExemptReason;
}

/** Tickets still consumable. Module-private: JSON/RPC callers cannot forge membership. */
const liveTickets = new WeakSet<ReviewTicket>();
/** Tickets that own a ledger round (and so may be refunded once). */
const ledgerTickets = new WeakSet<ReviewTicket>();

/** Consume `ticket` once; true only for the first consumption of a ticket this module issued. */
export function consumeReviewTicket(ticket: ReviewTicket | undefined): boolean {
  if (ticket === undefined) return false;
  return liveTickets.delete(ticket);
}

/** A ticket with no ledger write: user-typed mentions and same-round hook continuations. */
export function issueExemptTicket(reason: ExemptReason): ReviewTicket {
  const ticket: ReviewTicket = Object.freeze({
    roundId: `exempt-${randomUUID()}`,
    workTask: "",
    rootSessionId: "",
    exemptReason: reason,
  });
  liveTickets.add(ticket);
  return ticket;
}

// --- Store ---------------------------------------------------------------

export function defaultReviewRoundsDir(): string {
  return join(getAgentDir(), "choco-pi", "task-reviews");
}

class LedgerUnavailableError extends Error {}

function reasonOf(error: Error): string {
  return error.message.replace(/\s+/g, " ").slice(0, 200);
}

/** Per-file in-process mutex chains (shared by every store instance in this process). */
const fileChains = new Map<string, Promise<void>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  fileChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (await createExclusiveFile(lockPath, String(process.pid))) return;
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      continue; // lock vanished between create and stat — retry immediately
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for the ledger lock");
    await delay(LOCK_RETRY_MS);
  }
}

function usedOf(task: WorkTaskLedger): number {
  return task.rounds.filter((round) => round.status === "admitted").length;
}

function sessionUsedOf(ledger: Ledger): number {
  return Object.values(ledger.workTasks).reduce((sum, task) => sum + usedOf(task), 0);
}

function activeTaskCount(ledger: Ledger): number {
  return Object.values(ledger.workTasks).filter((task) => usedOf(task) > 0).length;
}

function taskOf(ledger: Ledger, workTask: string): WorkTaskLedger | undefined {
  return Object.hasOwn(ledger.workTasks, workTask) ? ledger.workTasks[workTask] : undefined;
}

function emptyLedger(rootSessionId: string): Ledger {
  return { schemaVersion: 1, rootSessionId, sessionGranted: 0, workTasks: {} };
}

export type AdmitResult =
  | { ok: true; ticket: ReviewTicket; notice: string }
  | { ok: false; code: ReviewErrorCode; message: string };

export interface AdmitRequest {
  rootSessionId: string;
  workTask: string;
  agentType: string;
  entry: ReviewEntry;
}

interface Mutation<T> {
  result: T;
  changed: boolean;
}

export class ReviewRoundStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private pathFor(rootSessionId: string): string {
    return join(this.rootDir, `${rootSessionId}.json`);
  }

  private async read(rootSessionId: string, path: string): Promise<Ledger> {
    let text: string | undefined;
    try {
      text = await readTextIfExists(path);
    } catch (error) {
      throw new LedgerUnavailableError(error instanceof Error ? reasonOf(error) : "read failed");
    }
    if (text === undefined) return emptyLedger(rootSessionId);
    let data: Ledger | undefined;
    try {
      const parsed = JSON.parse(text);
      if (isLedger(parsed)) data = parsed;
    } catch {
      /* falls through to the invalid-ledger error */
    }
    if (data === undefined || data.rootSessionId !== rootSessionId) {
      throw new LedgerUnavailableError("ledger file is invalid or has an unsupported schema");
    }
    for (const key of Object.keys(data.workTasks)) {
      if (!isWorkTask(key)) {
        throw new LedgerUnavailableError("ledger contains an invalid work task id");
      }
    }
    return data;
  }

  private async write(path: string, ledger: Ledger): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: "wx" });
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  /** Lock, read, mutate, write, unlock. Throws {@link LedgerUnavailableError} on any I/O or state problem. */
  private async mutate<T>(rootSessionId: string, fn: (ledger: Ledger) => Mutation<T>): Promise<T> {
    if (!isRootSessionId(rootSessionId)) {
      throw new LedgerUnavailableError("invalid root session id");
    }
    const path = this.pathFor(rootSessionId);
    const lockPath = `${path}.lock`;
    return serialize(path, async () => {
      try {
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        await acquireLock(lockPath);
      } catch (error) {
        throw new LedgerUnavailableError(error instanceof Error ? reasonOf(error) : "lock failed");
      }
      try {
        const ledger = await this.read(rootSessionId, path);
        const { result, changed } = fn(ledger);
        if (changed) {
          try {
            await this.write(path, ledger);
          } catch (error) {
            throw new LedgerUnavailableError(
              error instanceof Error ? reasonOf(error) : "write failed",
            );
          }
        }
        return result;
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    });
  }

  /** Reserve a review round. The round stays counted unless {@link release}d. */
  async admit(request: AdmitRequest): Promise<AdmitResult> {
    if (!isValidWorkTask(request.workTask)) {
      return {
        ok: false,
        code: "REVIEW_WORK_TASK_REQUIRED",
        message: workTaskRequiredMessage(request.agentType),
      };
    }
    try {
      return await this.mutate<AdmitResult>(request.rootSessionId, (ledger) => {
        const existing = taskOf(ledger, request.workTask);
        const used = existing === undefined ? 0 : usedOf(existing);
        const allowed = MAX_REVIEW_ROUNDS_PER_TASK + (existing?.granted ?? 0);
        if (used >= allowed) {
          return {
            result: {
              ok: false,
              code: "REVIEW_ROUND_LIMIT",
              message: roundLimitMessage(request.workTask, used, allowed),
            },
            changed: false,
          };
        }
        const sessionUsed = sessionUsedOf(ledger);
        const sessionAllowed = MAX_REVIEW_ROUNDS_PER_SESSION + ledger.sessionGranted;
        if (sessionUsed >= sessionAllowed) {
          return {
            result: {
              ok: false,
              code: "REVIEW_SESSION_LIMIT",
              message: sessionLimitMessage(sessionUsed, sessionAllowed, activeTaskCount(ledger)),
            },
            changed: false,
          };
        }
        const now = new Date().toISOString();
        const task: WorkTaskLedger = existing ?? { createdAt: now, granted: 0, rounds: [] };
        if (existing === undefined) ledger.workTasks[request.workTask] = task;
        const number = used + 1;
        const roundId = randomUUID();
        task.rounds.push({
          roundId,
          number,
          agentType: request.agentType,
          entry: request.entry,
          admittedAt: now,
          status: "admitted",
        });
        const ticket: ReviewTicket = Object.freeze({
          roundId,
          workTask: request.workTask,
          rootSessionId: request.rootSessionId,
        });
        return {
          result: {
            ok: true,
            ticket,
            notice: admittedNotice(
              request.workTask,
              number,
              allowed,
              sessionUsed + 1,
              sessionAllowed,
            ),
          },
          changed: true,
        };
      }).then((result) => {
        // Registered only after the ledger write succeeded: a failed write yields no ticket.
        if (result.ok) {
          liveTickets.add(result.ticket);
          ledgerTickets.add(result.ticket);
        }
        return result;
      });
    } catch (error) {
      if (error instanceof LedgerUnavailableError) {
        return {
          ok: false,
          code: "REVIEW_STATE_UNAVAILABLE",
          message: stateUnavailableMessage(reasonOf(error)),
        };
      }
      throw error;
    }
  }

  /**
   * Refund a round whose launch threw synchronously. Idempotent; the ticket becomes
   * unconsumable. If the ledger cannot be updated the round stays counted (fail closed).
   * Resolves whether a refund was recorded.
   */
  async release(ticket: ReviewTicket): Promise<boolean> {
    liveTickets.delete(ticket);
    if (!ledgerTickets.delete(ticket)) return false;
    try {
      return await this.mutate(ticket.rootSessionId, (ledger) => {
        const round = taskOf(ledger, ticket.workTask)?.rounds.find(
          (entry) => entry.roundId === ticket.roundId,
        );
        if (round === undefined || round.status !== "admitted") {
          return { result: false, changed: false };
        }
        round.status = "start_failed";
        return { result: true, changed: true };
      });
    } catch (error) {
      if (error instanceof LedgerUnavailableError) return false;
      throw error;
    }
  }

  /**
   * User-authorized extra rounds for one work task (and the session ceiling).
   * Creates the task's entry when absent: a task refused at the session ceiling
   * has none, and this grant is the only way past that refusal.
   */
  async grant(
    rootSessionId: string,
    workTask: string,
    rounds: number,
  ): Promise<{ ok: boolean; message: string }> {
    if (
      !isValidWorkTask(workTask) ||
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > MAX_GRANT_ROUNDS
    ) {
      return { ok: false, message: REVIEW_CONTINUE_USAGE };
    }
    try {
      return await this.mutate<{ ok: boolean; message: string }>(rootSessionId, (ledger) => {
        let task = taskOf(ledger, workTask);
        if (task === undefined) {
          task = { createdAt: new Date().toISOString(), granted: 0, rounds: [] };
          ledger.workTasks[workTask] = task;
        }
        task.granted += rounds;
        ledger.sessionGranted += rounds;
        return {
          result: {
            ok: true,
            message: grantedMessage(
              rounds,
              workTask,
              usedOf(task),
              MAX_REVIEW_ROUNDS_PER_TASK + task.granted,
              sessionUsedOf(ledger),
              MAX_REVIEW_ROUNDS_PER_SESSION + ledger.sessionGranted,
            ),
          },
          changed: true,
        };
      });
    } catch (error) {
      if (error instanceof LedgerUnavailableError) {
        return { ok: false, message: stateUnavailableMessage(reasonOf(error)) };
      }
      throw error;
    }
  }

  /** One line per work task plus the session total, or the empty-ledger message. */
  async summary(rootSessionId: string): Promise<string> {
    try {
      return await this.mutate(rootSessionId, (ledger) => {
        const entries = Object.entries(ledger.workTasks);
        if (entries.length === 0) return { result: NO_ROUNDS_MESSAGE, changed: false };
        const lines = entries.map(
          ([id, task]) =>
            `"${id}": ${usedOf(task)}/${MAX_REVIEW_ROUNDS_PER_TASK + task.granted} review rounds`,
        );
        lines.push(
          `Session total: ${sessionUsedOf(ledger)}/${MAX_REVIEW_ROUNDS_PER_SESSION + ledger.sessionGranted}`,
        );
        return { result: lines.join("\n"), changed: false };
      });
    } catch (error) {
      if (error instanceof LedgerUnavailableError) return stateUnavailableMessage(reasonOf(error));
      throw error;
    }
  }
}
