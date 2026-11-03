// The only first-party file that imports typebox (tests only): Pi 1.5.0 registerTool/ToolDefinition still require a TypeBox TSchema.
import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type, type TUnsafe } from "typebox";

/** Wraps a pi-schema object for host tool registration; the host validates and coerces it as a native schema. */
export function hostParams<S extends JsonSchema>(schema: S): TUnsafe<Static<S>> {
  return Type.Unsafe<Static<S>>(schema);
}
