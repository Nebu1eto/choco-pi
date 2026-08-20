import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Check } from "typebox/value";

const RECOVERY =
  "Build the native helpers locally, set `tools.customRustBinariesDir` in `choco-pi-codex.json`, then run `/reload`";

/** Node attaches a string `code` to spawn and I/O failures. */
const CodedError = Type.Object({ code: Type.String() });

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorCode(cause: unknown): string | undefined {
  return Check(CodedError, cause) ? cause.code : undefined;
}

export function nativeBinaryRecoveryMessage(
  helper: string,
  cause: unknown,
  options: {
    binaryPath?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    startupWriteFailure?: boolean | undefined;
  } = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const message = errorMessage(cause);
  const loaderFailure =
    /Could not start dynamically linked executable|NixOS cannot run dynamically linked|stub-ld|(?:version [`']?)?GLIBC_[0-9.]+[`']? not found|error while loading shared libraries: [^\n]+: cannot open shared object file/i.test(
      message,
    );
  const startupPipeFailure =
    options.startupWriteFailure === true &&
    (errorCode(cause) === "EPIPE" || /\bEPIPE\b|broken pipe/i.test(message));
  const missingInterpreter =
    errorCode(cause) === "ENOENT" && !!options.binaryPath && existsSync(options.binaryPath);
  if (!loaderFailure && !startupPipeFailure && !missingInterpreter) return undefined;
  return `${helper} cannot run on this system. ${RECOVERY}`;
}

export function formatNativeBinaryError(
  helper: string,
  cause: unknown,
  options?: {
    binaryPath?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    startupWriteFailure?: boolean | undefined;
  },
): string {
  return nativeBinaryRecoveryMessage(helper, cause, options) ?? errorMessage(cause);
}
