import { analyzeDraft, getDetectionRanges } from "../shared/detector.js";
import type { FileScanFinding, FileScanOptions } from "./types.js";
import { assertExtensionLocalUrl, summarizeFindings } from "./types.js";

export type OcrWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

export type OcrRedactionRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LocalOcrResourceUrls = {
  workerPath: string;
  corePath: string;
  langPath: string;
};

type OcrWordSegment = OcrWord & { start: number; end: number };

export type OcrNormalization = {
  words: OcrWord[];
  truncated: boolean;
};

export type OcrMappingResult = {
  findings: readonly FileScanFinding[];
  rectangles: readonly OcrRedactionRectangle[];
  truncated: boolean;
  requiresReview: boolean;
};

export const MAX_OCR_WORDS = 10_000;
export const MAX_OCR_WORD_TEXT_LENGTH = 512;
export const MAX_OCR_REDACTION_RECTANGLES = 2_048;

function assertExtensionLocalResource(url: string): void {
  assertExtensionLocalUrl(url, "OCR resources must use chrome-extension URLs");
}

export function createLocalOcrResourceUrls(getUrl: (path: string) => string): LocalOcrResourceUrls {
  return {
    workerPath: getUrl("vendor/tesseract/worker.min.js"),
    corePath: getUrl("vendor/tesseract/tesseract-core-lstm.wasm.js"),
    langPath: getUrl("assets/tessdata"),
  };
}

function boundedNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeOcrWords(
  words: readonly OcrWord[],
  dimensions?: { width: number; height: number },
): OcrNormalization {
  const normalized: OcrWord[] = [];
  let truncated = false;

  for (const candidate of words) {
    if (normalized.length >= MAX_OCR_WORDS) {
      truncated = true;
      break;
    }
    if (candidate === null || typeof candidate !== "object") {
      truncated = true;
      continue;
    }
    const text = typeof candidate.text === "string" ? candidate.text.trim().replace(/\s+/gu, " ") : "";
    if (!text) {
      continue;
    }
    const clippedText = text.slice(0, MAX_OCR_WORD_TEXT_LENGTH);
    if (clippedText.length !== text.length) {
      truncated = true;
    }

    const rawBox = candidate.bbox;
    if (rawBox === null || typeof rawBox !== "object") {
      truncated = true;
      continue;
    }
    let x0 = boundedNumber(rawBox.x0, NaN);
    let y0 = boundedNumber(rawBox.y0, NaN);
    let x1 = boundedNumber(rawBox.x1, NaN);
    let y1 = boundedNumber(rawBox.y1, NaN);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
      truncated = true;
      continue;
    }
    if (dimensions !== undefined) {
      x0 = Math.max(0, Math.min(dimensions.width, x0));
      y0 = Math.max(0, Math.min(dimensions.height, y0));
      x1 = Math.max(0, Math.min(dimensions.width, x1));
      y1 = Math.max(0, Math.min(dimensions.height, y1));
      if (x1 <= x0 || y1 <= y0) {
        truncated = true;
        continue;
      }
    }
    const confidence = boundedNumber(candidate.confidence, 0);
    if (confidence < 0 || confidence > 100 || !Number.isFinite(candidate.confidence)) {
      truncated = true;
    }
    normalized.push({
      text: clippedText,
      confidence: Math.max(0, Math.min(100, confidence)),
      bbox: { x0, y0, x1, y1 },
    });
  }

  return { words: normalized, truncated };
}

export function classifyOcrCoverage(words: readonly OcrWord[], truncated = false): "complete" | "partial" {
  return !truncated && words.length > 0 && words.every((word) => word.confidence >= 55) ? "complete" : "partial";
}

function canJoinOcrWords(left: OcrWord, right: OcrWord): boolean {
  const leftHeight = left.bbox.y1 - left.bbox.y0;
  const rightHeight = right.bbox.y1 - right.bbox.y0;
  const referenceHeight = Math.max(leftHeight, rightHeight);
  const leftCenter = (left.bbox.y0 + left.bbox.y1) / 2;
  const rightCenter = (right.bbox.y0 + right.bbox.y1) / 2;
  const horizontalGap = right.bbox.x0 - left.bbox.x1;
  return Math.abs(leftCenter - rightCenter) <= referenceHeight * 0.75
    && horizontalGap >= -referenceHeight * 0.25
    && horizontalGap <= referenceHeight * 2;
}

function canCompactBoundary(left: OcrWord, right: OcrWord): boolean {
  const leftCharacter = left.text.at(-1) ?? "";
  const rightCharacter = right.text[0] ?? "";
  const bothCjk = /[\u3400-\u9fff]/u.test(leftCharacter) && /[\u3400-\u9fff]/u.test(rightCharacter);
  const bothIdentifierCharacters = /[A-Za-z0-9@._:+\-/]/u.test(leftCharacter)
    && /[A-Za-z0-9@._:+\-/]/u.test(rightCharacter);
  return (bothCjk || bothIdentifierCharacters)
    && canJoinOcrWords(left, right);
}

