import { setImmediate } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  bindSearchSession,
  createSearchScope,
  registerSearchAdapter,
  search,
  SearchError,
  type SearchAdapter,
} from "../../index.ts";

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

const scope = createSearchScope();
bindSearchSession(scope, SessionManager.inMemory("/tmp/choco-pi-web-search-cancellation-fixture"));
const controller = new AbortController();
const adapter: SearchAdapter = {
  id: "synchronous-canceller",
  family: "openai",
  transport: "fixture",
  capabilities: { actions: ["search"] },
  availability: () => ({ status: "available" }),
  execute: async () => {
    controller.abort();
    throw new SearchError("cancelled", "adapter rejected after synchronous cancellation");
  },
};
registerSearchAdapter(scope, adapter);

try {
  await search({ query: "fixture" }, { scope, signal: controller.signal });
  throw new Error("Expected search cancellation");
} catch (cause) {
  if (!(cause instanceof SearchError) || cause.kind !== "cancelled") throw cause;
}

await setImmediate();
if (unhandled.length > 0) {
  throw new Error(`Observed ${unhandled.length} unhandled adapter rejection(s)`);
}
process.stdout.write("cancellation-settled-ok\n");
