import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.ts";
import { resolveSpawnType } from "./agent-types.ts";
import { resolveModel } from "./model-resolver.ts";
import type { ScheduleStore } from "./schedule-store.ts";
import type { IsolationMode, ScheduledSubagent, SubagentType, ThinkingLevel } from "./types.ts";

export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

export interface ScheduleDetection {
  type: "cron" | "once" | "interval";
  intervalMs?: number;
  normalized: string;
}

export interface CronValidation {
  valid: boolean;
  error?: string;
}

function durationUnitMs(unit: string | undefined): number {
  if (unit === "s") return 1000;
  if (unit === "m") return 60_000;
  if (unit === "h") return 3_600_000;
  if (unit === "d") return 86_400_000;
  return Number.NaN;
}

export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  timeout_ms?: number;
  max_tool_calls?: number;
  max_tokens?: number;
  idle_timeout_ms?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
  fast_mode?: boolean;
  daybreak?: boolean;
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  start(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    manager: AgentManager,
    store: ScheduleStore,
  ): void {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (job.enabled) this.scheduleJob(job);
    }
  }

  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) clearTimeout(t);
    this.intervals.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  buildJob(input: NewJobInput): ScheduledSubagent {
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      timeout_ms: input.timeout_ms,
      max_tool_calls: input.max_tool_calls,
      max_tokens: input.max_tokens,
      idle_timeout_ms: input.idle_timeout_ms,
      isolated: input.isolated,
      isolation: input.isolation,
      fast_mode: input.fast_mode,
      daybreak: input.daybreak,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
  }

  async addJob(input: NewJobInput): Promise<ScheduledSubagent> {
    const store = this.requireStore();
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    const job = this.buildJob(input);
    if (!(await store.add(job))) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    if (this.store !== store) return job;
    if (job.enabled) this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  async removeJob(id: string): Promise<boolean> {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    const ok = await store.remove(id);
    if (ok && this.store === store) this.emit({ type: "removed", jobId: id });
    return ok;
  }

  async updateJob(
    id: string,
    patch: Partial<ScheduledSubagent>,
  ): Promise<ScheduledSubagent | undefined> {
    const store = this.requireStore();
    const updated = await store.update(id, patch);
    if (!updated || this.store !== store) return updated;
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      const base = job.lastRun ? new Date(job.lastRun).getTime() : Date.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  private persist(
    store: ScheduleStore,
    id: string,
    patch: Partial<ScheduledSubagent>,
    then?: (updated: ScheduledSubagent | undefined) => void,
  ): void {
    store.update(id, patch).then(
      (updated) => {
        if (this.store === store) then?.(updated);
      },
      (err) => {
        if (this.store !== store) return;
        this.emit({
          type: "error",
          jobId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  private scheduleJob(job: ScheduledSubagent): void {
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        const t = setInterval(() => this.executeJob(job.id), job.intervalMs);
        this.intervals.set(job.id, t);
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        const delay = target - Date.now();
        if (delay > 0) {
          const t = setTimeout(() => {
            this.executeJob(job.id);
            this.persist(store, job.id, { enabled: false }, () => {
              const updated = store.get(job.id);
              if (updated) this.emit({ type: "updated", job: updated });
            });
          }, delay);
          this.intervals.set(job.id, t);
        } else {
          this.persist(store, job.id, { enabled: false, lastStatus: "error" });
          this.emit({
            type: "error",
            jobId: job.id,
            error: `Scheduled time ${job.schedule} is in the past`,
          });
        }
      } else {
        const cron = new Cron(job.schedule, () => this.executeJob(job.id));
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({
        type: "error",
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.intervals.delete(id);
    }
  }

  private executeJob(id: string): void {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    if (!store || !pi || !ctx || !manager) return;
    const job = store.get(id);
    if (!job?.enabled) return;

    this.persist(store, id, { lastStatus: "running" });

    let resolvedModel: any | undefined;
    if (job.model) {
      const resolution = resolveModel(job.model, ctx.modelRegistry);
      switch (resolution.tag) {
        case "resolved":
          resolvedModel = resolution.model;
          break;
        case "error":
          break;
      }
    }

    let agentId: string;
    try {
      const dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      agentId = manager.spawn(pi, ctx, dispatch.type, job.prompt, {
        description: job.description,
        isBackground: true,
        bypassQueue: true,
        model: resolvedModel,
        maxTurns: job.max_turns,
        budgets: {
          timeoutMs: job.timeout_ms,
          maxToolCalls: job.max_tool_calls,
          maxTokens: job.max_tokens,
          idleTimeoutMs: job.idle_timeout_ms,
        },
        isolated: job.isolated,
        thinkingLevel: job.thinking,
        fastModeRequested: job.fast_mode,
        daybreakRequested: job.daybreak,
        isolation: job.isolation,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.persist(store, id, { lastRun: new Date().toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error });
      return;
    }

    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const record = manager.getRecord(agentId);
    const finalize = (status: "success" | "error") => {
      const next = this.getNextRun(id);
      const current = store.get(id);
      this.persist(store, id, {
        lastRun: new Date().toISOString(),
        lastStatus: status,
        runCount: (current?.runCount ?? 0) + 1,
        nextRun: next,
      });
    };

    if (record?.promise) {
      record.promise
        .then(() => {
          const r = manager.getRecord(agentId);
          const failed =
            r?.status === "error" ||
            r?.status === "aborted" ||
            r?.status === "stopped" ||
            r?.status === "budget_exceeded" ||
            r?.status === "watchdog_stopped";
          finalize(failed ? "error" : "success");
        })
        .catch(() => finalize("error"));
    } else {
      finalize("success");
    }
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  static detectSchedule(s: string): ScheduleDetection {
    const trimmed = s.trim();
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`,
    );
  }

  static validateCronExpression(expr: string): CronValidation {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      new Cron(expr, () => {});
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * durationUnitMs(m[2]);
    return new Date(Date.now() + ms).toISOString();
  }

  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * durationUnitMs(m[2]);
  }
}
