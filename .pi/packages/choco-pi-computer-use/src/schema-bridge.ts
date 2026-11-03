import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type } from "typebox";

/** Pi 1.5.0 registerTool/defineTool still require a TypeBox schema; wrap the pi-schema object here only. */
export const hostParams = <S extends JsonSchema>(schema: S) => Type.Unsafe<Static<S>>(schema);
