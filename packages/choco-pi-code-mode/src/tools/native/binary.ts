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

/** This package's `src/tools` directory, where apply_patch, exec_bridge and view_image ship. */
export const CODE_MODE_TOOLS_ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolve a bundled native tool binary. `toolsRootDir` names the `src/tools`
 * tree that ships it (default: this package's); a provider package passes its
 * own tree for the binaries it bundles (Codex: imagegen, web_run).
 */
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
    // Fork addition: besides the flat layout, also accept a directory laid
    // out like the upstream package's src/tools tree
    // (<dir>/<tool>/bin/<platform>-<arch>/<exe>).
    const customTreeBinary = join(custom, toolDir, "bin", `${platform}-${arch}`, exe);
    if (existsSync(customTreeBinary)) return customTreeBinary;
  }
  const binary = join(toolsRootDir, toolDir, "bin", `${platform}-${arch}`, exe);
  return existsSync(binary) ? binary : undefined;
}
