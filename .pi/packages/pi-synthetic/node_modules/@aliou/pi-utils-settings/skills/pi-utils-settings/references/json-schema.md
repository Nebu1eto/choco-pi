# JSON Schema for Settings Files

Extensions can ship a JSON Schema so that editors (VS Code, etc.) provide autocomplete and validation for settings files. The schema is auto-generated from the `TConfig` TypeScript interface using `ts-json-schema-generator`.

## 1. Add JSDoc comments to config types

JSDoc comments on `TConfig` fields become `description` in the generated schema. Always document every field.

```typescript
/** User-facing configuration. */
export interface MyConfig {
  /** Enable the extension. */
  enabled?: boolean;
  /** Comma-separated list of tags. */
  tags?: string[];
}
```

## 2. Generate the schema

Add `ts-json-schema-generator` as a devDep and add scripts to `package.json`:

```json
{
  "scripts": {
    "gen:schema": "ts-json-schema-generator --path src/config.ts --type MyConfig --no-type-check -o schema.json",
    "check:schema": "ts-json-schema-generator --path src/config.ts --type MyConfig --no-type-check -o /tmp/schema-check.json && diff -q schema.json /tmp/schema-check.json"
  }
}
```

- `--no-type-check` is needed because config files import from packages that may not resolve in the generator's standalone typecheck context.
- `--type` must match the exported user-facing config interface name (the partial one, not the resolved one).

Run `pnpm gen:schema` to produce `schema.json`. Commit it. Add `"schema.json"` to the `files` array in `package.json` so it ships with the npm package.

Exclude `schema.json` from biome in `biome.json` to avoid drift between the generator output and the committed file. Biome v2 uses negated patterns in `includes`:

```json
{
  "files": {
    "includes": ["**/*.ts", "**/*.json", "!schema.json"]
  }
}
```

## 3. Wire up `buildSchemaUrl` in ConfigLoader

```typescript
import { ConfigLoader, buildSchemaUrl } from "@aliou/pi-utils-settings";
import pkg from "../package.json" with { type: "json" };

const schemaUrl = buildSchemaUrl(pkg.name, pkg.version);

export const configLoader = new ConfigLoader<MyConfig, ResolvedConfig>(
  "my-extension",
  defaults,
  { schemaUrl },
);
```

When `schemaUrl` is set, `save()` writes `$schema` as the first key in the JSON file. `load()` strips it before returning config to callers. The config types stay clean.

## 4. Add `check:schema` to CI

Add a step to `ci.yml` that regenerates the schema to a temp file and diffs against the committed `schema.json`. This catches cases where someone updates the config type but forgets to regenerate.

```yaml
- name: Check schema is up to date
  run: pnpm check:schema
```

The full CI job should run lint, typecheck, and check:schema. No changes needed in the publish workflow since `schema.json` is already in `files` and ships with the package.

## Testing schema generation

To verify generation works on the reference example bundled in this package:

```bash
npx ts-json-schema-generator \
  --path skills/pi-utils-settings/references/example-extension/config.ts \
  --type ExampleConfig \
  --no-type-check \
  -o skills/pi-utils-settings/references/example-extension/schema.json
```

To verify the committed schema hasn't drifted:

```bash
npx ts-json-schema-generator \
  --path skills/pi-utils-settings/references/example-extension/config.ts \
  --type ExampleConfig \
  --no-type-check \
  -o /tmp/schema-check.json \
  && diff -q skills/pi-utils-settings/references/example-extension/schema.json /tmp/schema-check.json
```

## Reference implementation

The extension template at `../pi-extension-template/` is a working example with all pieces wired up:

- `src/config.ts` — JSDoc on `ExtensionTemplateConfig`, `buildSchemaUrl` from `package.json`, `schemaUrl` passed to `ConfigLoader`
- `schema.json` — generated and committed
- `package.json` — `gen:schema` + `check:schema` scripts, `ts-json-schema-generator` devDep, `schema.json` in `files`
- `biome.json` — `schema.json` in `files.ignore`
- `.github/workflows/ci.yml` — `check:schema` step after typecheck

The bundled example extension at `references/example-extension/` also includes a generated `schema.json` with full JSDoc descriptions.
