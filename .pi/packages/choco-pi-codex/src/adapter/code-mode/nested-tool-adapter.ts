import { conditionalProperties } from "../runtime-values.ts";
import { isBoundaryValue, JsonObjectSchema, type BoundaryValue } from "../runtime-values.ts";
import { Value } from "typebox/value";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const WebRunDetailsSchema = Type.Object({ webRun: Type.Unknown() });

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

interface NestedToolContract<TDetails> {
  kind?: "function" | "freeform";
  /** Deferred tools stay out of the prompt and are discovered through ALL_TOOLS. */
  deferLoading?: boolean;
  toolName?: CodeModeToolIdentity;
  yieldTimeMs?: number;
  prepareInput?(input: BoundaryValue): BoundaryValue;
  resultError?(result: AgentToolResult<TDetails>): string | undefined;
  resultValue?(result: AgentToolResult<TDetails>): BoundaryValue;
}

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
        const result = await tool.execute(
          toolCallId,
          validated,
          signal,
          (update) => forwardUpdate(update, context),
          extensionContext,
        );
        const resultError = contract.resultError?.(result);
        if (resultError) throw new Error(resultError);
        context.captureResult?.(result);
        return contract.resultValue?.(result) ?? compactNestedResult(result);
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
      const normalized: unknown = validateToolArguments(
        { name: tool.name, description: tool.description, parameters: tool.parameters },
        { type: "toolCall", id: `code-mode-${tool.name}`, name: tool.name, arguments: prepared },
      );
      const validated: BridgeCandidate = isBoundaryValue(normalized) ? normalized : undefined;
      if (matchesToolParameters(tool, validated)) return { ok: true, value: validated };
      return { ok: false, issues: describeSchemaIssues(tool.parameters, validated) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith(VALIDATION_FAILURE_PREFIX))
        return { ok: false, issues: describeNativeIssues(message) };
      // Not a validation rejection: propagate it instead of executing on unvalidated input.
      throw error;
    }
  }
  if (matchesToolParameters(tool, prepared)) return { ok: true, value: prepared };
  return { ok: false, issues: describeSchemaIssues(tool.parameters, prepared) };
}

function boundIssue(issue: string): string {
  const flattened = issue.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_ISSUE_LENGTH
    ? `${flattened.slice(0, MAX_ISSUE_LENGTH)}…`
    : flattened;
}

/** Schema issues name their instance path and never repeat the rejected value. */
function describeSchemaIssues(schema: TSchema, value: BridgeCandidate): string {
  return [...Value.Errors(schema, value)]
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const path = issue.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return boundIssue(`${path || "root"}: ${issue.message}`);
    })
    .join("; ");
}

/** Keep the native validator's path-qualified bullets and drop its raw-arguments suffix. */
function describeNativeIssues(message: string): string {
  const [head = ""] = message.split(RECEIVED_ARGUMENTS_MARKER);
  const issues: string[] = [];
  for (const line of head.split("\n")) {
    if (issues.length >= MAX_REPORTED_ISSUES) break;
    const issue = /^ {2}- (.+)$/.exec(line)?.[1];
    if (issue !== undefined) issues.push(boundIssue(issue));
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

function requireExtensionContext(context: ToolExecutionContext): ExtensionContext {
  if (!context.extensionContext) throw new Error("Code-mode Pi context is unavailable");
  return context.extensionContext;
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

function compactNestedResult<TDetails>(result: AgentToolResult<TDetails>): BoundaryValue {
  const images = result.content.filter((item) => item.type === "image");
  if (images.length > 0) return { content: result.content, details: result.details };
  if (Value.Check(JsonObjectSchema, result.details) && "output" in result.details)
    return result.details;
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return text || "(no output)";
}
