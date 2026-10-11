import assert from "node:assert/strict";
import test from "node:test";

import { isRegisteredChildSession } from "../src/child-session.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function restoreRegistry(previous: PropertyDescriptor | undefined): void {
  if (previous) Object.defineProperty(globalThis, MANAGER_KEY, previous);
  else Reflect.deleteProperty(globalThis, MANAGER_KEY);
}

test("child identity validates the registry boundary and preserves the method receiver", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, MANAGER_KEY);
  const registry = {
    marker: "child-registry",
    isChildSessionId(sessionId: string): boolean {
      return this.marker === "child-registry" && sessionId === "child";
    },
  };
  try {
    Object.defineProperty(globalThis, MANAGER_KEY, { value: registry, configurable: true });
    assert.equal(isRegisteredChildSession("child"), true);
    assert.equal(isRegisteredChildSession("root"), false);
  } finally {
    restoreRegistry(previous);
  }
});

test("absent and malformed child registries are rejected without unchecked casts", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, MANAGER_KEY);
  try {
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    assert.equal(isRegisteredChildSession("child"), false);
    for (const value of [null, 42, "registry", {}, { isChildSessionId: true }]) {
      Object.defineProperty(globalThis, MANAGER_KEY, { value, configurable: true });
      assert.equal(isRegisteredChildSession("child"), false);
    }
  } finally {
    restoreRegistry(previous);
  }
});

test("unrelated errors from a valid child identity probe are not contained", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, MANAGER_KEY);
  const failure = new Error("registry failure");
  try {
    Object.defineProperty(globalThis, MANAGER_KEY, {
      value: {
        isChildSessionId: () => {
          throw failure;
        },
      },
      configurable: true,
    });
    assert.throws(() => isRegisteredChildSession("child"), failure);
  } finally {
    restoreRegistry(previous);
  }
});
