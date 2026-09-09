import { Compile } from "typebox/compile";
import { isStringValue } from "./protocol-values.ts";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator as JsonSchemaValidatorProvider,
} from "@modelcontextprotocol/client";

const DRAFT_07_SCHEMA_URIS = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);
const DRAFT_2020_12_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";

export function createJsonSchemaValidator(): JsonSchemaValidatorProvider {
  const identities = new WeakMap<object, JsonSchemaValidator<unknown>>();
  // The previous SDK engines had separate $id registries for each dialect.
  const draft07Ids = new Map<string, JsonSchemaValidator<unknown>>();
  const draft2020Ids = new Map<string, JsonSchemaValidator<unknown>>();

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const uri = isStringValue(schema.$schema) ? schema.$schema.replace(/#$/, "") : undefined;
      if (uri !== undefined && uri !== DRAFT_2020_12_SCHEMA_URI && !DRAFT_07_SCHEMA_URIS.has(uri)) {
        throw new Error(`Unsupported JSON Schema dialect: ${uri}`);
      }
      const ids = uri !== undefined && DRAFT_07_SCHEMA_URIS.has(uri) ? draft07Ids : draft2020Ids;
      const id = isStringValue(schema.$id) ? schema.$id.replace(/#$/, "") : undefined;
      const cached = identities.get(schema) ?? (id === undefined ? undefined : ids.get(id));
      if (cached) {
        identities.set(schema, cached);
        // SAFETY: The SDK's generic T describes the caller's schema, not a runtime conversion.
        return cached as JsonSchemaValidator<T>;
      }
      const compiled = Compile(schema);
      const validator: JsonSchemaValidator<T> = (input) => {
        if (compiled.Check(input)) {
          // SAFETY: The compiled schema validates the caller's requested T.
          return { valid: true, data: input as T, errorMessage: undefined };
        }
        return {
          valid: false,
          data: undefined,
          // TypeBox's host-owned maxErrors defaults to 8; never change global settings here.
          errorMessage: [...compiled.Errors(input)]
            .map((error) => `data${error.instancePath} ${error.message}`)
            .join(", "),
        };
      };
      identities.set(schema, validator);
      if (id !== undefined) {
        ids.set(id, validator);
      }
      return validator;
    },
  };
}
