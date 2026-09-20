import JSZip from "jszip";

import { MAX_EXTRACTED_TEXT_BYTES, MAX_FILE_BYTES, scanPlainText } from "./scan.js";
import type {
  ExtractedFileText,
  FileFormat,
  FileScanOptions,
  FileScanResult,
  FileScanSummary,
  LocalScanFile,
} from "./types.js";
import { assertExtensionLocalUrl, SCANNABLE_TEXT_EXTENSIONS } from "./types.js";

const MAX_PDF_PAGES = 20;
const MAX_OFFICE_ENTRIES = 2_048;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_OFFICE_COMPRESSION_RATIO = 1_000;
// 单个待提取条目的压缩数据上限。
//
// 中央目录声明的 uncompressedSize 不可信：可以声明 1:1 却在解压时膨胀上千倍，
// 从而绕过压缩比与总量两道基于声明值的闸门。压缩数据量则是可信的（就是实际读取
// 长度），而 deflate 的理论上界约 1032:1，因此限制它能间接约束最坏解压量。
// 正常 2 MiB 的 Office XML 压缩后通常只有 100-300 KiB，512 KiB 留了充足余量。
// 这是缓解而非根治：根治需要流式解压并按输出长度截断。边界记录在 PRIVACY.md。
const MAX_OFFICE_ENTRY_COMPRESSED_BYTES = 512 * 1024;
// [Content_Types].xml 与根 _rels/.rels 只描述 OPC 结构，不含用户可读内容。
// 不把它们计入未覆盖部件，否则每个 Office 文件都会被标成部分扫描而失去区分度。
const OFFICE_STRUCTURAL_ENTRIES = new Set(["[Content_Types].xml", "_rels/.rels"]);
let pdfWorkerUrl: string | undefined;

// docProps 带作者与最后修改者，customXml 是自定义数据存储，两者都可能含 PII，
// 因此纳入文本提取范围，而不是留作"未覆盖"仅提示了事。
function officeTextPrefixes(format: "docx" | "xlsx"): readonly string[] {
  return [format === "docx" ? "word/" : "xl/", "docProps/", "customXml/"];
}

function isOfficeTextPart(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix)) && /\.(?:xml|rels)$/iu.test(name);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function zipEndOfCentralDirectory(bytes: Uint8Array): number | null {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  return null;
}

type OfficeArchiveEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
};

type OfficePreflight = {
  entries: OfficeArchiveEntry[];
  estimatedTextBytes: number;
};

function hasUnsafeArchiveName(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) || normalized.split("/").some((part) => part === "..");
}

function inspectOfficeCentralDirectory(arrayBuffer: ArrayBuffer, format: "docx" | "xlsx"): OfficePreflight | "limit" | null {
  const bytes = new Uint8Array(arrayBuffer);
  const end = zipEndOfCentralDirectory(bytes);
  if (end === null) {
    return null;
  }

  const entryCount = readUint16(bytes, end + 10);
  const directorySize = readUint32(bytes, end + 12);
  let offset = readUint32(bytes, end + 16);
  if (entryCount === 0xffff || offset === 0xffffffff || directorySize > end || offset + directorySize > end) {
    return null;
  }

  const textPrefixes = officeTextPrefixes(format);
  let estimatedTextBytes = 0;
  let totalUncompressedBytes = 0;
  const entries: OfficeArchiveEntry[] = [];
  const names = new Set<string>();
  if (entryCount > MAX_OFFICE_ENTRIES) {
    return "limit";
  }

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || readUint32(bytes, offset) !== 0x02014b50) {
      return null;
    }
    const flags = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const filenameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const filenameStart = offset + 46;
    const nextOffset = filenameStart + filenameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || nextOffset > end) {
      return null;
    }

    const filename = new TextDecoder().decode(bytes.subarray(filenameStart, filenameStart + filenameLength));
    if (hasUnsafeArchiveName(filename) || names.has(filename)) {
      return null;
    }
    names.add(filename);
    if ((flags & 0x0001) !== 0) {
      return null;
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      return null;
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_OFFICE_COMPRESSION_RATIO) {
      return "limit";
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      return "limit";
    }
    if (isOfficeTextPart(filename, textPrefixes)) {
      if (compressedSize > MAX_OFFICE_ENTRY_COMPRESSED_BYTES) {
        return "limit";
      }
      estimatedTextBytes += uncompressedSize;
      if (estimatedTextBytes > MAX_EXTRACTED_TEXT_BYTES) {
        return "limit";
      }
    }
    entries.push({ name: filename, compressedSize, uncompressedSize, flags });
    offset = nextOffset;
  }

  return { entries, estimatedTextBytes };
}

