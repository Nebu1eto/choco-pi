import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PI_SDK_RANGE, isSupportedPiVersion } from "../.pi/skills/check/scripts/check-harness.ts";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const ROOT = new URL("../", import.meta.url);
const RANGE = "~1.5.2";
const SDK_NAMES = ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-schema", "pi-tui"];
const PACKAGE_PATHS = [
  "",
  ...(await readdir(new URL(".pi/packages/", ROOT), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `.pi/packages/${entry.name}/`),
];

test("every direct Pi SDK contract declares the harness patch range", async () => {
  assert.equal(PI_SDK_RANGE, RANGE, "readiness range");
  for (const path of PACKAGE_PATHS) {
    const manifest: PackageManifest = JSON.parse(
      await readFile(new URL(`${path}package.json`, ROOT), "utf8"),
    );
    for (const section of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      for (const name of SDK_NAMES) {
        const version = section?.[`@earendil-works/${name}`];
        if (version !== undefined) assert.equal(version, RANGE, `${path}${name}`);
      }
    }
    if (path === "") {
      for (const name of SDK_NAMES) {
        assert.equal(manifest.devDependencies?.[`@earendil-works/${name}`], RANGE, name);
      }
    }
  }
});

test("every frozen lock resolves only supported SDK releases", async () => {
  for (const path of PACKAGE_PATHS) {
    const lockPath = new URL(`${path}pnpm-lock.yaml`, ROOT);
    const entries = await readdir(new URL(path || ".", ROOT));
    if (!entries.includes("pnpm-lock.yaml")) continue;
    const lock = await readFile(lockPath, "utf8");
    const references = [
      ...lock.matchAll(
        /@earendil-works\/(?:pi-ai|pi-agent-core|pi-codemode|pi-coding-agent|pi-mcp|pi-tui|pi-telemetry|chord)@([^\s'"():]+)/g,
      ),
    ];
    // A package without a direct SDK dependency, such as the standalone ACP adapter,
    // need not lock the SDK; any SDK reference its lock does carry is still checked.
    const manifest: PackageManifest = JSON.parse(
      await readFile(new URL(`${path}package.json`, ROOT), "utf8"),
    );
    const declaresSdk = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].some((section) =>
      Object.keys(section ?? {}).some((name) => name.startsWith("@earendil-works/")),
    );
    if (declaresSdk) assert.ok(references.length > 0, `${path} must lock the SDK`);
    for (const reference of references) {
      assert.ok(isSupportedPiVersion(reference[1] ?? ""), `${path}${reference[0]}`);
    }
    for (const declaration of lock.matchAll(
      /'@earendil-works\/(?:pi-ai|pi-agent-core|pi-coding-agent|pi-schema|pi-tui)':\n\s+specifier: ([^\n]+)\n\s+version: ([^\s(]+)/g,
    )) {
      assert.equal(declaration[1], RANGE, `${path} importer specifier`);
      assert.ok(isSupportedPiVersion(declaration[2] ?? ""), `${path} importer resolution`);
    }
  }
});
