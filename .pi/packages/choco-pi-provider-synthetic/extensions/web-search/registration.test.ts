import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loadExtensionFromFactory } from "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import unifiedSearchCore from "../../../choco-pi-web-search/extension.ts";
import { registeredCanonicalSearchFrontend } from "../../../choco-pi-web-search/tests/fixtures/registered-canonical-tool.ts";
import { getSearchScope } from "../../../choco-pi-web-search/index.ts";
import syntheticWebSearchExtension from "./index.ts";

describe("Synthetic web-search registration mode", () => {
  it("keeps standalone compatibility without registering a canonical adapter", async () => {
    const bus = createEventBus();
    const loaded = await loadExtensionFromFactory(
      syntheticWebSearchExtension,
      process.cwd(),
      bus,
      createExtensionRuntime(),
      "<standalone-synthetic-search>",
    );

    expect(loaded.tools.has("synthetic_web_search")).toBe(true);
    expect(getSearchScope(bus).adapters.has("synthetic.search")).toBe(false);
  });

  it("keeps the standalone tool without canonical frontend confirmation", async () => {
    const bus = createEventBus();
    await loadExtensionFromFactory(
      unifiedSearchCore,
      process.cwd(),
      bus,
      createExtensionRuntime(),
      "<unified-search-core>",
    );
    const loaded = await loadExtensionFromFactory(
      syntheticWebSearchExtension,
      process.cwd(),
      bus,
      createExtensionRuntime(),
      "<canonical-synthetic-search>",
    );

    expect(loaded.tools.has("synthetic_web_search")).toBe(true);
    expect(getSearchScope(bus).adapters.has("synthetic.search")).toBe(false);
  });

  it("suppresses the standalone tool after the full canonical handshake", async () => {
    const bus = createEventBus();
    await loadExtensionFromFactory(
      unifiedSearchCore,
      process.cwd(),
      bus,
      createExtensionRuntime(),
      "<unified-search-core>",
    );
    await loadExtensionFromFactory(
      registeredCanonicalSearchFrontend,
      process.cwd(),
      bus,
      createExtensionRuntime(),
      "<canonical-search-frontend>",
    );
    const loaded = await loadExtensionFromFactory(
      syntheticWebSearchExtension,
      process.cwd(),
      bus,
      createExtensionRuntime(),
      "<canonical-synthetic-search>",
    );

    expect(loaded.tools.has("synthetic_web_search")).toBe(false);
    expect(getSearchScope(bus).adapters.has("synthetic.search")).toBe(true);
  });
});
