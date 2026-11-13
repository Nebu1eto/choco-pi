import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundle identity of the two fixture instances; both run the same binary. */
export const fixtureApps = {
  target: {
    bundleId: "com.choco-pi.FocusFixture",
    name: "CUFixtureTarget",
    title: "CU Fixture Target",
  },
  holder: { bundleId: "com.choco-pi.FocusHolder", name: "CUFocusHolder", title: "CU Focus Holder" },
} as const;
export type FixtureRole = keyof typeof fixtureApps;

export interface FixtureBuild {
  hash: string;
  dir: string;
  target: string;
  holder: string;
}

const source = fileURLToPath(new URL("./FocusFixture.swift", import.meta.url));

function plist(role: FixtureRole): string {
  const app = fixtureApps[role];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${app.bundleId}</string>
  <key>CFBundleName</key><string>${app.title}</string>
  <key>CFBundleExecutable</key><string>FocusFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

async function run(file: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} exited ${code}: ${output.trim()}`)),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the fixture into `<outDir>/<hash>/` once per source hash: one `swiftc` binary copied into
 * the target and holder bundles. Nothing is signed, installed, or registered here; LaunchServices
 * registers the bundles when the harness opens them.
 */
export async function buildFixture(outDir: string): Promise<FixtureBuild> {
  const swift = await readFile(source);
  const hash = createHash("sha256")
    .update(swift)
    .update(plist("target"))
    .update(plist("holder"))
    .digest("hex")
    .slice(0, 16);
  const dir = join(outDir, hash);
  const result: FixtureBuild = {
    hash,
    dir,
    target: join(dir, `${fixtureApps.target.name}.app`),
    holder: join(dir, `${fixtureApps.holder.name}.app`),
  };
  if (await exists(join(dir, ".complete"))) return result;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const binary = join(dir, "FocusFixture");
  await run("xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-target",
    "arm64-apple-macos13.0",
    "-framework",
    "AppKit",
    source,
    "-o",
    binary,
  ]);
  for (const role of ["target", "holder"] as const) {
    const bundle = role === "target" ? result.target : result.holder;
    await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
    await copyFile(binary, join(bundle, "Contents/MacOS/FocusFixture"));
    await chmod(join(bundle, "Contents/MacOS/FocusFixture"), 0o755);
    await writeFile(join(bundle, "Contents/Info.plist"), plist(role));
  }
  await writeFile(join(dir, ".complete"), `${hash}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: build.ts <out-dir>");
    process.exitCode = 2;
  } else console.log(JSON.stringify(await buildFixture(out)));
}
