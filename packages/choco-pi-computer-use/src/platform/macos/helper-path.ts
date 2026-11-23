import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HELPER_APP_NAME = "pi-computer-use.app";
const SYSTEM_HELPER_APP_PATH = path.join("/Applications", HELPER_APP_NAME);

export interface MacosHelperPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  systemHelperAppPath?: string;
  fileExists?: (filePath: string) => boolean;
  directoryIsWritable?: (directoryPath: string) => boolean;
}

function defaultDirectoryIsWritable(directoryPath: string): boolean {
  try {
    accessSync(directoryPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveMacosHelperAppPath(options: MacosHelperPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitPath = env.PI_COMPUTER_USE_HELPER_APP_PATH?.trim();
  if (explicitPath) return path.resolve(explicitPath);

  const homeDir = options.homeDir ?? os.homedir();
  const systemHelperAppPath = options.systemHelperAppPath ?? SYSTEM_HELPER_APP_PATH;
  const fileExists = options.fileExists ?? existsSync;
  const directoryIsWritable = options.directoryIsWritable ?? defaultDirectoryIsWritable;

  if (fileExists(systemHelperAppPath) && directoryIsWritable(path.dirname(systemHelperAppPath))) {
    return systemHelperAppPath;
  }
  return path.join(homeDir, "Applications", HELPER_APP_NAME);
}
