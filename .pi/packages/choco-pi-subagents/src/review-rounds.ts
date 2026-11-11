/**
 * review-rounds.ts — Durable per-work-task cap on review-role and
 * verification-role launches.
 *
 * Identity is (round class, rootSessionId, work_task). Every admitted launch
 * appends a round to a per-session ledger file under a cross-process lock; the
 * caller receives an unforgeable single-use {@link ReviewTicket} that the
 * manager must consume before it starts a gated agent. Review rounds and
 * verification rounds live in separate files with the same schema, so a
 * verifier never spends a review round and existing review ledgers load
 * unchanged. Any ledger problem fails closed (*_STATE_UNAVAILABLE); the ledger
 * is never reset.
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
export const VERIFICATION_ROLES: readonly string[] = ["verifier"];
export const MAX_REVIEW_ROUNDS_PER_TASK = 3;
export const MAX_REVIEW_ROUNDS_PER_SESSION = 9;
export const MAX_VERIFICATION_ROUNDS_PER_TASK = 6;
export const MAX_VERIFICATION_ROUNDS_PER_SESSION = 18;
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
export type RoundClass = "review" | "verification";
type CodePrefix = "REVIEW" | "VERIFY";
export type ReviewErrorCode =
  | `${CodePrefix}_ROUND_LIMIT`
  | `${CodePrefix}_SESSION_LIMIT`
  | `${CodePrefix}_WORK_TASK_REQUIRED`
  | `${CodePrefix}_STATE_UNAVAILABLE`;

interface RoundPolicy {
  readonly roles: readonly string[];
  readonly perTask: number;
  readonly perSession: number;
  /** Capitalized round noun: "Review" / "Verification". */
  readonly title: string;
  readonly noun: string;
  readonly agentNoun: string;
  readonly code: CodePrefix;
  readonly command: string;
  /** Ledger file name suffix; review keeps the original `<root>.json` name. */
  readonly fileSuffix: string;
}

const POLICIES = {
  review: {
    roles: REVIEW_ROLES,
    perTask: MAX_REVIEW_ROUNDS_PER_TASK,
    perSession: MAX_REVIEW_ROUNDS_PER_SESSION,
    title: "Review",
    noun: "review",
    agentNoun: "reviewer",
    code: "REVIEW",
    command: "/review-continue",
    fileSuffix: "",
  },
  verification: {
    roles: VERIFICATION_ROLES,
    perTask: MAX_VERIFICATION_ROUNDS_PER_TASK,
    perSession: MAX_VERIFICATION_ROUNDS_PER_SESSION,
    title: "Verification",
    noun: "verification",
    agentNoun: "verifier",
    code: "VERIFY",
    command: "/verify-continue",
    // Root session ids cannot contain ".", so this never collides with a review ledger.
    fileSuffix: ".verification",
  },
} satisfies Record<RoundClass, RoundPolicy>;

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

function hasRole(roles: readonly string[], type: string): boolean {
  const lowered = type.toLowerCase();
  return roles.some((role) => role.toLowerCase() === lowered);
}

/** Whether `type` (case-insensitive) is a review role subject to the review cap. */
export function isReviewRole(type: string): boolean {
  return hasRole(REVIEW_ROLES, type);
}

/** Whether `type` (case-insensitive) is a verification role subject to the verification cap. */
export function isVerificationRole(type: string): boolean {
  return hasRole(VERIFICATION_ROLES, type);
}

/** The round class gating `type`, or undefined for an ungated role. */
export function roundClassOf(type: string): RoundClass | undefined {
  if (isReviewRole(type)) return "review";
  if (isVerificationRole(type)) return "verification";
  return undefined;
}

/** Whether `type` needs an admission ticket (review or verification role). */
export function isRoundGatedRole(type: string): boolean {
  return roundClassOf(type) !== undefined;
}

export function isValidWorkTask(value: string): boolean {
  return isWorkTask(value);
}

// --- Messages ------------------------------------------------------------

// Every builder defaults to the review class, whose wording is unchanged.

export function roundLimitMessage(
  workTask: string,
  used: number,
  allowed: number,
  roundClass: RoundClass = "review",
): string {
  const p = POLICIES[roundClass];
  const next =
    roundClass === "review"
      ? "triage the latest findings, finish in-scope fixes and validation, and report the remaining risk"
      : "report the latest verification results and the remaining risk";
  return (
    `${p.title} round refused [${p.code}_ROUND_LIMIT]: work task "${workTask}" has used ${used}/${allowed} ${p.noun} rounds. ` +
    `No ${p.agentNoun} was started. Do not retry: ${next}. ` +
    `Only the user can authorize more rounds with ${p.command} ${workTask} [rounds].`
  );
}

export function sessionLimitMessage(
  used: number,
  allowed: number,
  taskCount: number,
  roundClass: RoundClass = "review",
): string {
  const p = POLICIES[roundClass];
  const verb = roundClass === "review" ? "reviewing" : "verifying";
  return (
    `${p.title} round refused [${p.code}_SESSION_LIMIT]: this session has used ${used}/${allowed} ${p.noun} rounds across ${taskCount} work tasks. ` +
    `No ${p.agentNoun} was started. Do not retry or open a new work task to continue ${verb}; report the remaining risk. ` +
    `Only the user can authorize more rounds with ${p.command} <id> [rounds].`
  );
}

