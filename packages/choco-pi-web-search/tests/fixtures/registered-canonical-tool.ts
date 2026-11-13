import { obj, opt, str } from "@earendil-works/pi-schema";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { confirmCanonicalSearchRegistration, getSearchScope } from "../../index.ts";
import { hostParams } from "./schema-bridge.ts";

export const registeredCanonicalSearchFrontend: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "web_search",
    label: "Canonical web search fixture",
    description: "Registered canonical web search fixture",
    parameters: hostParams(obj({ query: opt(str()) }, { open: true })),
    async execute(_callId, parameters) {
      return {
        content: [{ type: "text", text: parameters.query ?? "canonical fixture" }],
        details: {},
      };
    },
  });
  confirmCanonicalSearchRegistration(getSearchScope(pi.events));
};
