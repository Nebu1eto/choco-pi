import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type, type TUnsafe } from "typebox";

export function hostParams<S extends JsonSchema>(schema: S): TUnsafe<Static<S>> {
  return Type.Unsafe<Static<S>>(schema);
}
