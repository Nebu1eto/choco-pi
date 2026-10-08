import { conditionalProperties } from "../runtime-values.ts";
import { isBoundaryValue, JsonObjectSchema, type BoundaryValue } from "../runtime-values.ts";
import { Value } from "typebox/value";
import { validateToolArguments, type JsonObject as PiJsonObject } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const PiJsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);
const PiJsonObjectSchema = Type.Unsafe<PiJsonObject>({
  type: "object",
  additionalProperties: PiJsonValueSchema,
});

const WebRunDetailsSchema = Type.Object({ webRun: Type.Unknown() });

/**
 * Per-session tool scopes published by choco-pi-subagents for its children.
 * A bridged session tool can run without Pi's `tool_call` hooks (the direct
 * `execute()` fallback below), so the bridge must consult the calling
 * session's scope itself. Typed independently over `Symbol.for` because a
 * package must not import another; a session without a scope is unrestricted.
 */
const TOOL_SCOPE_SYMBOL = Symbol.for("choco-pi.tool-scope.v1");
const ToolScopeRegistrySchema = Type.Object({
  isToolAllowed: Type.Function(
    [Type.Object({ getSessionId: Type.Function([], Type.String()) }), Type.String()],
    Type.Boolean(),
  ),
});

/**
 * `structuredContent` of Pi's shell tools (`bash`, `powershell`): the full output up to 1 MiB,
 * whether it was cut, the spill file when it was, the exit code and the wall time.
 */
const ShellStructuredContentSchema = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  full_output_path: Type.Optional(Type.String()),
  exit_code: Type.Number(),
  wall_time_seconds: Type.Number(),
});

/** Pi's native validator appends the raw payload after this marker; code mode never surfaces it. */
const RECEIVED_ARGUMENTS_MARKER = "\n\nReceived arguments:\n";
const VALIDATION_FAILURE_PREFIX = 'Validation failed for tool "';
const MAX_REPORTED_ISSUES = 3;
const MAX_ISSUE_LENGTH = 160;

import type {
  ProgrammaticCodeModeToolDefinition,
  CodeModeToolIdentity,
  ToolExecutionContext,
} from "../../tools/code-mode/types.ts";

interface NestedToolLifecycle {
  start?(id: string, input: BoundaryValue): void;
  end?(id: string): void;
}

interface NestedToolContractBase {
  kind?: "function" | "freeform";
  /** Deferred tools stay out of the prompt and are discovered through ALL_TOOLS. */
  deferLoading?: boolean;
  toolName?: CodeModeToolIdentity;
  yieldTimeMs?: number;
  prepareInput?(input: BoundaryValue): BoundaryValue;
}

/** Run the wrapped definition itself; used for Codex-native tool instances code mode owns. */
interface DirectNestedToolContract<TDetails> extends NestedToolContractBase {
  dispatch?: "direct";
  resultError?(result: AgentToolResult<TDetails>): string | undefined;
  resultValue?(result: AgentToolResult<TDetails>): BoundaryValue;
}

/**
 * Run a session-registered tool through `ctx.executeTool()` when the session lists it as
 * callable, so the call gets Pi's hooks, nested-call events, `nestedCalls` record and usage
 * folding. A registered tool the session does not list as callable (an inactive `direct` tool)
 * keeps running its definition directly, as before. Session outcomes carry untyped details, so
 * this variant takes no details-typed result hooks.
 */
interface SessionNestedToolContract extends NestedToolContractBase {
  dispatch: "session";
}

type NestedToolContract<TDetails> = DirectNestedToolContract<TDetails> | SessionNestedToolContract;

