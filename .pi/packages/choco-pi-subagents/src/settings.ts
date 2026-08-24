// Persistence for choco-pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { NO_FALLBACK } from "./agent-types.ts";
import { MAX_CONCURRENT_SANITY_CAP, SUBAGENT_DEPTH_CEILING } from "./limits.ts";
import type { AgentMentionMode, JoinMode, WidgetMode } from "./types.ts";

export interface SubagentsSettings {
  /** Maximum concurrent background agents. 0 = unlimited, with a sanity cap of 1024. */
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against runtime LLM choices, not user-level config.
   * Out-of-scope handling reflects this:
   *   - Caller-supplied via `Agent({ model: "..." })` (only when frontmatter
   *     has no `model:`, since frontmatter is authoritative): hard error
   *     returned to the orchestrator, listing the allowed models. The LLM
   *     made an explicit out-of-scope choice and gets explicit feedback.
   *   - Frontmatter-pinned: warning toast + the pinned model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (neither caller nor frontmatter sets a model):
   *     warning toast + parent's model runs. The user chose the parent's
   *     model when starting the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /**
   * When true, an unreadable or unparseable agent `.md` aborts extension load
   * instead of being skipped with a warning — pi exits, naming the file.
   *
   * Startup only, by design. Mid-session reloads (one per `Agent` call) keep
   * warning: a bad edit at 3pm should not kill the session on the next
   * unrelated spawn, where the failure would look disconnected from its cause.
   * For a checked-in `.pi/agents/`, failing at startup is the point — the
   * alternative is running a *different* agent than the file names.
   * Defaults to false.
   */
  strictAgentFiles?: boolean;
  /**
   * When true, the three built-in default agents (general-purpose, Explore, Plan)
   * are not registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * Whether the Claude Code-style FleetView (the navigable main+subagents list
   * rendered below the editor) is shown. Defaults to `true`. Pure-UI: when off,
   * the list never registers and the global key handler never captures input.
   */
  fleetView?: boolean;
  /**
   * Whether `@handle message` typed at the prompt is routed to that subagent
   * instead of the main model, and whether `@` offers running agents alongside
   * pi's file completion. Defaults to `model`. Applied live.
   *
   *   - `model`: mentioning an agent that is not running asks the main model to
   *     spawn it with the `Agent` tool, Claude Code's behaviour. Costs a turn,
   *     and the model writes the agent's prompt rather than your text being it.
   *   - `direct`: that agent is started here instead, with the typed message as
   *     its prompt and no main-model turn spent.
   *   - `off`: the input hook falls straight through and the stacked
   *     autocomplete provider delegates everything back to pi's built-in one.
   *
   * Messaging a running agent and resuming a finished one are direct in both
   * `model` and `direct`. The legacy booleans are still accepted: `true` reads
   * as `model`, `false` as `off`.
   */
  agentMentions?: AgentMentionMode;
  /**
   * Whether subagents persist their pi session by default, so `@handle` can
   * reopen an agent's conversation long after its in-memory record is gone.
   * Defaults to `true`. Per-agent `persist_session:` frontmatter overrides it
   * in both directions. Turning it off restores the previous behaviour, where
   * a handle stops resolving roughly ten minutes after the agent finishes and
   * mentioning it starts a fresh run instead. Persisted sessions also appear
   * nested under the spawning session in pi's `/resume`.
   */
  rememberAgents?: boolean;
  /**
   * Display mode for the persistent above-editor agent widget:
   *   - `all`: show every agent (foreground + background).
   *   - `background`: hide foreground agents — they already render inline as the
   *     Agent tool result, so the widget would otherwise double-render them
   *     (#118); everything else (background, queued, scheduled, RPC) stays.
   *   - `off`: hide the widget entirely.
   * Defaults to `background`. Pure-UI and applied live (toggling refreshes the
   * widget).
   */
  widgetMode?: WidgetMode;
  /**
   * Project/global default for writing each subagent's `.output` transcript
   * (a JSON-lines copy of the run, stored under the OS temp dir).
   * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
   * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
   * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
   * overrides this per agent. This governs only the transcript — it does NOT
   * affect the persisted pi session (`persist_session`), worktree commits
   * (`isolation: worktree`), or memory files.
   */
  outputTranscript?: boolean;
  /**
   * Whether `isolation: "worktree"` may create a worktree at all. Defaults to
   * `true`. Set `false` on a repo where worktrees are too slow or too large to
   * be worth it (#184): a requested worktree is then dropped and the agent runs
   * in the main checkout.
   *
   * The drop is deliberately silent — there is no per-result note, because the
   * setting exists for projects whose model asks for a worktree on every call,
   * where a note would be noise on every result. What keeps the orchestrator
   * from claiming a `pi-agent-*` branch anyway is that it is never told the
   * capability exists: `isolationParam` (invocation-config.ts) drops the field
   * from both tool schemas, and `isolationGuideline` (index.ts) drops the
   * matching prose from the full and compact descriptions — a custom one opts
   * in via the `{{isolationGuideline}}` placeholder. Anything that
   * reintroduces the prose has to reintroduce a note with it.
   *
   * Deliberately a downgrade rather than an error. The fail-loud rule covers
   * worktrees that *cannot* be created; this is the user declining one, and
   * throwing would reject exactly the calls that the `isolation: "off"` value
   * exists to tolerate. Enforced below the tool boundary, so it also covers the
   * scheduler and the unvalidated cross-extension RPC path.
   */
  worktreeIsolation?: boolean;
  /**
   * Hard ceiling on nested subagent delegation, counted from the main session:
   * main = 0, its subagents = 1, their children = 2. Defaults to `2`; `0` or `1`
   * disables nesting project-wide. Read when a subagent session is built, so a
   * change applies to agents started after it.
   */
  maxSubagentDepth?: number;
  /**
   * Agent type substituted when a caller-supplied `subagent_type` doesn't
   * resolve to exactly one enabled agent (unknown, disabled, or ambiguous by
   * case). Omitted keeps the historical `general-purpose` fallback; a type name
   * routes those calls to that agent instead; `"none"` disables the fallback so
   * dispatch fails closed with an error naming the available types.
   *
   * The boolean `false` is accepted as a spelling of `"none"`, because a boolean
   * would otherwise be dropped as the wrong type and silently leave the
   * PERMISSIVE default in place while the author believes strict dispatch is on
   * — the wrong direction to fail for this setting. Every other value is an
   * agent name, so a mistaken `"off"` fails loudly at dispatch rather than
   * meaning one thing here and another in the resolver.
   */
  fallbackSubagent?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setFallbackSubagent: (v: string | undefined) => void;
}

