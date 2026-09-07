import { Type, type Static } from "typebox";

export const usageSchema = Type.Object({
  input_tokens: Type.Optional(Type.Number()),
  output_tokens: Type.Optional(Type.Number()),
});
export const wireEventSchema = Type.Object({
  type: Type.String(),
  delta: Type.Optional(Type.String()),
  response: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String()),
      incomplete_details: Type.Optional(
        Type.Union([Type.Null(), Type.Object({ reason: Type.Optional(Type.String()) })]),
      ),
      usage: Type.Optional(Type.Union([Type.Null(), usageSchema])),
    }),
  ),
  steer: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String()),
      previous_response_id: Type.Optional(Type.String()),
    }),
  ),
  error: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({ code: Type.Optional(Type.Union([Type.Null(), Type.String()])) }),
    ]),
  ),
  item: Type.Optional(
    Type.Object({
      type: Type.String(),
      name: Type.Optional(Type.String()),
      async: Type.Optional(Type.Boolean()),
      call_id: Type.Optional(Type.String()),
      arguments: Type.Optional(Type.String()),
    }),
  ),
});
export type WireEvent = Static<typeof wireEventSchema>;
export type WireUsage = Static<typeof usageSchema>;
export const emptyArgumentsSchema = Type.Object({}, { additionalProperties: false });
export const demoOutputSchema = Type.Object({
  marker: Type.String(),
  source: Type.Literal("synthetic"),
});
export const textFrameSchema = Type.String({ maxLength: 1000000 });
export const demoTool = {
  type: "function",
  name: "prototype_lookup",
  description: "Return a synthetic marker after a short delay. No filesystem or network access.",
  async: true,
  strict: true,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};
export interface WireRequest {
  type: "response.create" | "response.steer";
  model?: string;
  store?: boolean;
  instructions?: string;
  reasoning?: { effort: string };
  tools?: (typeof demoTool)[];
  tool_choice?: "none" | { type: "function"; name: string };
  previous_response_id?: string;
  input:
    | string
    | (
        | { role: "user"; content: string }
        | {
            type: "function_call_output";
            call_id: string;
            output: string;
          }
      )[];
}