export function setLocalPdfWorkerUrl(url: string): void {
  assertExtensionLocalUrl(url, "PDF worker must use a chrome-extension URL");
  pdfWorkerUrl = url;
}

export function createLocalPdfWorkerUrl(getUrl: (path: string) => string): string {
  return getUrl("vendor/pdfjs/pdf.worker.mjs");
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

export function detectFileFormat(file: Pick<LocalScanFile, "name" | "type">): FileFormat {
  const extension = extensionOf(file.name);
  if (SCANNABLE_TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }
  if (extension === "docx") {
    return "docx";
  }
  if (extension === "xlsx") {
    return "xlsx";
  }
  if (extension === "pdf") {
    return "pdf";
  }
  if (["png", "jpg", "jpeg", "webp"].includes(extension) || file.type.startsWith("image/")) {
    return "image";
  }
  return "unknown";
}

function decodeXmlText(input: string): string {
  const decodeEntities = (value: string): string => value
    .replace(/&#x([0-9a-f]{1,6});/giu, (_match, code: string) => {
      const number = Number.parseInt(code, 16);
      return Number.isSafeInteger(number) && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/&#([0-9]{1,7});/gu, (_match, code: string) => {
      const number = Number.parseInt(code, 10);
      return Number.isSafeInteger(number) && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
  const attributes = [...input.matchAll(/\b(?:Target|href|location|display)=["']([^"']+)["']/gu)]
    .map((match) => decodeEntities(match[1] ?? ""));
  const text = input
    .replace(/<[^>]*>/gu, " ")
    .replace(/&#x([0-9a-f]{1,6});/giu, (_match, code: string) => {
      const number = Number.parseInt(code, 16);
      return Number.isSafeInteger(number) && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/&#([0-9]{1,7});/gu, (_match, code: string) => {
      const number = Number.parseInt(code, 10);
      return Number.isSafeInteger(number) && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
  return [...attributes, text].filter(Boolean).join("\n");
}

function looksLikeBinaryText(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))) {
    return false;
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 32_768));
  let controlCount = 0;
  for (const value of sample) {
    if (value === 0) {
      return true;
    }
    if (value < 0x09 || (value > 0x0d && value < 0x20)) {
      controlCount += 1;
    }
  }
  return controlCount / sample.length > 0.02;
}

function countReplacementCharacters(input: string): number {
  let count = 0;
  for (const character of input) {
    if (character === "\ufffd") {
      count += 1;
    }
  }
  return count;
}

function looksLikeUtf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4_096);
  if (sampleLength < 4) {
    return null;
  }
  let evenZeroes = 0;
  let oddZeroes = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) {
      evenZeroes += 1;
    }
    if (bytes[index + 1] === 0) {
      oddZeroes += 1;
    }
  }
  const pairs = sampleLength / 2;
  if (oddZeroes >= pairs * 0.2 && oddZeroes > evenZeroes * 2) {
    return "utf-16le";
  }
  if (evenZeroes >= pairs * 0.2 && evenZeroes > oddZeroes * 2) {
    return "utf-16be";
  }
  return null;
}

