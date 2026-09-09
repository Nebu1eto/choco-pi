import { Type, type Static } from "typebox";
import * as Value from "typebox/value";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isObjectValue, type McpObject } from "./protocol-values.ts";

export const UI_STREAM_HOST_CONTEXT_KEY = "pi-mcp-adapter/stream";
export const UI_STREAM_REQUEST_META_KEY = "pi-mcp-adapter/stream-token";
export const UI_STREAM_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch";
export const SERVER_STREAM_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/result-patch";
export const UI_STREAM_STRUCTURED_CONTENT_KEY = "pi-mcp-adapter/stream";

export const uiStreamModeSchema = Type.Enum(["eager", "stream-first"]);
export type UiStreamMode = Static<typeof uiStreamModeSchema>;

export const visualizationStreamPhaseSchema = Type.Enum([
  "shell",
  "narrative",
  "structure",
  "detail",
  "settled",
]);
export type VisualizationStreamPhase = Static<typeof visualizationStreamPhaseSchema>;

export const visualizationStreamFrameTypeSchema = Type.Enum(["patch", "checkpoint", "final"]);
export type VisualizationStreamFrameType = Static<typeof visualizationStreamFrameTypeSchema>;

export const visualizationStreamStatusSchema = Type.Enum(["ok", "error"]);
export type VisualizationStreamStatus = Static<typeof visualizationStreamStatusSchema>;

const looseRecordSchema = Type.Record(Type.String(), Type.Unknown());
const looseArraySchema = Type.Array(Type.Unknown());

export const uiStreamHostContextSchema = Type.Object({
  mode: uiStreamModeSchema,
  streamId: Type.String({ minLength: 1 }),
  intermediateResultPatches: Type.Boolean(),
  partialInput: Type.Boolean(),
});
export type UiStreamHostContext = Static<typeof uiStreamHostContextSchema>;

export const visualizationStreamEnvelopeSchema = Type.Object({
  streamId: Type.String({ minLength: 1 }),
  sequence: Type.Integer({ minimum: 0 }),
  frameType: visualizationStreamFrameTypeSchema,
  phase: visualizationStreamPhaseSchema,
  status: visualizationStreamStatusSchema,
  message: Type.Optional(Type.String()),
  spec: Type.Optional(looseRecordSchema),
  checkpoint: Type.Optional(looseRecordSchema),
});
export type VisualizationStreamEnvelope = Static<typeof visualizationStreamEnvelopeSchema>;

export const uiStreamCallToolResultSchema = Type.Object(
  {
    content: Type.Optional(looseArraySchema),
    structuredContent: Type.Optional(looseRecordSchema),
    isError: Type.Optional(Type.Boolean()),
    _meta: Type.Optional(looseRecordSchema),
  },
  { additionalProperties: true },
);
export type UiStreamCallToolResult = Static<typeof uiStreamCallToolResultSchema>;

export const uiStreamResultPatchNotificationSchema = Type.Object({
  method: Type.Literal(UI_STREAM_RESULT_PATCH_METHOD),
  params: uiStreamCallToolResultSchema,
});
export type UiStreamResultPatchNotification = Static<typeof uiStreamResultPatchNotificationSchema>;

export const serverStreamResultPatchNotificationSchema = Type.Object({
  method: Type.Literal(SERVER_STREAM_RESULT_PATCH_METHOD),
  params: Type.Object({
    streamToken: Type.String({ minLength: 1 }),
    result: uiStreamCallToolResultSchema,
  }),
});
export type ServerStreamResultPatchNotification = Static<
  typeof serverStreamResultPatchNotificationSchema
>;

const serverStreamResultPatchParamsSchema = Type.Object({
  streamToken: Type.String({ minLength: 1 }),
  result: uiStreamCallToolResultSchema,
});
export type ServerStreamResultPatchParams = Static<typeof serverStreamResultPatchParamsSchema>;

/** StandardSchemaV1 surface the vendored MCP client's setNotificationHandler expects. */
export const serverStreamResultPatchParamsStandard: StandardSchemaV1<
  unknown,
  ServerStreamResultPatchParams
> = {
  "~standard": {
    version: 1,
    vendor: "typebox",
    validate(value) {
      if (Value.Check(serverStreamResultPatchParamsSchema, value)) return { value };
      const issues = [...Value.Errors(serverStreamResultPatchParamsSchema, value)].map((error) => ({
        message: error.message,
        path: error.instancePath.split("/").filter((segment) => segment !== ""),
      }));
      return { issues };
    },
  },
};

export interface UiStreamSummary {
  streamId: string;
  mode: UiStreamMode;
  frames: number;
  phases: VisualizationStreamPhase[];
  finalStatus?: VisualizationStreamStatus;
  lastMessage?: string;
}

export function getUiStreamHostContext(
  hostContext: McpObject | undefined,
): UiStreamHostContext | undefined {
  const candidate = hostContext?.[UI_STREAM_HOST_CONTEXT_KEY];
  const cleaned = Value.Clean(uiStreamHostContextSchema, Value.Clone(candidate));
  return Value.Check(uiStreamHostContextSchema, cleaned) ? cleaned : undefined;
}

export function getVisualizationStreamEnvelope<BoundaryValue>(
  structuredContent: BoundaryValue,
): VisualizationStreamEnvelope | undefined {
  if (!structuredContent || !isObjectValue(structuredContent) || Array.isArray(structuredContent)) {
    return undefined;
  }

  const candidate =
    /* SAFETY: Runtime validation or the typed MCP/Pi boundary establishes McpObject for this value. */ (
      structuredContent as McpObject
    )[UI_STREAM_STRUCTURED_CONTENT_KEY];
  const cleaned = Value.Clean(visualizationStreamEnvelopeSchema, Value.Clone(candidate));
  return Value.Check(visualizationStreamEnvelopeSchema, cleaned) ? cleaned : undefined;
}