export function toNestedTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  usage: string,
  lifecycle: NestedToolLifecycle = {},
  contract: NestedToolContract<TDetails> = {},
): ProgrammaticCodeModeToolDefinition {
  const kind = contract.kind ?? "function";
  const prepareInput = (input: BoundaryValue) =>
    contract.prepareInput ? contract.prepareInput(input) : input;
  return {
    name: tool.name,
    label: tool.label,
    usage,
    description: tool.description,
    deferLoading: contract.deferLoading === true,
    kind,
    ...conditionalProperties(Boolean(contract.toolName), { toolName: contract.toolName }),
    ...conditionalProperties(contract.yieldTimeMs !== undefined, {
      yieldTimeMs: contract.yieldTimeMs,
    }),
    ...conditionalProperties(kind === "function", { inputSchema: tool.parameters }),
    ...conditionalProperties<Pick<ProgrammaticCodeModeToolDefinition, "renderCall">>(
      Boolean(tool.renderCall),
      {
        renderCall: (input, theme, context) => {
          const parsedInput = isBoundaryValue(input) ? input : undefined;
          // SAFETY: The shallow boundary guard preserves renderer input without traversing live values.
          return tool.renderCall!(
            prepareInput(parsedInput) as never,
            theme as never,
            context as never,
          );
        },
      },
    ),
    ...conditionalProperties<Pick<ProgrammaticCodeModeToolDefinition, "renderResult">>(
      Boolean(tool.renderResult),
      {
        renderResult: (result, options, theme, context) =>
          // SAFETY: Code mode forwards Pi's RuntimeToolResult and render context unchanged to the registered tool renderer.
          tool.renderResult!(result as never, options, theme as never, context as never),
      },
    ),
    async invoke(input, context, signal) {
      if (signal.aborted) throw new Error(`${tool.name} aborted`);
      const extensionContext = requireExtensionContext(context);
      if (contract.dispatch === "session" && !isInSessionToolScope(extensionContext, tool.name)) {
        throw new Error(
          `Code mode tool error [not_available]: ${tool.name} is not available to this session.`,
        );
      }
      const parsedInput = isBoundaryValue(input) ? input : undefined;
      const schemaInput =
        parsedInput === undefined && Value.Check(tool.parameters, {}) ? {} : parsedInput;
      const toolInput = prepareInput(schemaInput);
      const prepared = tool.prepareArguments ? tool.prepareArguments(toolInput) : toolInput;
      const validation = validateBridgedArguments(
        tool,
        isBoundaryValue(prepared) ? prepared : undefined,
      );
      if (!validation.ok) {
        const issues = validation.issues;
        const hint =
          tool.name === "read_text"
            ? " read_text accepts UI refs, not filesystem paths; use an available filesystem reader for files."
            : "";
        throw new Error(
          `Code mode tool error [invalid_arguments]: ${tool.name} prepared input does not match its registered schema${issues ? ` (${issues})` : ""}.${hint}`,
        );
      }
      const validated = validation.value;
      if (signal.aborted) throw new Error(`${tool.name} aborted`);
      const toolCallId = context.toolCallId ?? `code-mode-${tool.name}`;
      const lifecycleInput = isBoundaryValue(validated) ? validated : undefined;
      lifecycle.start?.(toolCallId, lifecycleInput);
      context.refreshTrace?.();
      try {
        if (contract.dispatch === "session" && isSessionCallable(extensionContext, tool.name)) {
          // Pi prepares and validates the arguments again, exactly as for a model-issued call.
          const outcome = await extensionContext.executeTool(tool.name, toolInput, {
            signal,
            onUpdate: (update) => forwardUpdate(update, context),
          });
          const result: AgentToolResult<unknown> = outcome.result;
          const structured = shellStructuredResult(result);
          if (outcome.isError && structured === undefined)
            throw new Error(resultText(result) || `${tool.name} failed`);
          context.captureResult?.(result);
          return structured ?? compactNestedResult(result);
        }
        const result = await tool.execute(
          toolCallId,
          validated,
          signal,
          (update) => forwardUpdate(update, context),
          extensionContext,
        );
        const direct = contract.dispatch === "session" ? undefined : contract;
        const resultError = direct?.resultError?.(result);
        if (resultError) throw new Error(resultError);
        context.captureResult?.(result);
        return direct?.resultValue?.(result) ?? compactNestedResult(result);
      } finally {
        lifecycle.end?.(toolCallId);
      }
    },
  };
}

/** Prepared code-mode payloads crossing the bridge before schema validation. */
type BridgeCandidate = BoundaryValue | undefined;

/** The executor's own parameter type, which tracks the SDK's bundled typebox build. */
type ExecuteParams<TParams extends TSchema, TDetails, TState> = Parameters<
  ToolDefinition<TParams, TDetails, TState>["execute"]
>[1];

type BridgedArguments<TParams extends TSchema, TDetails, TState> =
  | { ok: true; value: ExecuteParams<TParams, TDetails, TState> }
  | { ok: false; issues: string };

/**
 * Schema guard for the executor parameter type.
 *
 * SAFETY: the predicate is decided by a real schema check against the tool's own
 * parameters; the declared type only reconciles the structurally identical
 * `Static` instantiations of the host and SDK typebox builds.
 */