export function decodeTextBytes(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2)).replace(/^\ufeff/u, "");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2)).replace(/^\ufeff/u, "");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3)).replace(/^\ufeff/u, "");
  }

  const utf16Encoding = looksLikeUtf16(bytes);
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (utf16Encoding !== null) {
    const utf16 = new TextDecoder(utf16Encoding).decode(bytes);
    if (countReplacementCharacters(utf16) < countReplacementCharacters(utf8)) {
      return utf16.replace(/^\ufeff/u, "");
    }
  }

  try {
    const gb18030 = new TextDecoder("gb18030").decode(bytes);
    if (countReplacementCharacters(gb18030) < countReplacementCharacters(utf8)) {
      return gb18030.replace(/^\ufeff/u, "");
    }
  } catch {
    // Some older runtimes do not expose the GB18030 decoder.
  }
  return utf8.replace(/^\ufeff/u, "");
}

async function extractOfficeZipText(
  arrayBuffer: ArrayBuffer,
  format: "docx" | "xlsx",
): Promise<ExtractedFileText> {
  const preflight = inspectOfficeCentralDirectory(arrayBuffer, format);
  if (preflight === null) {
    return unscannable(format, "parse_failed");
  }
  if (preflight === "limit" || preflight.estimatedTextBytes > MAX_EXTRACTED_TEXT_BYTES) {
    return unscannable(format, "text_limit");
  }
  const archive = await JSZip.loadAsync(arrayBuffer);
  const textPrefixes = officeTextPrefixes(format);
  const entries = Object.values(archive.files).filter(
    (entry) => !entry.dir
      && preflight.entries.some((candidate) => candidate.name === entry.name)
      && isOfficeTextPart(entry.name, textPrefixes),
  );
  if (entries.length === 0) {
    return unscannable(format, "parse_failed");
  }
  const parts: string[] = [];
  let extractedBytes = 0;

  for (const entry of entries) {
    const text = decodeXmlText(await entry.async("text"));
    extractedBytes += new TextEncoder().encode(text).byteLength;
    if (extractedBytes > MAX_EXTRACTED_TEXT_BYTES) {
      return unscannable(format, "text_limit");
    }
    if (text) {
      parts.push(text);
    }
  }

  // 任何既未被提取、又不属于 OPC 结构描述的部件都构成未覆盖内容：
  // media/ 图片、embeddings/ 内嵌 OLE 对象（可能是整个 Excel 表）、
  // docProps/thumbnail.jpeg 首页缩略图等二进制都在此列。
  const hasUncoveredParts = Object.values(archive.files).some(
    (entry) => !entry.dir
      && !isOfficeTextPart(entry.name, textPrefixes)
      && !OFFICE_STRUCTURAL_ENTRIES.has(entry.name),
  );
  return {
    format,
    coverage: hasUncoveredParts ? "partial" : "complete",
    text: parts.join("\n\n"),
    summary: hasUncoveredParts ? { reason: "embedded_media" } : {},
  };
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  let end = 0;
  for (const character of input) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += character.length;
  }
  return input.slice(0, end);
}

