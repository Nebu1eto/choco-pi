import type { UiResourcePermissions } from "./types.ts";
import {
  isObjectValue,
  isStringValue,
  parseMcpObject,
  type McpObject,
  type McpValue,
} from "./protocol-values.js";

export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

const RESOURCE_URI_META_KEY = "ui/resourceUri";

export function getToolUiResourceUri<BoundaryValue>(tool: {
  _meta?: BoundaryValue | undefined;
}): string | undefined {
  const rawMeta = tool._meta;
  const meta = isObjectValue(rawMeta) && rawMeta !== null ? parseMcpObject(rawMeta) : undefined;
  let resourceUri = getNestedResourceUri(meta);
  if (resourceUri === undefined) {
    resourceUri = meta?.[RESOURCE_URI_META_KEY];
  }

  if (isStringValue(resourceUri) && resourceUri.startsWith("ui://")) {
    return resourceUri;
  }

  if (resourceUri !== undefined) {
    throw new Error(`Invalid UI resource URI: ${JSON.stringify(resourceUri)}`);
  }

  return undefined;
}

export function buildAllowAttribute(permissions: UiResourcePermissions | undefined): string {
  if (!permissions) return "";

  const allowed: string[] = [];
  if (permissions.camera) allowed.push("camera");
  if (permissions.microphone) allowed.push("microphone");
  if (permissions.geolocation) allowed.push("geolocation");
  if (permissions.clipboardWrite) allowed.push("clipboard-write");
  return allowed.join("; ");
}

function getNestedResourceUri(meta: McpObject | undefined): McpValue {
  const ui = meta?.ui;

  if (!ui || !isObjectValue(ui)) return undefined;

  return parseMcpObject(ui).resourceUri;
}
