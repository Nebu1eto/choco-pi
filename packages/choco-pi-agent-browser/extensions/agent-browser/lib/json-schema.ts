import type { Schema } from "@earendil-works/pi-schema";

/** Supplies a schema description; the compact provider-facing variant omits prompt prose. */
export type SchemaDescribe = (text: string) => { readonly description?: string };

export const fullDescription: SchemaDescribe = (text) => ({ description: text });

/** Provider-facing variant: validation is unchanged, prompt prose is omitted. */
export const compactDescription: SchemaDescribe = () => ({});

/**
 * String enum that keeps `type: "string"` next to `enum` (pi-schema `oneOf` emits a bare `enum`),
 * so providers that require an explicit type keep receiving it.
 */
export function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: { readonly description?: string; readonly default?: Values[number] } = {},
): Schema<Values[number]> {
  return { type: "string", enum: [...values], ...options };
}
