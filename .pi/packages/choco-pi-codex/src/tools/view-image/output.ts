import type { BoundaryValue } from "../boundary.ts";
import { isObjectValue, isStringValue } from "../boundary.ts";
export type ViewImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  detail: "high" | "original";
};

export function imageContentsFromViewImageDetails(details: BoundaryValue): ViewImageContent[] {
  if (!details || !isObjectValue(details)) return [];
  const description = details.viewImageDescription;
  if (!description || !isObjectValue(description)) return [];
  const image = description.image;
  return isViewImageContent(image) ? [image] : [];
}

export function imageContentFromViewImageOutput(output: string): ViewImageContent | undefined {
  return imageContentsFromViewImageOutput(output)[0];
}

export function imageContentsFromViewImageOutput(output: string): ViewImageContent[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const whole = imageContentFromJson(trimmed);
  if (whole) return [whole];
  return trimmed.split(/\r?\n/).flatMap((line) => {
    const image = imageContentFromJson(line.trim());
    return image ? [image] : [];
  });
}

function imageContentFromJson(json: string): ViewImageContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || !isObjectValue(parsed)) return undefined;
  const imageUrl = parsed.image_url;
  const detail = parsed.detail;
  if (!isStringValue(imageUrl) || (detail !== "high" && detail !== "original")) return undefined;
  const match = imageUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  return match ? { type: "image", mimeType: match[1]!, data: match[2]!, detail } : undefined;
}

function isViewImageContent(value: BoundaryValue): value is ViewImageContent {
  return Boolean(
    value &&
    isObjectValue(value) &&
    value.type === "image" &&
    isStringValue(value.data) &&
    isStringValue(value.mimeType) &&
    (value.detail === "high" || value.detail === "original"),
  );
}