/** Payloads emitted when settings are loaded or changed. */
export type SettingsEventPayload =
  | { settings: SubagentsSettings }
  | { settings: SubagentsSettings; persisted: boolean };

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: SettingsEventPayload) => void;

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const JsonNumberSchema = Type.Number();
const JsonBooleanSchema = Type.Boolean();
const JsonStringSchema = Type.String();

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return Value.Check(JsonNumberSchema, value) ? value : undefined;
}

function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return Value.Check(JsonBooleanSchema, value) ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return Value.Check(JsonStringSchema, value) ? value : undefined;
}

function boundedInteger(
  value: JsonValue | undefined,
  min: number,
  max: number,
): number | undefined {
  const parsed = asNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined;
}

function parseJoinMode(value: JsonValue | undefined): JoinMode | undefined {
  return value === "async" || value === "group" || value === "smart" ? value : undefined;
}

function parseToolDescriptionMode(value: JsonValue | undefined): ToolDescriptionMode | undefined {
  return value === "full" || value === "compact" || value === "custom" ? value : undefined;
}

function parseWidgetMode(value: JsonValue | undefined): WidgetMode | undefined {
  return value === "all" || value === "background" || value === "off" ? value : undefined;
}

function parseAgentMentionMode(value: JsonValue | undefined): AgentMentionMode | undefined {
  if (value === true) return "model";
  if (value === false) return "off";
  return value === "model" || value === "direct" || value === "off" ? value : undefined;
}

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
export function sanitizeSettings(raw: JsonValue): SubagentsSettings {
  if (!isJsonObject(raw)) return {};
  const out: SubagentsSettings = {};
  const maxConcurrent = boundedInteger(raw.maxConcurrent, 0, MAX_CONCURRENT_SANITY_CAP);
  if (maxConcurrent !== undefined) out.maxConcurrent = maxConcurrent;
  const defaultMaxTurns = boundedInteger(raw.defaultMaxTurns, 0, MAX_TURNS_CEILING);
  if (defaultMaxTurns !== undefined) out.defaultMaxTurns = defaultMaxTurns;
  const graceTurns = boundedInteger(raw.graceTurns, 1, GRACE_TURNS_CEILING);
  if (graceTurns !== undefined) out.graceTurns = graceTurns;
  const maxSubagentDepth = boundedInteger(raw.maxSubagentDepth, 0, SUBAGENT_DEPTH_CEILING);
  if (maxSubagentDepth !== undefined) out.maxSubagentDepth = maxSubagentDepth;
  const defaultJoinMode = parseJoinMode(raw.defaultJoinMode);
  if (defaultJoinMode !== undefined) out.defaultJoinMode = defaultJoinMode;
  const schedulingEnabled = asBoolean(raw.schedulingEnabled);
  if (schedulingEnabled !== undefined) out.schedulingEnabled = schedulingEnabled;
  const scopeModels = asBoolean(raw.scopeModels);
  if (scopeModels !== undefined) out.scopeModels = scopeModels;
  const strictAgentFiles = asBoolean(raw.strictAgentFiles);
  if (strictAgentFiles !== undefined) out.strictAgentFiles = strictAgentFiles;
  const disableDefaultAgents = asBoolean(raw.disableDefaultAgents);
  if (disableDefaultAgents !== undefined) out.disableDefaultAgents = disableDefaultAgents;
  const toolDescriptionMode = parseToolDescriptionMode(raw.toolDescriptionMode);
  if (toolDescriptionMode !== undefined) out.toolDescriptionMode = toolDescriptionMode;
  const fleetView = asBoolean(raw.fleetView);
  if (fleetView !== undefined) out.fleetView = fleetView;
  const agentMentions = parseAgentMentionMode(raw.agentMentions);
  if (agentMentions !== undefined) out.agentMentions = agentMentions;
  const rememberAgents = asBoolean(raw.rememberAgents);
  if (rememberAgents !== undefined) out.rememberAgents = rememberAgents;
  const widgetMode = parseWidgetMode(raw.widgetMode);
  if (widgetMode !== undefined) out.widgetMode = widgetMode;
  const outputTranscript = asBoolean(raw.outputTranscript);
  if (outputTranscript !== undefined) out.outputTranscript = outputTranscript;
  const worktreeIsolation = asBoolean(raw.worktreeIsolation);
  if (worktreeIsolation !== undefined) out.worktreeIsolation = worktreeIsolation;
  const fallbackSubagent = asString(raw.fallbackSubagent);
  if (raw.fallbackSubagent === false) {
    // The only non-string spelling worth accepting: a boolean would otherwise be
    // dropped, silently leaving the PERMISSIVE default in place. Every string is
    // an agent name except the `none` sentinel, which the resolver recognizes —
    // so a mistaken "off" fails loudly at dispatch instead of meaning something
    // different here than it does there.
    out.fallbackSubagent = NO_FALLBACK;
  } else if (fallbackSubagent?.trim()) {
    out.fallbackSubagent = fallbackSubagent.trim();
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[choco-pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (s.maxConcurrent !== undefined) appliers.setMaxConcurrent(s.maxConcurrent);
  if (s.defaultMaxTurns !== undefined) appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (s.graceTurns !== undefined) appliers.setGraceTurns(s.graceTurns);
  if (s.maxSubagentDepth !== undefined) appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (s.fallbackSubagent !== undefined) appliers.setFallbackSubagent(s.fallbackSubagent);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (s.schedulingEnabled !== undefined) appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (s.scopeModels !== undefined) appliers.setScopeModels(s.scopeModels);
  if (s.strictAgentFiles !== undefined) appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (s.disableDefaultAgents !== undefined)
    appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (s.fleetView !== undefined) appliers.setFleetView(s.fleetView);
  if (s.agentMentions) appliers.setAgentMentions(s.agentMentions);
  if (s.rememberAgents !== undefined) appliers.setRememberAgents(s.rememberAgents);
  if (s.widgetMode) appliers.setWidgetMode(s.widgetMode);
  if (s.outputTranscript !== undefined) appliers.setOutputTranscript(s.outputTranscript);
  if (s.worktreeIsolation !== undefined) appliers.setWorktreeIsolation(s.worktreeIsolation);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
