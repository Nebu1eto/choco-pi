/**
 * Helpers for JSON Schema URL generation.
 *
 * Used to build `$schema` URLs pointing to schemas hosted on unpkg
 * via published npm packages.
 */

/**
 * Build a URL to a JSON Schema file hosted on unpkg via an npm package.
 *
 * @param packageName - npm package name (e.g. `@aliou/pi-guardrails`)
 * @param version - semver version (e.g. `0.8.0`)
 * @param schemaPath - path to the schema file within the package (default: `schema.json`)
 * @returns Full unpkg URL to the schema file
 *
 * @example
 * ```ts
 * buildSchemaUrl("@aliou/pi-guardrails", "0.8.0");
 * // => "https://unpkg.com/@aliou/pi-guardrails@0.8.0/schema.json"
 * ```
 */
export function buildSchemaUrl(
  packageName: string,
  version: string,
  schemaPath = "schema.json",
): string {
  return `https://unpkg.com/${packageName}@${version}/${schemaPath}`;
}
