import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type, type TSchema } from "typebox";

export type HostSchema = TSchema;

export const hostParams = <S extends JsonSchema>(schema: S) => Type.Unsafe<Static<S>>(schema);
