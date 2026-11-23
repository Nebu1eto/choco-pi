import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ToolDirectoryMap {
  [toolName: string]: string | undefined;
}

const TOOL_DIRS: ToolDirectoryMap = {
  apply_patch: "apply-patch",
  exec_bridge: "exec",
  imagegen: "imagegen",
  view_image: "view-image",
  web_run: "web-run",
};

export const CODE_MODE_TOOLS_ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export function getBundledToolBinaryPath(
  toolName: string,
  target: { platform?: NodeJS.Platform; arch?: string } = {},
  customDir?: string | undefined,
  toolsRootDir: string = CODE_MODE_TOOLS_ROOT_DIR,
): string | undefined {
  const toolDir = TOOL_DIRS[toolName] ?? toolName;
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const exe = platform === "win32" ? `${toolName}.exe` : toolName;
  const custom = customDir?.trim();
  if (custom) {
    const customBinary = join(custom, exe);
    if (existsSync(customBinary)) return customBinary;
    const customTreeBinary = join(custom, toolDir, "bin", `${platform}-${arch}`, exe);
    if (existsSync(customTreeBinary)) return customTreeBinary;
  }
  const binary = join(toolsRootDir, toolDir, "bin", `${platform}-${arch}`, exe);
  return existsSync(binary) ? binary : undefined;
}