function matchesToolParameters<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  value: BridgeCandidate,
): value is ExecuteParams<TParams, TDetails, TState> {
  return Value.Check(tool.parameters, value);
}

/**
 * Validate prepared code-mode arguments exactly as Pi validates a native tool call.
 *
 * Object payloads go through the SDK's public validator, so optional-null removal,
 * scalar conversion, and the cloned argument object match a directly registered tool.
 * Non-object payloads keep their previous bare schema check, which preserves freeform
 * inputs and explicit top-level null rejection for object-only schemas. A native failure
 * that is not a validation rejection propagates unchanged, as it would for a directly
 * registered tool call, and never reaches the executor.
 */
function validateBridgedArguments<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  prepared: BridgeCandidate,
): BridgedArguments<TParams, TDetails, TState> {
  if (Value.Check(JsonObjectSchema, prepared)) {
    try {
      const cloned = structuredClone(prepared);
      if (!isPiJsonObject(cloned)) {
        return { ok: false, issues: describeSchemaIssues(tool.parameters, cloned) };
      }
      const normalized: unknown = validateToolArguments(
        { name: tool.name, description: tool.description, parameters: tool.parameters },
        { type: "toolCall", id: `code-mode-${tool.name}`, name: tool.name, arguments: cloned },
      );
      const validated: BridgeCandidate = isBoundaryValue(normalized) ? normalized : undefined;
      if (matchesToolParameters(tool, validated)) return { ok: true, value: validated };
      return { ok: false, issues: describeSchemaIssues(tool.parameters, validated) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith(VALIDATION_FAILURE_PREFIX)) {
        // The schema-aware description collapses union branches; fall back to the native
        // bullets only when typebox cannot reproduce the failure (e.g. converter-only rejects).
        const schemaIssues = describeSchemaIssues(tool.parameters, prepared);
        return { ok: false, issues: schemaIssues || describeNativeIssues(message) };
      }
      // Not a validation rejection: propagate it instead of executing on unvalidated input.
      throw error;
    }
  }
  if (matchesToolParameters(tool, prepared)) return { ok: true, value: prepared };
  return { ok: false, issues: describeSchemaIssues(tool.parameters, prepared) };
}

function isPiJsonObject(value: BoundaryValue): value is PiJsonObject {
  return Value.Check(PiJsonObjectSchema, value);
}

function boundIssue(issue: string): string {
  const flattened = issue.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_ISSUE_LENGTH
    ? `${flattened.slice(0, MAX_ISSUE_LENGTH)}…`
    : flattened;
}

const UnionBranchSchema = Type.Object({
  properties: Type.Record(Type.String(), Type.Object({ const: Type.Optional(Type.Unknown()) })),
});
const UnionSchema = Type.Object({ anyOf: Type.Array(UnionBranchSchema) });
/** The two schema shapes the path walk needs: a property map or an array item schema. */
const PropertiesNodeSchema = Type.Object({
  properties: Type.Record(Type.String(), Type.Unknown()),
});
const ItemsNodeSchema = Type.Object({ items: Type.Unknown() });

/**
 * For an object union keyed by a literal (e.g. `action: "click" | "press"`), name the key and the
 * accepted values instead of repeating one branch's complaint per alternative.
 */
function unionHint(schema: TSchema, instancePath: string): string | undefined {
  let node: unknown = schema;
  for (const segment of instancePath.split("/").filter(Boolean)) {
    if (/^\d+$/.test(segment)) {
      if (!Value.Check(ItemsNodeSchema, node)) return undefined;
      node = node.items;
      continue;
    }
    if (!Value.Check(PropertiesNodeSchema, node)) return undefined;
    node = node.properties[segment];
  }
  if (!Value.Check(UnionSchema, node)) return undefined;
  const keys = new Map<string, string[]>();
  for (const branch of node.anyOf) {
    for (const [key, property] of Object.entries(branch.properties)) {
      if (property.const === undefined) continue;
      const values = keys.get(key) ?? [];
      values.push(JSON.stringify(property.const));
      keys.set(key, values);
    }
  }
  const [key, values] = [...keys.entries()].find(([, v]) => v.length === node.anyOf.length) ?? [];
  if (!key || !values) return undefined;
  return `expected one of the ${node.anyOf.length} shapes selected by "${key}": ${values.join(", ")}`;
}