export function workTaskRequiredMessage(agentType: string): string {
  const roundClass = roundClassOf(agentType) ?? "review";
  const p = POLICIES[roundClass];
  return (
    `${p.title} round refused [${p.code}_WORK_TASK_REQUIRED]: "${agentType}" is a ${p.noun} role; pass work_task (lowercase letters, digits and hyphens, 1-64 characters) naming the work task. ` +
    `Reuse the same work_task for every ${p.noun} round of that task, including after follow-ups.`
  );
}

export function stateUnavailableMessage(reason: string, roundClass: RoundClass = "review"): string {
  const p = POLICIES[roundClass];
  return (
    `${p.title} round refused [${p.code}_STATE_UNAVAILABLE]: the ${p.noun}-round ledger could not be read or locked (${reason}). ` +
    `No ${p.agentNoun} was started; report this to the user.`
  );
}

export function scheduleUnsupportedMessage(agentType = "reviewer"): string {
  const p = POLICIES[roundClassOf(agentType) ?? "review"];
  return `${p.title} round refused [${p.code}_SCHEDULE_UNSUPPORTED]: ${p.noun} roles cannot be scheduled; spawn the ${p.agentNoun} when the ${p.noun} is due.`;
}

export function admissionRequiredMessage(agentType: string): string {
  const p = POLICIES[roundClassOf(agentType) ?? "review"];
  return (
    `${p.title} admission required [${p.code}_ADMISSION_REQUIRED]: "${agentType}" is a ${p.noun} role and this launch path has no ${p.noun}-round admission. ` +
    "Use the Agent tool with work_task."
  );
}

export function admittedNotice(
  workTask: string,
  round: number,
  allowed: number,
  sessionUsed: number,
  sessionAllowed: number,
  roundClass: RoundClass = "review",
): string {
  const p = POLICIES[roundClass];
  const tail = `session total ${sessionUsed}/${sessionAllowed}).`;
  return round === 1
    ? `${p.title} round 1/${allowed} admitted for work task "${workTask}" (new ${p.noun} budget; ${tail}`
    : `${p.title} round ${round}/${allowed} admitted for work task "${workTask}" (${tail}`;
}

export function grantedMessage(
  rounds: number,
  workTask: string,
  used: number,
  allowed: number,
  sessionUsed: number,
  sessionAllowed: number,
  roundClass: RoundClass = "review",
): string {
  const p = POLICIES[roundClass];
  return `Granted ${rounds} more ${p.noun} round(s) for work task "${workTask}" (now ${used}/${allowed}; session ${sessionUsed}/${sessionAllowed}).`;
}

export const NO_ROUNDS_MESSAGE = "No review rounds recorded in this session.";
export const NO_VERIFICATION_ROUNDS_MESSAGE = "No verification rounds recorded in this session.";
export const REVIEW_CONTINUE_USAGE = "Usage: /review-continue [<work_task> [rounds 1-3]]";
export const VERIFY_CONTINUE_USAGE = "Usage: /verify-continue [<work_task> [rounds 1-3]]";

export function continueUsage(roundClass: RoundClass): string {
  return roundClass === "review" ? REVIEW_CONTINUE_USAGE : VERIFY_CONTINUE_USAGE;
}

function noRoundsMessage(roundClass: RoundClass): string {
  return roundClass === "review" ? NO_ROUNDS_MESSAGE : NO_VERIFICATION_ROUNDS_MESSAGE;
}

// --- Tickets -------------------------------------------------------------

export type ExemptReason = "user-mention" | "hook-continuation";

