import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type } from "typebox";

/** Pi 1.5.1 `registerTool` still requires a TypeBox schema; wrap the pi-schema object here only. */
export const hostParams = <S extends JsonSchema>(schema: S) => Type.Unsafe<Static<S>>(schema);

/** Same bridge for a raw schema merged from another package, with its parameter type stated explicitly. */
export const hostParamsAs = <Params>(schema: JsonSchema) => Type.Unsafe<Params>(schema);
