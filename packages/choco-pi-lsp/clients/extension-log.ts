import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { isObjectRecord, isString } from "./runtime-guards.ts";
import { isTestMode } from "./env-utils.ts";
import { getGlobalPiLensDir } from "./file-utils.ts";
import { getMaxLogSizeMB } from "./log-cleanup.ts";
import { createNdjsonLogger } from "./ndjson-logger.ts";

export const EXTENSION_LOG_FILE = path.join(getGlobalPiLensDir(), "extension.log");

const writer = createNdjsonLogger({
  filePath: EXTENSION_LOG_FILE,
  maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export type ExtensionLogLevel = "error" | "warn" | "debug";

export type ExtensionLogMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ExtensionLogMetadataValue[]
  | { [key: string]: ExtensionLogMetadataValue };
export type ExtensionLogMetadata = Record<string, ExtensionLogMetadataValue>;

export interface ExtensionLogEntry {
  subsystem: string;
  message: string;
  level?: ExtensionLogLevel;
  metadata?: ExtensionLogMetadata;
}

interface ExtensionLogPayload {
  ts: string;
  pid: number;
  level: ExtensionLogLevel;
  subsystem: string;
  message: string;
  metadata?: ExtensionLogMetadata;
}

export function logExtension(entry: ExtensionLogEntry): void {
  if (isTestMode()) return;
  let payload: ExtensionLogPayload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    level: entry.level ?? "error",
    subsystem: entry.subsystem,
    message: entry.message,
  };
  if (entry.metadata) payload = { ...payload, metadata: entry.metadata };
  writer.log(payload);
}

export interface SubsystemLogger {
  (message: string, metadata?: ExtensionLogMetadata): void;
  error(message: string, metadata?: ExtensionLogMetadata): void;
  warn(message: string, metadata?: ExtensionLogMetadata): void;
  debug(message: string, metadata?: ExtensionLogMetadata): void;
}

export function createSubsystemLogger(
  subsystem: string,
  defaultLevel: ExtensionLogLevel = "debug",
): SubsystemLogger {
  const at =
    (level: ExtensionLogLevel) =>
    (message: string, metadata?: ExtensionLogMetadata): void => {
      logExtension({ subsystem, message, level, metadata });
    };
  return Object.assign(at(defaultLevel), {
    error: at("error"),
    warn: at("warn"),
    debug: at("debug"),
  });
}

export function noopSubsystemLogger(): SubsystemLogger {
  const noop = () => {};
  return Object.assign(noop, { error: noop, warn: noop, debug: noop });
}

export function getExtensionLogPath(): string {
  return EXTENSION_LOG_FILE;
}

export function flushExtensionLog(): Promise<void> {
  return writer.flush();
}

export function flushExtensionLogSync(): void {
  writer.flushSync();
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir"] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

type RuntimeValue = object | string | number | boolean | bigint | symbol | null | undefined;
type RuntimeFunction = (...args: RuntimeValue[]) => RuntimeValue;
type ConsoleFn = (...args: RuntimeValue[]) => void;

function readRuntimeProperty<T extends object>(target: T, prop: PropertyKey): RuntimeValue {
  // SAFETY: Proxy supplies a property key for this exact target; direct indexed access preserves
  return target[prop as keyof T] as RuntimeValue;
}

let consoleGuardInstalled = false;
const originalConsoleMethods = new Map<ConsoleMethod, ConsoleFn>();
const installedConsoleMethods = new Map<ConsoleMethod, ConsoleFn>();

let consoleCaptureStorage: AsyncLocalStorage<true> | undefined;

function getConsoleCaptureStorage(): AsyncLocalStorage<true> | undefined {
  if (!consoleGuardInstalled) return undefined;
  if (consoleCaptureStorage === undefined) {
    consoleCaptureStorage = new AsyncLocalStorage<true>();
  }
  return consoleCaptureStorage;
}

let moduleLoadWindowOpen = false;

export function isConsoleCaptureActive(): boolean {
  return moduleLoadWindowOpen || consoleCaptureStorage?.getStore() === true;
}

export function openModuleLoadConsoleWindow(): void {
  if (moduleLoadWindowOpen) return;
  moduleLoadWindowOpen = true;
  const backstop = setImmediate(() => {
    moduleLoadWindowOpen = false;
  });
  backstop.unref?.();
}

export function closeModuleLoadConsoleWindow(): void {
  moduleLoadWindowOpen = false;
}

export function runInConsoleCaptureWindow<T>(fn: () => T): T {
  const storage = getConsoleCaptureStorage();
  if (!storage) return fn();
  return storage.run(true, fn);
}

function inCaptureWindow<TArgs extends RuntimeValue[], TResult>(
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return function <TThis>(this: TThis, ...args: TArgs): TResult {
    return runInConsoleCaptureWindow(() => fn.apply(this, args));
  };
}

function isCaptureSeam(prop: PropertyKey): boolean {
  return prop === "on" || (isString(prop) && prop.startsWith("register"));
}

function wrapFunctionsInPlace<T extends RuntimeValue>(value: T): RuntimeValue {
  if (value instanceof Function) {
    // SAFETY: Function has been checked at runtime; the adapter forwards every argument and result.
    return inCaptureWindow(value as RuntimeFunction);
  }
  if (value === null || !isObjectRecord(value) || Array.isArray(value)) return value;
  for (const key of Object.keys(value)) {
    const propValue = readRuntimeProperty(value, key);
    if (propValue instanceof Function) {
      // SAFETY: Function has been checked at runtime; ConsoleFn only fixes the forwarding signature.
      assignWrapped(value, key, propValue as ConsoleFn);
    }
  }
  return value;
}

function assignWrapped<T extends object>(obj: T, key: string, fn: ConsoleFn): void {
  const wrapped = inCaptureWindow(fn);
  try {
    // SAFETY: key comes from Object.keys(obj), and wrapped preserves the checked function member's
    obj[key as keyof T] = wrapped as T[keyof T];
    return;
  } catch {}
  try {
    Object.defineProperty(obj, key, {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {}
}

export function withConsoleCaptureWindows<T extends object>(api: T): T {
  const wrapperCache = new Map<PropertyKey, RuntimeValue>();
  const proxy: T = new Proxy(api, {
    get(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor && descriptor.writable === false && descriptor.configurable === false) {
        return descriptor.value;
      }
      const cached = wrapperCache.get(prop);
      if (cached !== undefined) return cached;
      const value = readRuntimeProperty(target, prop);
      if (!(value instanceof Function)) return value;
      // SAFETY: Function has been checked at runtime; this signature models transparent forwarding.
      const method = value as RuntimeFunction;
      const keepProxy = <TResult>(result: TResult): TResult | T =>
        Object.is(result, target) ? proxy : result;
      const wrapper = isCaptureSeam(prop)
        ? (...args: RuntimeValue[]): RuntimeValue => {
            const wrapped = args.map((arg) => wrapFunctionsInPlace(arg));
            return keepProxy(method.apply(target, wrapped));
          }
        : (...args: RuntimeValue[]): RuntimeValue => {
            const current = readRuntimeProperty(target, prop);
            if (!(current instanceof Function)) return current;
            // SAFETY: Function has been checked on every invocation so reassigned methods stay live.
            return (current as RuntimeFunction).apply(target, args);
          };
      wrapperCache.set(prop, wrapper);
      return wrapper;
    },
  });
  return proxy;
}

function formatConsoleArgs(args: RuntimeValue[]): string {
  return args
    .map((arg) => {
      if (isString(arg)) return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

export function installConsoleGuard(): boolean {
  if (consoleGuardInstalled) return false;
  if (isTestMode()) return false;
  if (process.env.CHOCO_PI_LSP_CONSOLE_GUARD === "0") return false;
  consoleGuardInstalled = true;
  for (const method of CONSOLE_METHODS) {
    const original = console[method];
    if (!(original instanceof Function)) continue;
    // SAFETY: Every selected console member was checked as callable; the guard forwards all arguments.
    const originalFn = original as ConsoleFn;
    originalConsoleMethods.set(method, originalFn);
    const replacement: ConsoleFn = (...args: RuntimeValue[]): void => {
      if (!isConsoleCaptureActive()) {
        originalFn.apply(console, args);
        return;
      }
      logExtension({
        subsystem: "console",
        level: method === "warn" ? "warn" : method === "error" ? "error" : "debug",
        message: formatConsoleArgs(args),
        metadata: { method },
      });
    };
    installedConsoleMethods.set(method, replacement);
    // SAFETY: CONSOLE_METHODS contains only mutable function members of the Console interface.
    console[method] = replacement as Console[ConsoleMethod];
  }
  return true;
}

export function uninstallConsoleGuard(): boolean {
  if (!consoleGuardInstalled) return false;
  consoleGuardInstalled = false;
  for (const [method, original] of originalConsoleMethods) {
    if (console[method] === installedConsoleMethods.get(method)) {
      // SAFETY: The map stores the exact original callable captured from this console member.
      console[method] = original as Console[ConsoleMethod];
    }
  }
  originalConsoleMethods.clear();
  installedConsoleMethods.clear();
  return true;
}

export function _resetConsoleGuardForTests(): void {
  uninstallConsoleGuard();
  consoleGuardInstalled = false;
  consoleCaptureStorage = undefined;
  moduleLoadWindowOpen = false;
}
