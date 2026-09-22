import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { confirmCanonicalSearchRegistration, getSearchScope } from "../../index.ts";

export const registeredCanonicalSearchFrontend: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "web_search",
    label: "Canonical web search fixture",
    description: "Registered canonical web search fixture",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    async execute(_callId, parameters) {
      return {
        content: [{ type: "text", text: parameters.query ?? "canonical fixture" }],
        details: {},
      };
    },
  });
  confirmCanonicalSearchRegistration(getSearchScope(pi.events));
};
