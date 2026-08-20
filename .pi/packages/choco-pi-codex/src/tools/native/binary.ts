import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRS: Record<string, string> = {
  apply_patch: "apply-patch",
  exec_bridge: "exec",
  imagegen: "imagegen",
  view_image: "view-image",
  web_run: "web-run",
};

function packageRoot(): string {
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

export function getBundledToolBinaryPath(
  toolName: string,
  target: { platform?: NodeJS.Platform; arch?: string } = {},
  customDir?: string | undefined,
): string | undefined {
  const toolDir = TOOL_DIRS[toolName] ?? toolName;
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const exe = platform === "win32" ? `${toolName}.exe` : toolName;
  const custom = customDir?.trim();
  if (custom) {
    const customBinary = join(custom, exe);
    if (existsSync(customBinary)) return customBinary;
    // Fork addition: besides the flat layout, also accept a directory laid
    // out like the upstream package's src/tools tree
    // (<dir>/<tool>/bin/<platform>-<arch>/<exe>).
    const customTreeBinary = join(custom, toolDir, "bin", `${platform}-${arch}`, exe);
    if (existsSync(customTreeBinary)) return customTreeBinary;
  }
  const binary = join(packageRoot(), "src", "tools", toolDir, "bin", `${platform}-${arch}`, exe);
  return existsSync(binary) ? binary : undefined;
}
