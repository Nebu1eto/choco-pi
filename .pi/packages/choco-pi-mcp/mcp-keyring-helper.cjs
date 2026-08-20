#!/usr/bin/env node
"use strict";

const { Type } = require("typebox");
const { Check } = require("typebox/value");

const RuntimeUndefinedSchema = Type.Undefined();
const RuntimeStringSchema = Type.String();
const RuntimeNumberSchema = Type.Number();
const RuntimeBigIntSchema = Type.BigInt();
const RuntimeBooleanSchema = Type.Boolean();
const RuntimeSymbolSchema = Type.Symbol();
const RuntimeFunctionSchema = Type.Function([], Type.Unknown());

function runtimeTypeOf(value) {
  if (Check(RuntimeUndefinedSchema, value)) return "undefined";
  if (Check(RuntimeStringSchema, value)) return "string";
  if (
    Check(RuntimeNumberSchema, value) ||
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  )
    return "number";
  if (Check(RuntimeBigIntSchema, value)) return "bigint";
  if (Check(RuntimeBooleanSchema, value)) return "boolean";
  if (Check(RuntimeSymbolSchema, value)) return "symbol";
  if (Check(RuntimeFunctionSchema, value)) return "function";
  return "object";
}

const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

const requireFromHere = createRequire(__filename);

function loadKeyringEntryClass() {
  try {
    return requireFromHere("@napi-rs/keyring").Entry;
  } catch (loaderError) {
    const suffixes = getNativeBindingSuffixes(process.platform, process.arch);
    let lastError;
    for (const suffix of suffixes) {
      try {
        const packageJsonPath = requireFromHere.resolve(`@napi-rs/keyring-${suffix}/package.json`);
        return requireFromHere(join(dirname(packageJsonPath), `keyring.${suffix}.node`)).Entry;
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(
      `Failed to load @napi-rs/keyring in recovery helper: ${lastError?.message ?? loaderError.message}`,
    );
    error.cause = loaderError;
    throw error;
  }
}

function getNativeBindingSuffixes(platform, arch) {
  if (platform === "linux") {
    if (arch === "arm64") return ["linux-arm64-gnu", "linux-arm64-musl"];
    if (arch === "arm") return ["linux-arm-gnueabihf"];
    if (arch === "riscv64") return ["linux-riscv64-gnu"];
    if (arch === "x64") return ["linux-x64-gnu", "linux-x64-musl"];
  }
  return [];
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.length > 1024 * 1024) {
        reject(new Error("request too large"));
        process.stdin.destroy();
      }
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

(async () => {
  try {
    const request = JSON.parse(await readStdin());

    if (!request || runtimeTypeOf(request) !== "object") throw new Error("invalid request");
    const { operation, service, account, payload } = request;
    if (!["read", "write", "remove"].includes(operation)) throw new Error("invalid operation");

    if (runtimeTypeOf(service) !== "string" || !service) throw new Error("invalid service");

    if (runtimeTypeOf(account) !== "string" || !account) throw new Error("invalid account");

    const Entry = loadKeyringEntryClass();
    const entry = new Entry(service, account);

    if (operation === "read") {
      const value = entry.getPassword();
      writeResponse(value === null ? { ok: true, found: false } : { ok: true, found: true, value });
      return;
    }
    if (operation === "write") {
      if (runtimeTypeOf(payload) !== "string") throw new Error("invalid payload");
      entry.setPassword(payload);
      writeResponse({ ok: true });
      return;
    }

    entry.deleteCredential();
    writeResponse({ ok: true });
  } catch (error) {
    writeResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
})();
