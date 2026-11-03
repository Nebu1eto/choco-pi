import { isBoolean, isNumber, isString } from "../../value-guards.ts";
import { conditionalProperties } from "../runtime-values.ts";
import { isBoundaryValue, isJsonObject, type BoundaryValue } from "../runtime-values.ts";
import { validateToolArguments, type JsonObject as PiJsonObject } from "@earendil-works/pi-ai";
import { arr, bool, compile, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { CoercingValidator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HostSchema } from "../../schema-bridge.ts";
import { finiteNum } from "../../value-guards.ts";

/**
 * JSON object whose values are JSON (the argument shape Pi's validator takes). Numbers are bounded
 * so NaN and +/-Infinity, which structuredClone preserves but JSON cannot hold, stay rejected.
 */
const isPiJsonObject = compile({
  type: "object",
  additionalProperties: { $ref: "#/$defs/JsonValue" },
  $defs: {
    JsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/JsonValue" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
      ],
    },
  },
}).check;

/**
 * Per-session tool scopes published by choco-pi-subagents for its children.
 * A bridged session tool can run without Pi's `tool_call` hooks (the direct
 * `execute()` fallback below), so the bridge must consult the calling
 * session's scope itself. Typed independently over `Symbol.for` because a
 * package must not import another; a session without a scope is unrestricted.
 */
const TOOL_SCOPE_SYMBOL = Symbol.for("choco-pi.tool-scope.v1");

/**
 * `structuredContent` of Pi's shell tools (`bash`, `powershell`): the full output up to 1 MiB,
 * whether it was cut, the spill file when it was, the exit code and the wall time.
 */
const isShellStructuredContent = compile(
  obj(
    {
      output: str(),
      truncated: bool(),
      full_output_path: opt(str()),
      exit_code: finiteNum(),
      wall_time_seconds: finiteNum(),
    },
    { open: true },
  ),
).check;

/**
 * Details that name stored, retrievable content: web-access `fetch_content`/`source_check` set
 * `responseId` and `web_search` sets `searchId`; `get_search_content` needs that id to page the
 * content, so a nested result must keep it instead of collapsing to text.
 */
const isShortString = compile(str({ maxLength: 256 })).check;
/** Keys the retrievable result owns; detail scalars never overwrite them. */
const RETRIEVABLE_RESERVED_KEYS = new Set(["output"]);

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

