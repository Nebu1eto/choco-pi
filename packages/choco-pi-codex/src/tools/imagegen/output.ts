import { readFileSync } from "node:fs";
import { isJsonObject } from "../../adapter/runtime-values.ts";
import { isString } from "../../value-guards.ts";
import type { ViewImageContent } from "../view-image/output.ts";

// The binary protocol requires only `path`; optional fields are consumed defensively below.

export interface ImagegenOutput {
  path: string;
  latest_path?: string | undefined;
  images?:
    | Array<{
        path?: string | undefined;
        absolute_path?: string | undefined;
        latest_path?: string | undefined;
        latest_absolute_path?: string | undefined;
      }>
    | undefined;
  background?: string | undefined;
  quality?: string | undefined;
  size?: string | undefined;
}

function isImagegenOutput<T>(value: T): value is T & ImagegenOutput {
  return isJsonObject(value) && isString(value["path"]);
}

export function imagegenOutputFromJson(output: string): ImagegenOutput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return undefined;
  }
  return isImagegenOutput(parsed) ? parsed : undefined;
}

export function imageContentsFromImagegenOutput(output: ImagegenOutput): ViewImageContent[] {
  return (output.images ?? []).flatMap((image) => {
    if (!image.absolute_path) return [];
    try {
      return [
        {
          type: "image" as const,
          mimeType: "image/png",
          data: readFileSync(image.absolute_path).toString("base64"),
          detail: "high" as const,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function formatImagegenOutput(output: ImagegenOutput): string {
  return [
    `Generated image: ${output.path}`,
    ...(output.latest_path ? [`Latest: ${output.latest_path}`] : []),
  ].join("\n");
}
