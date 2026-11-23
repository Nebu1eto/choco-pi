import type { Schema } from "@earendil-works/pi-schema";

export type SchemaDescribe = (text: string) => { readonly description?: string };

export const fullDescription: SchemaDescribe = (text) => ({ description: text });

export const compactDescription: SchemaDescribe = () => ({});

export function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: { readonly description?: string; readonly default?: Values[number] } = {},
): Schema<Values[number]> {
  return { type: "string", enum: [...values], ...options };
}
