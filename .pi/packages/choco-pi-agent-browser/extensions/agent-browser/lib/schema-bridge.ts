/**
 * schema-bridge.ts — the one file that imports typebox. Pi 1.5.1's
 * `registerTool`/`defineTool` still require a TypeBox `TSchema`; this wraps a
 * pi-schema schema for registration while keeping the pi-schema static type.
 */

import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type } from "typebox";

export const hostParams = <S extends JsonSchema>(schema: S) => Type.Unsafe<Static<S>>(schema);
