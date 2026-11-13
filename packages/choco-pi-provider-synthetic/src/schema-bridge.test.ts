import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { hostParams } from "./schema-bridge.ts";

describe("hostParams", () => {
  it("passes the pi-schema JSON Schema through unchanged for the host registry", () => {
    const schema = obj({ query: str({ description: "The search query." }) }, { open: true });
    const params = hostParams(schema);
    expect(params).toMatchObject({
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    });
    expect(JSON.parse(JSON.stringify(params))).toEqual(JSON.parse(JSON.stringify(schema)));
  });
});