export interface ReviewTicket {
  readonly roundId: string;
  readonly workTask: string;
  readonly rootSessionId: string;
  readonly exemptReason?: ExemptReason;
  /** Ledger class of an admitted round; absent on exempt tickets (review by default). */
  readonly roundClass?: RoundClass;
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

/** Test seams for the lock; production callers pass nothing. */
export interface LockOptions {
  timeoutMs?: number;
  /** Runs after a lock was judged stale and before it is removed. */
  beforeStaleRemoval?: () => Promise<void>;
}

/**
 * Take the cross-process lock and resolve its owner token. The token is the
 * lock file's content: stale recovery removes the lock only while it still
 * holds the token that was judged stale, and {@link releaseLock} removes it
 * only while it holds the caller's token, so neither can delete a lock another
 * writer has since created. A residual window of one filesystem call between
 * the token re-read and the unlink remains (plain files offer no atomic
 * compare-and-delete); it needs a lock older than LOCK_STALE_MS to open.
 */
export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<string> {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  for (;;) {
    if (await createExclusiveFile(lockPath, token)) return token;
    let observed: string | undefined;
    let stale = false;
    try {
      observed = await readTextIfExists(lockPath);
      if (observed === undefined) continue; // vanished — retry immediately
      const info = await stat(lockPath);
      stale = Date.now() - info.mtimeMs > LOCK_STALE_MS;
    } catch {
      continue; // lock vanished between read and stat — retry immediately
    }
    if (stale) {
      await options.beforeStaleRemoval?.();
      const current = await readTextIfExists(lockPath).catch(() => undefined);
      if (current === observed) await unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for the ledger lock");
    await delay(LOCK_RETRY_MS);
  }
}

/** Remove the lock only while it still carries `token`. */
export async function releaseLock(lockPath: string, token: string): Promise<void> {
  const current = await readTextIfExists(lockPath).catch(() => undefined);
  if (current === token) await unlink(lockPath).catch(() => undefined);
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

  private pathFor(rootSessionId: string, roundClass: RoundClass): string {
    return join(this.rootDir, `${rootSessionId}${POLICIES[roundClass].fileSuffix}.json`);
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
  private async mutate<T>(
    rootSessionId: string,
    roundClass: RoundClass,
    fn: (ledger: Ledger) => Mutation<T>,
  ): Promise<T> {
    if (!isRootSessionId(rootSessionId)) {
      throw new LedgerUnavailableError("invalid root session id");
    }
    const path = this.pathFor(rootSessionId, roundClass);
    const lockPath = `${path}.lock`;
    return serialize(path, async () => {
      let token: string;
      try {
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        token = await acquireLock(lockPath);
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
        await releaseLock(lockPath, token);
      }
    });
  }

  /**
   * Reserve a round for a review or verification role (the class follows
   * `agentType`; an ungated type is treated as review). The round stays
   * counted unless {@link release}d.
   */
  async admit(request: AdmitRequest): Promise<AdmitResult> {
    const roundClass = roundClassOf(request.agentType) ?? "review";
    const p = POLICIES[roundClass];
    if (!isValidWorkTask(request.workTask)) {
      return {
        ok: false,
        code: `${p.code}_WORK_TASK_REQUIRED`,
        message: workTaskRequiredMessage(request.agentType),
      };
    }
    try {
      return await this.mutate<AdmitResult>(request.rootSessionId, roundClass, (ledger) => {
        const existing = taskOf(ledger, request.workTask);
        const used = existing === undefined ? 0 : usedOf(existing);
        const allowed = p.perTask + (existing?.granted ?? 0);
        if (used >= allowed) {
          return {
            result: {
              ok: false,
              code: `${p.code}_ROUND_LIMIT`,
              message: roundLimitMessage(request.workTask, used, allowed, roundClass),
            },
            changed: false,
          };
        }
        const sessionUsed = sessionUsedOf(ledger);
        const sessionAllowed = p.perSession + ledger.sessionGranted;
        if (sessionUsed >= sessionAllowed) {
          return {
            result: {
              ok: false,
              code: `${p.code}_SESSION_LIMIT`,
              message: sessionLimitMessage(
                sessionUsed,
                sessionAllowed,
                activeTaskCount(ledger),
                roundClass,
              ),
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
          roundClass,
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
              roundClass,
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
          code: `${p.code}_STATE_UNAVAILABLE`,
          message: stateUnavailableMessage(reasonOf(error), roundClass),
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
      return await this.mutate(ticket.rootSessionId, ticket.roundClass ?? "review", (ledger) => {
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
    roundClass: RoundClass = "review",
  ): Promise<{ ok: boolean; message: string }> {
    const p = POLICIES[roundClass];
    if (
      !isValidWorkTask(workTask) ||
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > MAX_GRANT_ROUNDS
    ) {
      return { ok: false, message: continueUsage(roundClass) };
    }
    try {
      return await this.mutate<{ ok: boolean; message: string }>(
        rootSessionId,
        roundClass,
        (ledger) => {
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
                p.perTask + task.granted,
                sessionUsedOf(ledger),
                p.perSession + ledger.sessionGranted,
                roundClass,
              ),
            },
            changed: true,
          };
        },
      );
    } catch (error) {
      if (error instanceof LedgerUnavailableError) {
        return { ok: false, message: stateUnavailableMessage(reasonOf(error), roundClass) };
      }
      throw error;
    }
  }

  /** One line per work task plus the session total, or the empty-ledger message. */
  async summary(rootSessionId: string, roundClass: RoundClass = "review"): Promise<string> {
    const p = POLICIES[roundClass];
    try {
      return await this.mutate(rootSessionId, roundClass, (ledger) => {
        const entries = Object.entries(ledger.workTasks);
        if (entries.length === 0) return { result: noRoundsMessage(roundClass), changed: false };
        const lines = entries.map(
          ([id, task]) => `"${id}": ${usedOf(task)}/${p.perTask + task.granted} ${p.noun} rounds`,
        );
        lines.push(
          `Session total: ${sessionUsedOf(ledger)}/${p.perSession + ledger.sessionGranted}`,
        );
        return { result: lines.join("\n"), changed: false };
      });
    } catch (error) {
      if (error instanceof LedgerUnavailableError) {
        return stateUnavailableMessage(reasonOf(error), roundClass);
      }
      throw error;
    }
  }
}
