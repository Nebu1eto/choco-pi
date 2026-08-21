import { isAbsolute, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  getImageDimensions,
  Image,
  type ImageOptions,
  imageFallback,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  IMAGE_MOSAIC_ENV,
  renderHalfBlockImage,
  shouldRenderHalfBlockMosaic,
} from "./halfblock-image.ts";

interface ImageContentLike {
  type: "image";
  data: string;
  mimeType: string;
}

type ToolContentLike = { type: string; text?: string | undefined } | ImageContentLike;

function isImageContent(item: ToolContentLike): item is ImageContentLike {
  return (
    item.type === "image" &&
    "data" in item &&
    Value.Check(Type.String(), item.data) &&
    "mimeType" in item &&
    Value.Check(Type.String(), item.mimeType)
  );
}

interface MediaRenderOptions {
  paddingX?: number | undefined;
  showImages?: boolean | undefined;
  imageWidthCells?: number | undefined;
  cwd?: string | undefined;
  imagePaths?: Array<string | undefined> | undefined;
}

function configuredImageWidthCells(cwd: string | undefined): number {
  try {
    return SettingsManager.create(cwd ?? process.cwd()).getImageWidthCells();
  } catch {
    return 60;
  }
}

function absoluteImagePath(path: string | undefined, cwd: string | undefined): string | undefined {
  if (!path) return undefined;
  const rawPath = path.startsWith("@") ? path.slice(1) : path;
  if (!rawPath) return undefined;
  return isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath);
}

function nativeImageOptions(maxWidthCells: number, filename: string | undefined): ImageOptions {
  const options: ImageOptions = { maxWidthCells };
  if (filename) options.filename = filename;
  return options;
}

export function renderTextWithImages(
  text: string,
  content: ToolContentLike[],
  theme: { fg(role: string, text: string): string },
  options: MediaRenderOptions = {},
): Text | Container {
  const images = content.filter(isImageContent);
  if (!images.length) return new Text(text, options.paddingX ?? 0, 0);

  const showImages = options.showImages ?? true;
  const imageWidthCells = options.imageWidthCells ?? configuredImageWidthCells(options.cwd);
  const capabilities = getCapabilities();
  const box = new Container();
  box.addChild(new Text(text, options.paddingX ?? 0, 0));
  for (const [index, image] of images.entries()) {
    const path = absoluteImagePath(options.imagePaths?.[index], options.cwd);
    const fallback = imageFallback(
      image.mimeType,
      getImageDimensions(image.data, image.mimeType) ?? undefined,
      path,
    );
    box.addChild(new Spacer(1));
    if (!showImages) {
      box.addChild(new Text(theme.fg("dim", fallback), 0, 0));
      continue;
    }

    const mosaic = shouldRenderHalfBlockMosaic({
      imageProtocol: capabilities.images,
      colorterm: process.env.COLORTERM,
      showImages,
      stdoutIsTTY: process.stdout.isTTY === true,
      mosaic: process.env[IMAGE_MOSAIC_ENV],
    })
      ? renderHalfBlockImage(image.data, image.mimeType, { maxWidthCells: imageWidthCells })
      : undefined;
    if (mosaic?.length) {
      box.addChild(new Text(mosaic.join("\n"), 0, 0));
      if (path) box.addChild(new Text(theme.fg("dim", fallback), 0, 0));
      continue;
    }

    box.addChild(
      new Image(
        image.data,
        image.mimeType,
        { fallbackColor: (value) => theme.fg("dim", value) },
        nativeImageOptions(imageWidthCells, path),
      ),
    );
  }
  return box;
}
