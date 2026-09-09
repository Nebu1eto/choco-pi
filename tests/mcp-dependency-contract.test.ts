import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function manifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const mcpPath = "../.pi/packages/choco-pi-mcp/";

test("MCP development SDK matches the root host without replacing optional peers", () => {
  const root = manifest("../package.json");
  const mcp = manifest(`${mcpPath}package.json`);
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    const version = root.devDependencies?.[name];
    assert.ok(version);
    assert.equal(mcp.devDependencies?.[name], version, name);
    assert.equal(mcp.peerDependencies?.[name], version, name);
    assert.equal(mcp.peerDependenciesMeta?.[name]?.optional, true, name);
    assert.equal(mcp.dependencies?.[name], undefined, name);
    assert.equal(manifest(`${mcpPath}node_modules/${name}/package.json`).version, version, name);
  }
});

test("MCP declares the Standard Schema types used by its published TypeScript", () => {
  const mcp = manifest(`${mcpPath}package.json`);
  assert.equal(mcp.dependencies?.["@standard-schema/spec"], "1.1.0");
  assert.equal(
    manifest(`${mcpPath}node_modules/@standard-schema/spec/package.json`).version,
    mcp.dependencies?.["@standard-schema/spec"],
  );
});
