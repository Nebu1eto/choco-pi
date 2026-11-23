import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve, win32 } from "node:path";
import { standaloneHome } from "@choco-pi/shared/pi-paths";
import { type BoundaryValue, isBoundaryRecord, isString, parseJsonLine } from "../boundary.ts";

export type PiLaunchSpec = {
  command: string;
  argsPrefix: string[];
};

export class PiCommandResolutionError extends Error {
  code = "ENOENT";

  constructor(message: string) {
    super(message);
    this.name = "PiCommandResolutionError";
  }
}

export function defaultPiCommand(env: NodeJS.ProcessEnv = process.env): string {
  const launcher = env.CHOCO_PI_LAUNCHER;
  if (standaloneHome(env) !== undefined && launcher !== undefined && isAbsolute(launcher)) {
    return launcher;
  }
  return "pi";
}

export function getPiCommand(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return override ?? defaultPiCommand(env);
}

async function executable(path: string, os: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, os === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(command: string, env: NodeJS.ProcessEnv, os: NodeJS.Platform): string[] {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [isAbsolute(command) ? command : resolve(command)];
  }

  const pathEntries = (env.PATH ?? "")
    .split(os === "win32" ? win32.delimiter : delimiter)
    .filter(Boolean);
  if (os !== "win32") return pathEntries.map((entry) => join(entry, command));

  const extensions = extname(command)
    ? [""]
    : (env.PATHEXT ?? ".COM;.EXE;.CMD;.BAT").split(";").filter(Boolean);
  return pathEntries.flatMap((entry) =>
    extensions.map((extension) => join(entry, command + extension)),
  );
}

function manifestPiBin(manifest: BoundaryValue): string | undefined {
  if (!isBoundaryRecord(manifest)) return undefined;
  const bin = manifest.bin;
  if (isString(bin)) return bin;
  if (!isBoundaryRecord(bin)) return undefined;
  const pi = bin.pi;
  return isString(pi) ? pi : undefined;
}

async function nodeLaunchForNpmShim(
  shimPath: string,
  os: NodeJS.Platform,
): Promise<PiLaunchSpec | null> {
  const packageJsonPath = join(
    dirname(shimPath),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );

  try {
    const manifest = parseJsonLine(await readFile(packageJsonPath, "utf8"));
    const bin = manifestPiBin(manifest);
    if (!bin) return null;
    const entry = resolve(dirname(packageJsonPath), bin);
    if (!(await executable(entry, os))) return null;
    return { command: process.execPath, argsPrefix: [entry] };
  } catch {
    return null;
  }
}

export async function resolvePiLaunch(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = process.platform,
): Promise<PiLaunchSpec> {
  const requested = getPiCommand(override, env);
  for (const candidate of candidates(requested, env, os)) {
    if (!(await executable(candidate, os))) continue;
    const extension = extname(candidate).toLowerCase();
    if (os === "win32" && (extension === ".cmd" || extension === ".bat")) {
      const nodeLaunch = await nodeLaunchForNpmShim(candidate, os);
      if (nodeLaunch) return nodeLaunch;
      continue;
    }
    return { command: candidate, argsPrefix: [] };
  }

  throw new PiCommandResolutionError(
    `Could not resolve the pi executable: executable not found (${requested}). Install @earendil-works/pi-coding-agent or set PI_ACP_PI_COMMAND to an executable path.`,
  );
}

export function shouldUseShellForPiCommand(_cmd: string): boolean {
  return false;
}
