import { Buffer } from "node:buffer";
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

const DEFAULT_MAX_WIDTH_CELLS = 80;
const DEFAULT_MAX_HEIGHT_ROWS = 40;
const DEFAULT_BACKGROUND = { red: 26, green: 26, blue: 26 };

export const IMAGE_MOSAIC_ENV = "CHOCO_PI_IMAGE_MOSAIC";

export type InlineImageProtocol = "kitty" | "iterm2" | null;

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface HalfBlockImageOptions {
  maxWidthCells?: number | undefined;
  maxHeightRows?: number | undefined;
  background?: RgbColor | undefined;
}

export interface HalfBlockMosaicGateInput {
  imageProtocol: InlineImageProtocol;
  colorterm?: string | undefined;
  showImages: boolean;
  stdoutIsTTY: boolean;
  mosaic?: string | undefined;
}

interface TargetDimensions {
  width: number;
  rows: number;
}

function imageMimeType(mimeType: string): "png" | "jpeg" | undefined {
  switch (mimeType.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpeg";
    default:
      return undefined;
  }
}

function isDecodedImage(image: DecodedImage): boolean {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) return false;
  if (image.width < 1 || image.height < 1) return false;
  const expectedLength = image.width * image.height * 4;
  return Number.isSafeInteger(expectedLength) && image.data.length >= expectedLength;
}

/** Decode the PNG or JPEG payload into the RGBA pixels used by the mosaic encoder. */
export function decodeBase64Image(base64Data: string, mimeType: string): DecodedImage | undefined {
  const format = imageMimeType(mimeType);
  if (!format) return undefined;

  try {
    const bytes = Buffer.from(base64Data, "base64");
    if (bytes.length === 0) return undefined;
    if (format === "png") {
      const image = PNG.sync.read(bytes);
      const decoded = { width: image.width, height: image.height, data: image.data };
      return isDecodedImage(decoded) ? decoded : undefined;
    }
    const image = decodeJpeg(bytes, { formatAsRGBA: true, tolerantDecoding: true });
    const decoded = { width: image.width, height: image.height, data: image.data };
    return isDecodedImage(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizedColor(color: RgbColor | undefined): RgbColor {
  if (!color) return DEFAULT_BACKGROUND;
  return {
    red: clampByte(color.red),
    green: clampByte(color.green),
    blue: clampByte(color.blue),
  };
}

function targetDimensions(image: DecodedImage, options: HalfBlockImageOptions): TargetDimensions {
  const maxWidth = positiveInteger(options.maxWidthCells, DEFAULT_MAX_WIDTH_CELLS);
  const maxRows = positiveInteger(options.maxHeightRows, DEFAULT_MAX_HEIGHT_ROWS);
  let width = Math.min(image.width, maxWidth);
  let rows = Math.max(1, Math.ceil((image.height * width) / image.width / 2));
  if (rows > maxRows) {
    rows = maxRows;
    width = Math.min(maxWidth, Math.max(1, Math.round((rows * 2 * image.width) / image.height)));
  }
  return { width, rows };
}

function averageColor(
  image: DecodedImage,
  left: number,
  top: number,
  right: number,
  bottom: number,
  background: RgbColor,
): RgbColor {
  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;
  const firstX = Math.floor(left);
  const lastX = Math.ceil(right);
  const firstY = Math.floor(top);
  const lastY = Math.ceil(bottom);

  for (let y = firstY; y < lastY; y += 1) {
    const verticalWeight = Math.min(y + 1, bottom) - Math.max(y, top);
    if (verticalWeight <= 0) continue;
    for (let x = firstX; x < lastX; x += 1) {
      const horizontalWeight = Math.min(x + 1, right) - Math.max(x, left);
      const weight = horizontalWeight * verticalWeight;
      if (weight <= 0) continue;
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3]! / 255;
      red += (image.data[offset]! * alpha + background.red * (1 - alpha)) * weight;
      green += (image.data[offset + 1]! * alpha + background.green * (1 - alpha)) * weight;
      blue += (image.data[offset + 2]! * alpha + background.blue * (1 - alpha)) * weight;
      totalWeight += weight;
    }
  }

  return {
    red: clampByte(red / totalWeight),
    green: clampByte(green / totalWeight),
    blue: clampByte(blue / totalWeight),
  };
}

function sgrForeground(color: RgbColor): string {
  return `\x1b[38;2;${color.red};${color.green};${color.blue}m`;
}

function sgrBackground(color: RgbColor): string {
  return `\x1b[48;2;${color.red};${color.green};${color.blue}m`;
}

/** Convert decoded RGBA pixels into ANSI truecolor Unicode half-block lines. */
export function renderHalfBlockPixels(
  image: DecodedImage,
  options: HalfBlockImageOptions = {},
): string[] {
  if (!isDecodedImage(image)) return [];
  const { width, rows } = targetDimensions(image, options);
  const background = normalizedColor(options.background);
  const pixelHeight = rows * 2;
  const lines: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let column = 0; column < width; column += 1) {
      const left = (column * image.width) / width;
      const right = ((column + 1) * image.width) / width;
      const top = (row * 2 * image.height) / pixelHeight;
      const middle = ((row * 2 + 1) * image.height) / pixelHeight;
      const bottom = ((row * 2 + 2) * image.height) / pixelHeight;
      const foreground = averageColor(image, left, top, right, middle, background);
      const back = averageColor(image, left, middle, right, bottom, background);
      line += `${sgrForeground(foreground)}${sgrBackground(back)}▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }

  return lines;
}

/** Decode a base64 PNG/JPEG and return its ANSI truecolor Unicode half-block mosaic. */
export function renderHalfBlockImage(
  base64Data: string,
  mimeType: string,
  options: HalfBlockImageOptions = {},
): string[] | undefined {
  const image = decodeBase64Image(base64Data, mimeType);
  return image ? renderHalfBlockPixels(image, options) : undefined;
}

export function hasTrueColor(colorterm: string | undefined): boolean {
  const value = colorterm?.toLowerCase() ?? "";
  return value.includes("truecolor") || value.includes("24bit");
}

function mosaicDisabled(value: string | undefined): boolean {
  switch (value?.trim().toLowerCase()) {
    case "off":
    case "0":
    case "false":
    case "no":
      return true;
    default:
      return false;
  }
}

/** Whether terminal state permits the text mosaic fallback instead of inline graphics. */
export function shouldRenderHalfBlockMosaic(input: HalfBlockMosaicGateInput): boolean {
  return (
    input.imageProtocol === null &&
    input.showImages &&
    input.stdoutIsTTY &&
    hasTrueColor(input.colorterm) &&
    !mosaicDisabled(input.mosaic)
  );
}