export function toNestedTool<TParams extends HostSchema, TDetails, TState>(
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
        parsedInput === undefined && parameterValidator(tool.parameters).check({})
          ? {}
          : parsedInput;
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

/** The executor's own parameter type. */
type ExecuteParams<TParams extends HostSchema, TDetails, TState> = Parameters<
  ToolDefinition<TParams, TDetails, TState>["execute"]
>[1];

type BridgedArguments<TParams extends HostSchema, TDetails, TState> =
  | { ok: true; value: ExecuteParams<TParams, TDetails, TState> }
  | { ok: false; issues: string };

/**
 * Schema guard for the executor parameter type.
 *
 * The predicate is decided by a real schema check against the tool's own parameters.
 */
function matchesToolParameters<TParams extends HostSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  value: BridgeCandidate,
): value is ExecuteParams<TParams, TDetails, TState> {
  return parameterValidator(tool.parameters).check(value);
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
function validateBridgedArguments<TParams extends HostSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  prepared: BridgeCandidate,
): BridgedArguments<TParams, TDetails, TState> {
  if (isJsonObject(prepared)) {
    try {
      const cloned = structuredClone(prepared);
      if (!isPiJsonObjectValue(cloned)) {
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
        // bullets only when the schema check cannot reproduce the failure (e.g. converter-only rejects).
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

function isPiJsonObjectValue(value: BoundaryValue): value is PiJsonObject {
  return isPiJsonObject(value);
}

/**
 * One validator per tool schema, built with the options Pi's own tool validation uses
 * (pi-ai `validateToolArguments`: standard formats, coercion on, unresolved `$ref`s reject
 * instead of throwing), so this recheck accepts exactly what the host accepts.
 */
const parameterValidators = new WeakMap<HostSchema, CoercingValidator>();
function parameterValidator(schema: HostSchema): CoercingValidator {
  const cached = parameterValidators.get(schema);
  if (cached) return cached;
  const validator = compile(schema, { formats, coerce: true, unresolvedRefs: "reject" });
  parameterValidators.set(schema, validator);
  return validator;
}

function boundIssue(issue: string): string {
  const flattened = issue.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_ISSUE_LENGTH
    ? `${flattened.slice(0, MAX_ISSUE_LENGTH)}…`
    : flattened;
}

const isUnionNode = compile(
  obj(
    {
      anyOf: arr(
        obj({ properties: map(obj({ const: opt(unknown()) }, { open: true })) }, { open: true }),
      ),
    },
    { open: true },
  ),
).check;
/** The two schema shapes the path walk needs: a property map or an array item schema. */
const isPropertiesNode = compile(obj({ properties: map(unknown()) }, { open: true })).check;
const isItemsNode = compile(obj({ items: unknown() }, { open: true })).check;

/** A JSON Pointer's segments, unescaped. */
function pointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * For an object union keyed by a literal (e.g. `action: "click" | "press"`), name the key and the
 * accepted values instead of repeating one branch's complaint per alternative.
 */
function unionHint(schema: HostSchema, pointer: string): string | undefined {
  let node: BoundaryValue = schema;
  for (const segment of pointerSegments(pointer)) {
    if (/^\d+$/.test(segment)) {
      if (!isItemsNode(node)) return undefined;
      node = node.items;
      continue;
    }
    if (!isPropertiesNode(node)) return undefined;
    node = node.properties[segment];
  }
  if (!isUnionNode(node)) return undefined;
  const branches = node.anyOf;
  const keys = new Map<string, string[]>();
  for (const branch of branches) {
    for (const [key, property] of Object.entries(branch.properties)) {
      if (property.const === undefined) continue;
      const values = keys.get(key) ?? [];
      values.push(JSON.stringify(property.const));
      keys.set(key, values);
    }
  }
  const [key, values] = [...keys.entries()].find(([, v]) => v.length === branches.length) ?? [];
  if (!key || !values) return undefined;
  return `expected one of the ${branches.length} shapes selected by "${key}": ${values.join(", ")}`;
}

/**
 * pi-schema reports a failed union through the leaf errors of one branch (e.g. `/actions/0/ref`),
 * not at the union itself, so the nearest enclosing discriminated union of the error path supplies
 * the hint and the path it is reported under.
 */
function enclosingUnionHint(
  schema: HostSchema,
  pointer: string,
): { pointer: string; hint: string } | undefined {
  const parts = pointer.split("/");
  for (let length = parts.length; length >= 1; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    const hint = unionHint(schema, candidate);
    if (hint) return { pointer: candidate, hint };
  }
  return undefined;
}

/** A pi-schema error path (a JSON Pointer) as the dotted path the model sees. */
function dottedPath(pointer: string): string {
  return pointer === "" ? "root" : pointerSegments(pointer).join(".");
}

/** Schema issues name their instance path, collapse union branches, and never echo the value. */
function describeSchemaIssues(schema: HostSchema, value: BridgeCandidate): string {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const issue of parameterValidator(schema).errors(value)) {
    if (issues.length >= MAX_REPORTED_ISSUES) break;
    const union = enclosingUnionHint(schema, issue.path);
    const text = union
      ? `${dottedPath(union.pointer)}: ${union.hint}`
      : `${dottedPath(issue.path)}: ${issue.message}`;
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
  const detail = "detail" in image && isString(image.detail) ? image.detail : "high";
  return {
    image_url: `data:${image.mimeType};base64,${image.data}`,
    detail,
    ...conditionalProperties(Boolean(outputHint), { output_hint: outputHint }),
  };
}

export function codeModeWebResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue {
  const details = result.details;
  if (isJsonObject(details) && "webRun" in details) {
    const webRun = details["webRun"];
    if (webRun && (isJsonObject(webRun) || Array.isArray(webRun))) return webRun;
  }
  return compactNestedResult(result);
}

function requireExtensionContext(context: ToolExecutionContext): ExtensionToolContext {
  if (!context.extensionContext) throw new Error("Code-mode Pi context is unavailable");
  return context.extensionContext;
}

interface ToolScopeRegistry {
  isToolAllowed(
    sessionManager: ExtensionToolContext["sessionManager"],
    name: string,
  ): BoundaryValue;
}

function isToolScopeRegistry<T>(value: T): value is T & ToolScopeRegistry {
  return isJsonObject(value) && value["isToolAllowed"] instanceof Function;
}

/** Whether the calling session's published tool scope admits `name`. */
function isInSessionToolScope(context: ExtensionToolContext, name: string): boolean {
  const registry: BoundaryValue = Object.getOwnPropertyDescriptor(
    globalThis,
    TOOL_SCOPE_SYMBOL,
  )?.value;
  if (!isToolScopeRegistry(registry)) return true;
  return Boolean(registry.isToolAllowed(context.sessionManager, name));
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
  if (!isShellStructuredContent(structured)) return undefined;
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
  if (isJsonObject(result.details) && "output" in result.details) return result.details;
  const retrievable = retrievableResult(result);
  if (retrievable !== undefined) return retrievable;
  return resultText(result) || "(no output)";
}

/**
 * Results naming stored content resolve to `{ output, ...scalars }` so a script can pass the
 * `responseId`/`searchId` on to `get_search_content`. Only top-level booleans, finite numbers
 * and short strings from `details` are copied; arrays, objects and long strings stay out.
 */
function retrievableResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue | undefined {
  const details = result.details;
  if (!isJsonObject(details)) return undefined;
  if (!isString(details["responseId"]) && !isString(details["searchId"])) return undefined;
  const scalars: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(details)) {
    if (RETRIEVABLE_RESERVED_KEYS.has(key)) continue;
    // isNumber rejects NaN and Infinity, so copied scalars stay JSON-safe.
    if (!isBoolean(value) && !isNumber(value) && !isShortString(value)) continue;
    scalars[key] = value;
  }
  return { output: resultText(result) || "(no output)", ...scalars };
}
