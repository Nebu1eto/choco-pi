import {
  bool,
  compile,
  lit,
  nullable,
  num,
  obj,
  opt,
  str,
  type Static,
} from "@earendil-works/pi-schema";

// Prototype wire frames are open JSON objects: unknown members are ignored, as before.
export const usageSchema = obj(
  { input_tokens: opt(num()), output_tokens: opt(num()) },
  { open: true },
);
export const wireEventSchema = obj(
  {
    type: str(),
    delta: opt(str()),
    response: opt(
      obj(
        {
          id: opt(str()),
          incomplete_details: opt(nullable(obj({ reason: opt(str()) }, { open: true }))),
          usage: opt(nullable(usageSchema)),
        },
        { open: true },
      ),
    ),
    steer: opt(obj({ id: opt(str()), previous_response_id: opt(str()) }, { open: true })),
    error: opt(nullable(obj({ code: opt(nullable(str())) }, { open: true }))),
    item: opt(
      obj(
        {
          type: str(),
          name: opt(str()),
          async: opt(bool()),
          call_id: opt(str()),
          arguments: opt(str()),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
export type WireEvent = Static<typeof wireEventSchema>;
export type WireUsage = Static<typeof usageSchema>;
// Closed: the demo tool takes no arguments, so any member is rejected.
export const emptyArgumentsSchema = obj({});
export const demoOutputSchema = obj({ marker: str(), source: lit("synthetic") }, { open: true });
export const textFrameSchema = str({ maxLength: 1000000 });
export const isWireEvent = compile(wireEventSchema).check;
export const isEmptyArguments = compile(emptyArgumentsSchema).check;
export const isDemoOutput = compile(demoOutputSchema).check;
export const isTextFrame = compile(textFrameSchema).check;
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
