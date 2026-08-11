import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSchemaUrl } from "./schema";

// Mock getAgentDir - will be configured per test via mockReturnValue
const mockGetAgentDir = vi.fn(() => "");
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockGetAgentDir(),
}));

// Import after mock setup
import { ConfigLoader } from "./config-loader";

describe("buildSchemaUrl", () => {
  it("builds default URL with schema.json", () => {
    expect(buildSchemaUrl("@aliou/pi-guardrails", "0.8.0")).toBe(
      "https://unpkg.com/@aliou/pi-guardrails@0.8.0/schema.json",
    );
  });

  it("accepts custom schema path", () => {
    expect(buildSchemaUrl("my-pkg", "1.0.0", "schemas/config.json")).toBe(
      "https://unpkg.com/my-pkg@1.0.0/schemas/config.json",
    );
  });
});

describe("ConfigLoader $schema round-trip", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schema-test-"));
    await mkdir(join(tempDir, "extensions"), { recursive: true });
    mockGetAgentDir.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("injects $schema on write and strips it on read", async () => {
    const schemaUrl = "https://unpkg.com/@aliou/test@1.0.0/schema.json";

    const loader = new ConfigLoader<{ name?: string }, { name: string }>(
      "schema-round-trip",
      { name: "default" },
      {
        scopes: ["global"],
        schemaUrl,
      },
    );

    await loader.save("global", { name: "hello" });

    // Verify the raw file on disk has $schema as the first key
    const filePath = join(tempDir, "extensions/schema-round-trip.json");
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.$schema).toBe(schemaUrl);
    expect(parsed.name).toBe("hello");
    expect(Object.keys(parsed)[0]).toBe("$schema");

    // Verify that getRawConfig does NOT contain $schema
    const rawConfig = loader.getRawConfig("global");
    expect(rawConfig).toEqual({ name: "hello" });
    expect((rawConfig as Record<string, unknown>).$schema).toBeUndefined();
  });

  it("writes without $schema when schemaUrl is not set", async () => {
    const loader = new ConfigLoader<{ name?: string }, { name: string }>(
      "no-schema-test",
      { name: "default" },
      { scopes: ["global"] },
    );

    await loader.save("global", { name: "world" });

    const filePath = join(tempDir, "extensions/no-schema-test.json");
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.$schema).toBeUndefined();
    expect(parsed.name).toBe("world");
  });

  it("strips $schema from existing files on load", async () => {
    // Write a file with $schema manually
    const filePath = join(tempDir, "extensions/strip-test.json");
    await writeFile(
      filePath,
      JSON.stringify({
        $schema: "https://example.com/schema.json",
        name: "existing",
      }),
    );

    const loader = new ConfigLoader<{ name?: string }, { name: string }>(
      "strip-test",
      { name: "default" },
      { scopes: ["global"] },
    );

    await loader.load();

    const rawConfig = loader.getRawConfig("global");
    expect(rawConfig).toEqual({ name: "existing" });
    expect((rawConfig as Record<string, unknown>).$schema).toBeUndefined();

    const resolved = loader.getConfig();
    expect(resolved.name).toBe("existing");
  });
});
