/**
 * schema-bridge.ts — the one file in this package that imports typebox. Pi 1.5.0's
 * `registerTool`/`defineTool` still require a TypeBox `TSchema`; this wraps a pi-schema schema for
 * registration while keeping the pi-schema static type.
 */

import type { JsonSchema, Static } from "@earendil-works/pi-schema";
import { Type, type TSchema } from "typebox";

/** The host registration schema type (`ToolDefinition` parameters). */
export type HostSchema = TSchema;

export const hostParams = <S extends JsonSchema>(schema: S) => Type.Unsafe<Static<S>>(schema);