function joinWords(words: readonly OcrWord[]): {
  text: string;
  segments: OcrWordSegment[];
  compactText: string;
  compactToPrimary: number[];
} {
  let text = "";
  const segments: OcrWordSegment[] = [];
  const compactCharacters: string[] = [];
  const compactToPrimary: number[] = [];

  for (const word of words) {
    const trimmed = word.text.trim();
    if (!trimmed) {
      continue;
    }
    if (text.length > 0) {
      const previous = segments.at(-1);
      const joinsPrevious = previous !== undefined && canCompactBoundary(previous, { ...word, text: trimmed });
      const remainsOnSameVisualRow = previous !== undefined && canJoinOcrWords(previous, { ...word, text: trimmed });
      text += remainsOnSameVisualRow ? " " : "\n";
      if (!joinsPrevious) {
        compactCharacters.push(text.at(-1) ?? " ");
        compactToPrimary.push(text.length - 1);
      }
    }
    const start = text.length;
    text += trimmed;
    const segment = { ...word, text: trimmed, start, end: text.length };
    segments.push(segment);
    for (let characterIndex = 0; characterIndex < trimmed.length; characterIndex += 1) {
      compactCharacters.push(trimmed[characterIndex] ?? "");
      compactToPrimary.push(start + characterIndex);
    }
  }

  return { text, segments, compactText: compactCharacters.join(""), compactToPrimary };
}

function rectangleFor(segments: readonly OcrWordSegment[], start: number, end: number): OcrRedactionRectangle | null {
  const matching = segments.filter((segment) => start < segment.end && segment.start < end);
  if (matching.length === 0) {
    return null;
  }

  const x0 = Math.min(...matching.map((word) => word.bbox.x0));
  const y0 = Math.min(...matching.map((word) => word.bbox.y0));
  const x1 = Math.max(...matching.map((word) => word.bbox.x1));
  const y1 = Math.max(...matching.map((word) => word.bbox.y1));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function mapOcrWordsToSensitiveRanges(
  words: readonly OcrWord[],
  options: FileScanOptions = {},
): OcrMappingResult {
  const normalization = normalizeOcrWords(words);
  const { text, segments, compactText, compactToPrimary } = joinWords(normalization.words);
  const detectionOptions = {
    detectionProfile: options.detectionProfile ?? "conservative",
    replacementStyle: options.replacementStyle ?? "token",
    semanticReviewProvider: options.semanticReviewProvider,
  } as const;
  const detectionArgs = [
    options.customTerms ?? [],
    options.allowlistedTerms ?? [],
    options.categoryPolicies ?? [],
    detectionOptions,
  ] as const;
  const primaryRanges = getDetectionRanges(text, ...detectionArgs);
  const requiresReview = [text, compactText]
    .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index)
    .some((candidate) => analyzeDraft(
      candidate,
      options.customTerms ?? [],
      options.allowlistedTerms ?? [],
      options.categoryPolicies ?? [],
      detectionOptions,
    ).findings.some((finding) => finding.policy === "confirm"));
  const compactRanges = compactText === text ? [] : getDetectionRanges(compactText, ...detectionArgs).flatMap((range) => {
    const start = compactToPrimary[range.start];
    const last = compactToPrimary[range.end - 1];
    if (start === undefined || last === undefined) {
      return [];
    }
    return [{ ...range, start, end: last + 1 }];
  });
  const supplementalRanges = compactRanges.filter((range) =>
    !primaryRanges.some((primary) => primary.kind === range.kind && primary.start < range.end && range.start < primary.end),
  );
  const ranges = [...primaryRanges, ...supplementalRanges].filter((range, index, all) =>
    all.findIndex((candidate) => candidate.kind === range.kind && candidate.start < range.end && range.start < candidate.end) === index,
  );
  const findings = summarizeFindings(
    ranges.reduce<{ kind: FileScanFinding["kind"]; count: number }[]>((accumulator, range) => {
      const current = accumulator.find((finding) => finding.kind === range.kind);
      if (current === undefined) {
        accumulator.push({ kind: range.kind, count: 1 });
      } else {
        current.count += 1;
      }
      return accumulator;
    }, []).map((finding) => ({ ...finding, decision: "replace" as const })),
  );
  const rectangles = ranges
    .map((range) => rectangleFor(segments, range.start, range.end))
    .filter((rectangle): rectangle is OcrRedactionRectangle => rectangle !== null);

  const truncated = normalization.truncated || rectangles.length > MAX_OCR_REDACTION_RECTANGLES;
  return {
    findings,
    rectangles: rectangles.slice(0, MAX_OCR_REDACTION_RECTANGLES),
    truncated,
    requiresReview,
  };
}

export type LocalOcrEngine = {
  recognize(image: Blob): Promise<readonly OcrWord[]>;
  terminate(): Promise<void>;
};

export async function createLocalOcrEngine(resources: LocalOcrResourceUrls): Promise<LocalOcrEngine> {
  assertExtensionLocalResource(resources.workerPath);
  assertExtensionLocalResource(resources.corePath);
  assertExtensionLocalResource(resources.langPath);
  const Tesseract = await import("tesseract.js");
  const worker = await Tesseract.createWorker("chi_sim+eng", 1, {
    workerPath: resources.workerPath,
    corePath: resources.corePath,
    langPath: resources.langPath,
    gzip: false,
    cacheMethod: "none",
    workerBlobURL: false,
  });

  return {
    async recognize(image): Promise<readonly OcrWord[]> {
      const result = await worker.recognize(image, {}, { blocks: true });
      const blockWords = result.data.blocks?.flatMap((block) =>
        block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
      ) ?? [];
      const words = blockWords.length > 0
        ? blockWords
        : ((result.data as unknown as { words?: Tesseract.Word[] }).words ?? []);
      return words.map((word) => ({ text: word.text, confidence: word.confidence, bbox: word.bbox }));
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}
