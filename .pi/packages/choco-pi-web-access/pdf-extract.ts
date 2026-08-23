/**
 * PDF Content Extractor
 *
 * Converts PDFs to Markdown. The `auto` provider chain runs Datalab
 * (deterministic, layout-aware) first, with unpdf as the deterministic local
 * fallback; the chain can also be pinned with `pdf.provider`.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { CredentialResolutionError } from "./credential-source.ts";
import {
  DEFAULT_DATALAB_TIMEOUT_MS,
  isDatalabApiAvailable,
  normalizeDatalabMode,
  extractPDFViaDatalab,
  type DatalabMode,
} from "./datalab-pdf-extract.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export interface PDFExtractResult {
  title: string;
  pages: number;
  chars: number;
  outputPath: string;
}

export interface PDFExtractOptions {
  maxPages?: number;
  outputDir?: string;
  filename?: string;
  signal?: AbortSignal;
}

export type PDFProvider = "auto" | "datalab" | "unpdf";

export const PDF_PROVIDER_VALUES = new Set<PDFProvider>(["auto", "datalab", "unpdf"]);

export interface PDFConfig {
  enabled: boolean;
  maxSizeMB: number;
  maxPages: number;
  provider: PDFProvider;
  datalabMode: DatalabMode;
  datalabTimeoutMs: number;
}

export const DEFAULT_PDF_MAX_SIZE_MB = 20;
export const MAX_PDF_MAX_SIZE_MB = 50;
export const MAX_DATALAB_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_OUTPUT_DIR = join(tmpdir(), "pi-web-pdf");
const CONFIG_PATH = getWebSearchConfigPath();

type ConfigValue = null | boolean | number | string | ConfigValue[] | ConfigObject;
interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}
interface PromiseConstructorWithTry extends PromiseConstructor {
  try?: (...args: never[]) => Promise<never>;
}

function isConfigObject(value: ConfigValue | undefined): value is ConfigObject {
  return (
    value !== null &&
    value !== undefined &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function isNumber(value: ConfigValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function primitiveString(value: ConfigValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]" && Object(value) !== value
    ? String(value)
    : undefined;
}

export function loadPDFConfig(): PDFConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {
      enabled: true,
      maxSizeMB: DEFAULT_PDF_MAX_SIZE_MB,
      maxPages: DEFAULT_MAX_PAGES,
      provider: "auto",
      datalabMode: normalizeDatalabMode(process.env.DATALAB_MODE),
      datalabTimeoutMs: DEFAULT_DATALAB_TIMEOUT_MS,
    };
  }

  const rawText = readFileSync(CONFIG_PATH, "utf-8");
  let raw: ConfigValue;
  try {
    // SAFETY: JSON.parse accepts only JSON syntax, whose runtime values are exactly ConfigValue.
    raw = JSON.parse(rawText) as ConfigValue;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }

  const root: ConfigObject = isConfigObject(raw) ? raw : {};
  const pdf: ConfigObject = isConfigObject(root.pdf) ? root.pdf : {};
  const enabled = pdf.enabled !== false;
  const configured = pdf.maxSizeMB;
  const normalized =
    isNumber(configured) && Number.isFinite(configured) && configured > 0
      ? Math.min(configured, MAX_PDF_MAX_SIZE_MB)
      : DEFAULT_PDF_MAX_SIZE_MB;
  const configuredMaxPages = pdf.maxPages;
  const maxPages =
    isNumber(configuredMaxPages) && Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
      ? Math.max(1, Math.floor(configuredMaxPages))
      : DEFAULT_MAX_PAGES;

  const provider: PDFProvider =
    pdf.provider === "auto" || pdf.provider === "datalab" || pdf.provider === "unpdf"
      ? pdf.provider
      : "auto";
  const datalabMode: DatalabMode =
    pdf.datalabMode === "fast" || pdf.datalabMode === "balanced" || pdf.datalabMode === "accurate"
      ? pdf.datalabMode
      : normalizeDatalabMode(process.env.DATALAB_MODE);
  const configuredTimeout = pdf.datalabTimeoutMs;
  const datalabTimeoutMs =
    isNumber(configuredTimeout) && Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, MAX_DATALAB_TIMEOUT_MS)
      : DEFAULT_DATALAB_TIMEOUT_MS;

  return {
    enabled,
    maxSizeMB: normalized,
    maxPages,
    provider,
    datalabMode,
    datalabTimeoutMs,
  };
}

async function getUnpdf() {
  // SAFETY: promise.try's shim adds only this optional static method to the global Promise constructor.
  const promiseConstructor = Promise as PromiseConstructorWithTry;
  if (Object.prototype.toString.call(promiseConstructor.try) !== "[object Function]") {
    const { default: promiseTry } = await import("promise.try");
    promiseTry.shim();
  }

  const [unpdf, pdfjs] = await Promise.all([import("unpdf"), import("unpdf/pdfjs")]);
  // SAFETY: unpdf/pdfjs exposes VerbosityLevel at runtime although its declaration omits that re-export.
  const { VerbosityLevel } = pdfjs as typeof pdfjs & {
    VerbosityLevel: { ERRORS: number };
  };

  return { getDocumentProxy: unpdf.getDocumentProxy, VerbosityLevel };
}

/**
 * Extract text from a PDF buffer and save it to a Markdown file.
 */