async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<ExtractedFileText> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (pdfWorkerUrl !== undefined) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer),
    useSystemFonts: true,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    useWasm: false,
  });
  let pdfDocument: Awaited<typeof loadingTask.promise> | undefined;
  const pages: string[] = [];
  const encoder = new TextEncoder();
  let collectedBytes = 0;
  let pagesWithText = 0;
  let pagesWithoutText = 0;
  let processedPages = 0;
  let parseFailed = false;
  let textLimit = false;

  try {
    pdfDocument = await loadingTask.promise;
    const limit = Math.min(pdfDocument.numPages, MAX_PDF_PAGES);
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      processedPages = pageNumber;
      let text = "";
      try {
        const page = await pdfDocument.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          text = content.items
            .map((item) => "str" in item && typeof item.str === "string" ? item.str : "")
            .filter(Boolean)
            .join(" ")
            .trim();
        } finally {
          page.cleanup();
        }
      } catch {
        parseFailed = true;
        break;
      }

      if (!text) {
        pagesWithoutText += 1;
        continue;
      }

      pagesWithText += 1;
      const separator = pages.length === 0 ? "" : "\n\n";
      const separatorBytes = encoder.encode(separator).byteLength;
      const remainingBytes = MAX_EXTRACTED_TEXT_BYTES - collectedBytes - separatorBytes;
      if (remainingBytes <= 0) {
        textLimit = true;
        break;
      }
      const textBytes = encoder.encode(text).byteLength;
      const pageText = textBytes > remainingBytes ? truncateUtf8(text, remainingBytes) : text;
      if (pageText.length > 0) {
        pages.push(`${separator}${pageText}`);
        collectedBytes += separatorBytes + encoder.encode(pageText).byteLength;
      }
      if (textBytes > remainingBytes) {
        textLimit = true;
        break;
      }
    }

    const skippedPages = Math.max(0, pdfDocument.numPages - processedPages);
    // Text extraction cannot establish coverage of rasterized or embedded PDF content.
    const coverage = "partial";
    const reason = textLimit
      ? "text_limit" as const
      : parseFailed
        ? "parse_failed" as const
          : skippedPages > 0
          ? "page_limit" as const
          : pagesWithText === 0
          ? "pdf_without_text" as const
          : "pdf_text_layer_only" as const;
    return {
      format: "pdf",
      coverage,
      text: pages.join(""),
      summary: coverage === "partial"
        ? {
            reason,
            pagesWithText,
            pagesWithoutText: pagesWithoutText + skippedPages,
          }
        : { pagesWithText, pagesWithoutText: 0 },
    };
  } finally {
    try {
      pdfDocument?.cleanup();
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}

function unscannable(
  format: FileFormat,
  reason: "text_limit" | "file_limit" | "unsupported_format" | "parse_failed",
): ExtractedFileText {
  return { format, coverage: "none", text: "", summary: { reason } };
}

export async function extractFileText(file: LocalScanFile): Promise<ExtractedFileText> {
  const format = detectFileFormat(file);
  if (file.size > MAX_FILE_BYTES) {
    return unscannable(format, "file_limit");
  }
  if (format === "unknown" || format === "image") {
    return unscannable(format, "unsupported_format");
  }

  try {
    if (format === "text") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksLikeBinaryText(bytes)) {
        return unscannable(format, "parse_failed");
      }
      return { format, coverage: "complete", text: decodeTextBytes(bytes.buffer), summary: {} };
    }

    const arrayBuffer = await file.arrayBuffer();
    if (format === "docx") {
      return await extractOfficeZipText(arrayBuffer, "docx");
    }
    if (format === "xlsx") {
      return await extractOfficeZipText(arrayBuffer, "xlsx");
    }
    return await extractPdfText(arrayBuffer);
  } catch {
    return unscannable(format, "parse_failed");
  }
}

export async function scanFile(file: LocalScanFile, options: FileScanOptions = {}): Promise<FileScanResult> {
  const extracted = await extractFileText(file);
  if (extracted.coverage === "none") {
    return {
      status: "unscannable",
      format: extracted.format,
      coverage: "none",
      findings: [],
      summary: extracted.summary,
    };
  }

  const scanned = scanPlainText(extracted.text, options, extracted.format);
  if (scanned.status === "unscannable") {
    return scanned;
  }

  const requiresReview = scanned.requiresReview === true;
  const partialCoverage = requiresReview || extracted.coverage === "partial";
  return {
    ...scanned,
    status: partialCoverage ? "partial" : scanned.status,
    coverage: partialCoverage ? "partial" : "complete",
    summary: resolveScanSummary(extracted, scanned.summary, requiresReview),
    ...(extracted.format === "pdf" ? { redactedText: undefined } : {}),
  };
}

function resolveScanSummary(
  extracted: ExtractedFileText,
  scannedSummary: FileScanSummary,
  requiresReview: boolean,
): FileScanSummary {
  if (extracted.format === "pdf" || !requiresReview) {
    return extracted.summary;
  }

  // 需复核的优先级更高，但不能吞掉提取阶段的未覆盖提示，
  // 否则用户不再被告知文件里还有未扫描的内嵌媒体或对象。
  const extractedReason = extracted.summary.reason;
  return extractedReason === undefined || extractedReason === scannedSummary.reason
    ? scannedSummary
    : { ...scannedSummary, secondaryReason: extractedReason };
}
