import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type } from "typebox";

export const hostParams = <S extends JsonSchema>(schema: S) => Type.Unsafe<Static<S>>(schema);

export const hostParamsAs = <Params>(schema: JsonSchema) => Type.Unsafe<Params>(schema);
