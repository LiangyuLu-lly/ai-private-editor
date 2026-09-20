import { detectFileFormat } from "./extractors.js";
import {
  isUprightForRedaction,
  readImageDimensions,
  renderRedactedPng,
  type ImageDimensions,
} from "./image-redaction.js";
import {
  classifyOcrCoverage,
  mapOcrWordsToSensitiveRanges,
  normalizeOcrWords,
  type LocalOcrEngine,
  type OcrRedactionRectangle,
} from "./ocr.js";
import { MAX_FILE_BYTES } from "./scan.js";
import type {
  FileScanOptions,
  FileScanReason,
  FileScanResult,
  LocalImageFile,
} from "./types.js";

export const MAX_IMAGE_PIXELS = 12_000_000;
export const MAX_IMAGE_DIMENSION = 16_384;

export type ImageScanResult = Omit<FileScanResult, "format" | "redactedText"> & {
  format: "image";
  dimensions?: ImageDimensions;
  rectangles: readonly OcrRedactionRectangle[];
  redactedImage?: Blob;
};

export type ImageRenderer = (
  source: Blob,
  rectangles: readonly OcrRedactionRectangle[],
  dimensions: ImageDimensions,
) => Promise<Blob>;

function unscannable(reason: "file_limit" | "image_limit" | "parse_failed"): ImageScanResult {
  return {
    status: "unscannable",
    format: "image",
    coverage: "none",
    findings: [],
    summary: { reason },
    rectangles: [],
  };
}

export async function scanImage(
  file: LocalImageFile,
  engine: LocalOcrEngine,
  options: FileScanOptions = {},
  render: ImageRenderer = renderRedactedPng,
): Promise<ImageScanResult> {
  if (detectFileFormat(file) !== "image") {
    return unscannable("parse_failed");
  }
  if (file.size > MAX_FILE_BYTES) {
    return unscannable("file_limit");
  }

  const buffer = await file.arrayBuffer();
  const dimensions = readImageDimensions(buffer);
  if (dimensions === null) {
    return unscannable("parse_failed");
  }
  const upright = isUprightForRedaction(buffer);
  if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width > MAX_IMAGE_PIXELS / dimensions.height) {
    return unscannable("image_limit");
  }

  try {
    const words = await engine.recognize(file.blob);
    const normalization = normalizeOcrWords(words, dimensions);
    const mapping = mapOcrWordsToSensitiveRanges(normalization.words, options);
    const { findings, rectangles } = mapping;
    const truncated = normalization.truncated || mapping.truncated;
    const coverage = classifyOcrCoverage(normalization.words, truncated);
    const sensitive = findings.some((finding) => finding.count > 0);
    const requiresReview = mapping.requiresReview;

    // 渲染失败必须与解析失败分开处理。OCR 此时已经识别出敏感内容，若把整个结果
    // 降级为 unscannable，用户就失去了"这张图里有敏感信息"这条最重要的信息。
    // 因此保留 findings，仅不产出处理副本，并明确告知副本不可用。
    let redactedImage: Blob | undefined;
    let redactionFailed = false;
    if (!requiresReview && sensitive && rectangles.length > 0) {
      if (upright && !truncated) {
        try {
          redactedImage = await render(file.blob, rectangles, dimensions);
        } catch {
          redactionFailed = true;
        }
      } else {
        // 两种情况都不能出副本，否则用户会拿到一张看似"已处理完"的图：
        // 1. 非正立 EXIF 方向——浏览器解码必定应用该方向，而词框处于文件头声明的
        //    未定向坐标系，遮挡一定错位；方向 2/3/4 连宽高都不变，尺寸校验也拦不住。
        // 2. 识别结果被截断——副本只会遮住前一部分词框，剩余敏感内容仍然可见。
        redactionFailed = true;
      }
    }

    const reason: FileScanReason | undefined = requiresReview
      ? "review_required"
      : redactionFailed
        ? "redaction_unavailable"
        : coverage === "partial"
          ? "ocr_low_confidence"
          : undefined;

    return {
      status: requiresReview || redactionFailed || coverage === "partial"
        ? "partial"
        : sensitive
          ? "sensitive"
          : "clean",
      format: "image",
      coverage: requiresReview || redactionFailed ? "partial" : coverage,
      findings,
      summary: reason === undefined ? {} : { reason },
      ...(requiresReview ? { requiresReview: true } : {}),
      dimensions,
      rectangles,
      ...(redactedImage === undefined ? {} : { redactedImage }),
    };
  } catch {
    return unscannable("parse_failed");
  }
}