export async function extractPDFToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  options: PDFExtractOptions = {},
): Promise<PDFExtractResult> {
  const { maxPages, outputDir = DEFAULT_OUTPUT_DIR, filename, signal } = options;

  const pdfConfig = loadPDFConfig();
  const safeMaxPages =
    maxPages === undefined
      ? pdfConfig.maxPages
      : Number.isFinite(maxPages)
        ? Math.max(1, Math.floor(maxPages))
        : DEFAULT_MAX_PAGES;
  const urlTitle = extractTitleFromURL(url);
  const provider = pdfConfig.provider;

  if (provider === "auto" || provider === "datalab") {
    try {
      if (isDatalabApiAvailable()) {
        const datalabOptions: Parameters<typeof extractPDFViaDatalab>[1] = {
          maxPages: safeMaxPages,
          title: urlTitle,
          mode: pdfConfig.datalabMode,
          timeoutMs: pdfConfig.datalabTimeoutMs,
        };
        if (signal) datalabOptions.signal = signal;
        const result = await extractPDFViaDatalab(buffer, datalabOptions);
        return writeMarkdownResult({
          markdownBody: result.markdown,
          title: urlTitle,
          pages: result.pages,
          outputDir,
          filename,
          url,
        });
      }
    } catch (err) {
      if (shouldRethrowExtractionError(err, signal)) throw err;
    }
  }

  const { getDocumentProxy, VerbosityLevel } = await getUnpdf();
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    verbosity: VerbosityLevel.ERRORS,
  });
  const metadata = await pdf.getMetadata();
  const metadataInfo = metadata.info;
  const metaTitleValue = metadataInfo
    ? Object.getOwnPropertyDescriptor(metadataInfo, "Title")?.value
    : undefined;
  const metaAuthorValue = metadataInfo
    ? Object.getOwnPropertyDescriptor(metadataInfo, "Author")?.value
    : undefined;
  const metaTitle = primitiveString(metaTitleValue);
  const metaAuthor = primitiveString(metaAuthorValue);
  const title = metaTitle?.trim() || urlTitle;
  const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
  const truncated = pdf.numPages > safeMaxPages;
  const pages: { pageNum: number; text: string }[] = [];

  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText) {
      pages.push({ pageNum: i, text: pageText });
    }
  }

  const bodyLines: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (i > 0) {
      bodyLines.push("");
      bodyLines.push(`<!-- Page ${pages[i].pageNum} -->`);
      bodyLines.push("");
    }
    bodyLines.push(pages[i].text);
  }

  return writeMarkdownResult({
    markdownBody: bodyLines.join("\n"),
    title,
    pages: pdf.numPages,
    outputDir,
    filename,
    url,
    metaAuthor,
    truncated,
    pagesToExtract,
  });
}

async function writeMarkdownResult(options: {
  markdownBody: string;
  title: string;
  pages: number;
  outputDir: string;
  filename?: string;
  url: string;
  metaAuthor?: string;
  truncated?: boolean;
  pagesToExtract?: number;
}): Promise<PDFExtractResult> {
  const lines: string[] = [];
  lines.push(`# ${options.title}`);
  lines.push("");
  lines.push(`> Source: ${options.url}`);
  lines.push(
    `> Pages: ${options.pages}${options.truncated ? ` (extracted first ${options.pagesToExtract})` : ""}`,
  );
  if (options.metaAuthor) lines.push(`> Author: ${options.metaAuthor}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  if (options.markdownBody) lines.push(options.markdownBody);

  if (options.truncated) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(
      `*[Truncated: Only first ${options.pagesToExtract} of ${options.pages} pages extracted]*`,
    );
  }

  const content = lines.join("\n");
  const outputFilename = options.filename || sanitizeFilename(options.title) + ".md";
  const outputPath = join(options.outputDir, outputFilename);

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, content, "utf-8");

  return {
    title: options.title,
    pages: options.pages,
    chars: content.length,
    outputPath,
  };
}

function shouldRethrowExtractionError(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (cause instanceof CredentialResolutionError) return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.startsWith("Failed to parse ");
}

/**
 * Extract a reasonable title from URL
 */
function extractTitleFromURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    let filename = basename(pathname, ".pdf");

    if (urlObj.hostname.includes("arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) {
        filename = `arxiv-${match[1]}`;
      }
    }

    filename = filename.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

    return filename || "document";
  } catch {
    return "document";
  }
}

/**
 * Sanitize string for use as filename
 */
function sanitizeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 100)
      .replace(/^-|-$/g, "") || "document"
  );
}

/**
 * Check if URL or content-type indicates a PDF
 */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) {
    return true;
  }
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
