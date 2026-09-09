import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import type { JsonObject } from "../protocol-values.ts";
import { createJsonSchemaValidator } from "../json-schema-validator.ts";

const draft07 = "http://json-schema.org/draft-07/schema";
const fixtures: [string, JsonObject, unknown, unknown][] = [
  [
    "required enum",
    { type: "object", properties: { x: { enum: ["yes"] } }, required: ["x"] },
    { x: "yes" },
    {},
  ],
  ["enum rejection", { enum: ["yes"] }, "yes", "no"],
  [
    "2020 tuple",
    {
      $schema: "https://json-schema.org/draft/2020-12/schema#",
      type: "array",
      prefixItems: [{ type: "string" }],
      items: false,
    },
    ["ok"],
    [1],
  ],
  [
    "draft07 tuple",
    { $schema: draft07, type: "array", items: [{ type: "string" }], additionalItems: false },
    ["ok"],
    ["ok", 2],
  ],
  [
    "definitions",
    { definitions: { text: { type: "string" } }, $ref: "#/definitions/text" },
    "ok",
    1,
  ],
  [
    "qualified ref",
    {
      $id: "https://example.test/schema",
      $defs: { text: { type: "string" } },
      $ref: "https://example.test/schema#/$defs/text",
    },
    "ok",
    1,
  ],
  [
    "dependencies",
    { $schema: draft07, type: "object", dependencies: { x: ["y"] } },
    { x: 1, y: 2 },
    { x: 1 },
  ],
  [
    "ref sibling",
    {
      $schema: draft07,
      definitions: { text: { type: "string" } },
      $ref: "#/definitions/text",
      minLength: 2,
    },
    "ok",
    "x",
  ],
  ["boolean subschema", { type: "object", properties: { x: false, y: true } }, { y: 1 }, { x: 1 }],
  ["nullable", { type: ["string", "null"] }, null, 1],
];
for (const [name, schema, good, bad] of fixtures) {
  test(name, () => {
    // SAFETY: These JSON Schema fixtures include draft-07 tuples omitted by the SDK's modern schema type.
    const validate = createJsonSchemaValidator().getValidator(schema as JsonSchemaType);
    assert.deepEqual(validate(good), { valid: true, data: good, errorMessage: undefined });
    const result = validate(bad);
    assert.equal(result.valid, false);
    assert.equal(result.data, undefined);
    assert.match(result.errorMessage ?? "", /^data.* /);
  });
}

const formats = [
  ["email", "a@example.com", "invalid"],
  ["date-time", "2026-01-01T12:00:00Z", "not-a-date"],
  ["uri", "https://example.com/path", "not a uri"],
  ["uuid", "123e4567-e89b-12d3-a456-426614174000", "invalid"],
  ["ipv4", "192.168.0.1", "999.1.1.1"],
  ["ipv6", "2001:db8::1", "invalid"],
  ["hostname", "example.com", "bad host"],
];
for (const [format, good, bad] of formats) {
  test(`format ${format}`, () => {
    const validate = createJsonSchemaValidator().getValidator({ type: "string", format });
    assert.equal(validate(good).valid, true);
    assert.deepEqual(validate(bad), {
      valid: false,
      data: undefined,
      errorMessage: `data must match format "${format}"`,
    });
  });
}
test("unknown formats pass", () => {
  assert.equal(
    createJsonSchemaValidator().getValidator({ type: "string", format: "custom-unknown" })(
      "anything",
    ).valid,
    true,
  );
});
for (const uri of [
  draft07,
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft/2020-12/schema",
]) {
  for (const suffix of ["", "#"]) {
    test(`accepted dialect ${uri}${suffix}`, () => {
      assert.equal(
        createJsonSchemaValidator().getValidator({ $schema: uri + suffix, type: "string" })("ok")
          .valid,
        true,
      );
    });
  }
}
for (const uri of [
  "http://json-schema.org/draft-04/schema",
  "https://json-schema.org/draft/2019-09/schema",
]) {
  for (const suffix of ["", "#"]) {
    test(`unsupported ${uri}${suffix}`, () => {
      assert.throws(() => createJsonSchemaValidator().getValidator({ $schema: uri + suffix }), {
        message: `Unsupported JSON Schema dialect: ${uri}`,
      });
    });
  }
}
test("identity and dialect-local id reuse", () => {
  const provider = createJsonSchemaValidator();
  const schema = { $id: "https://example.test/cached", type: "string" };
  const validate = provider.getValidator(schema);
  assert.equal(provider.getValidator(schema), validate);
  assert.equal(provider.getValidator({ ...schema, type: "number" }), validate);
  assert.equal(
    provider.getValidator({ ...schema, $schema: draft07, type: "number" })(1).valid,
    true,
  );
});
test("AJV-style multiple error wording", () => {
  const validate = createJsonSchemaValidator().getValidator({
    type: "object",
    properties: { x: { type: "string" }, y: { type: "integer" } },
  });
  assert.equal(
    validate({ x: 1, y: "bad" }).errorMessage,
    "data/x must be string, data/y must be integer",
  );
});