/** Schema issues name their instance path, collapse union branches, and never echo the value. */
function describeSchemaIssues(schema: TSchema, value: BridgeCandidate): string {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const issue of Value.Errors(schema, value)) {
    if (issues.length >= MAX_REPORTED_ISSUES) break;
    const path = issue.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
    const hint = unionHint(schema, issue.instancePath);
    const text = hint ? `${path}: ${hint}` : `${path}: ${issue.message}`;
    if (seen.has(text)) continue;
    seen.add(text);
    issues.push(boundIssue(text));
  }
  return issues.join("; ");
}

/** Keep the native validator's path-qualified bullets, deduplicated, without the raw arguments. */
function describeNativeIssues(message: string): string {
  const [head = ""] = message.split(RECEIVED_ARGUMENTS_MARKER);
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const line of head.split("\n")) {
    if (issues.length >= MAX_REPORTED_ISSUES) break;
    const issue = /^ {2}- (.+)$/.exec(line)?.[1];
    if (issue === undefined || seen.has(issue)) continue;
    seen.add(issue);
    issues.push(boundIssue(issue));
  }
  return issues.join("; ");
}

export function codeModeImageResult<TDetails>(
  result: AgentToolResult<TDetails>,
  outputHint?: string,
): BoundaryValue {
  const image = result.content.find((item) => item.type === "image");
  if (!image || image.type !== "image") return compactNestedResult(result);
  const detail =
    "detail" in image && Value.Check(Type.String(), image.detail) ? image.detail : "high";
  return {
    image_url: `data:${image.mimeType};base64,${image.data}`,
    detail,
    ...conditionalProperties(Boolean(outputHint), { output_hint: outputHint }),
  };
}

export function codeModeWebResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue {
  const details = result.details;
  if (Value.Check(WebRunDetailsSchema, details)) {
    const webRun = details.webRun;
    if (webRun && (Value.Check(JsonObjectSchema, webRun) || Array.isArray(webRun))) return webRun;
  }
  return compactNestedResult(result);
}

function requireExtensionContext(context: ToolExecutionContext): ExtensionToolContext {
  if (!context.extensionContext) throw new Error("Code-mode Pi context is unavailable");
  return context.extensionContext;
}

/** Whether the calling session's published tool scope admits `name`. */
function isInSessionToolScope(context: ExtensionToolContext, name: string): boolean {
  const registry = Object.getOwnPropertyDescriptor(globalThis, TOOL_SCOPE_SYMBOL)?.value;
  if (!Value.Check(ToolScopeRegistrySchema, registry)) return true;
  return registry.isToolAllowed(context.sessionManager, name);
}

/** Whether `ctx.executeTool()` can reach `name`: active `direct` tools and `codemode`/`deferred` ones. */
function isSessionCallable(context: ExtensionToolContext, name: string): boolean {
  return context.tools.some((candidate) => candidate.name === name);
}

function forwardUpdate<TDetails>(
  update: AgentToolResult<TDetails>,
  context: ToolExecutionContext,
): void {
  const content = update.content
    .filter((item) => item.type === "text" || item.type === "image")
    .map((item) => ({ ...item }));
  context.onUpdate?.({ content, details: update.details });
}

/**
 * Shell results resolve to their validated `structuredContent`, also for non-zero exits, so a
 * script sees the exit code, an empty output as `""`, and truncation with its spill file.
 */
function shellStructuredResult<TDetails>(
  result: AgentToolResult<TDetails>,
): BoundaryValue | undefined {
  const structured = result.structuredContent;
  if (!Value.Check(ShellStructuredContentSchema, structured)) return undefined;
  return {
    output: structured.output,
    truncated: structured.truncated,
    ...conditionalProperties(structured.full_output_path !== undefined, {
      full_output_path: structured.full_output_path,
    }),
    exit_code: structured.exit_code,
    wall_time_seconds: structured.wall_time_seconds,
  };
}

function resultText<TDetails>(result: AgentToolResult<TDetails>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function compactNestedResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue {
  const images = result.content.filter((item) => item.type === "image");
  if (images.length > 0) return { content: result.content, details: result.details };
  const structured = shellStructuredResult(result);
  if (structured !== undefined) return structured;
  if (Value.Check(JsonObjectSchema, result.details) && "output" in result.details)
    return result.details;
  return resultText(result) || "(no output)";
}
