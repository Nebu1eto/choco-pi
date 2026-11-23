import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { piAgentDir } from "@choco-pi/shared/pi-paths";
import {
  isPropertyContainer,
  isStringValue,
  parseFigmaJson,
  type FigmaValue,
} from "../src/figma-values.ts";

export interface ReadAuthTokenOptions {
  envName: string;
  authPath: readonly string[];
  authFile?: string;
}

const authTokenOverrides = new Map<string, string>();

/** Pi's credential file: `auth.json` in the agent directory (`~/.pi/agent` in legacy mode). */
export function defaultAuthFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return resolve(piAgentDir(env, home), "auth.json");
}

export function setAuthTokenOverride(options: ReadAuthTokenOptions, token: string): void {
  authTokenOverrides.set(authTokenKey(options), token);
}

export function clearAuthTokenOverride(options: ReadAuthTokenOptions): void {
  authTokenOverrides.delete(authTokenKey(options));
}

export class MissingAuthTokenError extends Error {
  public readonly envName: string;
  public readonly authPath: readonly string[];

  constructor(envName: string, authPath: readonly string[], authFile: string = defaultAuthFile()) {
    super(
      `No auth token found. Set ${envName} or store it in ${authFile} at ${authPath.join(".")}`,
    );
    this.name = "MissingAuthTokenError";
    this.envName = envName;
    this.authPath = authPath;
  }
}

export async function readAuthToken(options: ReadAuthTokenOptions): Promise<string> {
  const override = authTokenOverrides.get(authTokenKey(options));
  if (override) return override;

  const envValue = process.env[options.envName]?.trim();
  if (envValue) return envValue;

  const authFile = options.authFile ?? defaultAuthFile();
  try {
    const raw = await readFile(authFile, "utf8");
    const parsed = parseFigmaJson(raw);
    const value = getPath(parsed, options.authPath);
    if (isStringValue(value) && value.trim()) return value.trim();
  } catch (cause) {
    if (!isMissingFileError(cause)) {
      throw cause;
    }
  }

  throw new MissingAuthTokenError(options.envName, options.authPath, authFile);
}

function getPath(value: FigmaValue, path: readonly string[]): FigmaValue {
  let current = value;
  for (const segment of path) {
    if (!isPropertyContainer(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isMissingFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function authTokenKey(options: ReadAuthTokenOptions): string {
  return `${options.envName}:${options.authPath.join(".")}:${options.authFile ?? "default"}`;
}
