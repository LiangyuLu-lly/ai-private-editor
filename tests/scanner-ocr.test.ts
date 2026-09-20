import { describe, expect, it } from "vitest";

import {
  classifyOcrCoverage,
  createLocalOcrEngine,
  createLocalOcrResourceUrls,
  mapOcrWordsToSensitiveRanges,
} from "../src/scanner/ocr.js";
import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";

describe("local image OCR mapping", () => {
  it("maps a recognized synthetic phone span to OCR word boxes", () => {
    const result = mapOcrWordsToSensitiveRanges([
      { text: "电话", confidence: 96, bbox: { x0: 8, y0: 8, x1: 42, y1: 28 } },
      { text: "13800138000", confidence: 94, bbox: { x0: 48, y0: 8, x1: 186, y1: 28 } },
    ]);

    expect(result.findings).toEqual([{ kind: "phone", count: 1 }]);
    expect(result.rectangles).toEqual([{ x: 48, y: 8, width: 138, height: 20 }]);
  });

  it("joins OCR word fragments when an email is split around punctuation", () => {
    const result = mapOcrWordsToSensitiveRanges([
      { text: "邮箱", confidence: 96, bbox: { x0: 8, y0: 8, x1: 42, y1: 28 } },
      { text: "demo", confidence: 96, bbox: { x0: 48, y0: 8, x1: 82, y1: 28 } },
      { text: "@example.com", confidence: 96, bbox: { x0: 86, y0: 8, x1: 190, y1: 28 } },
    ]);

    expect(result.findings).toEqual([{ kind: "email", count: 1 }]);
    expect(result.rectangles).toEqual([{ x: 48, y: 8, width: 142, height: 20 }]);
    expect(result.truncated).toBe(false);
  });

  it("does not double-count a phone detected in both spaced and compact OCR text", () => {
    const result = mapOcrWordsToSensitiveRanges([
      { text: "138", confidence: 96, bbox: { x0: 8, y0: 8, x1: 42, y1: 28 } },
      { text: "0013", confidence: 96, bbox: { x0: 48, y0: 8, x1: 90, y1: 28 } },
      { text: "8000", confidence: 96, bbox: { x0: 96, y0: 8, x1: 140, y1: 28 } },
    ]);

    expect(result.findings).toEqual([{ kind: "phone", count: 1 }]);
    expect(result.rectangles).toHaveLength(1);
  });

  it("does not stitch digits from different visual rows into a phone number", () => {
    const result = mapOcrWordsToSensitiveRanges([
      { text: "138", confidence: 96, bbox: { x0: 8, y0: 8, x1: 42, y1: 28 } },
      { text: "00138000", confidence: 96, bbox: { x0: 48, y0: 70, x1: 130, y1: 90 } },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.rectangles).toEqual([]);
  });

  it("preserves review-required Chinese semantic detection when OCR splits each character", () => {
    const result = mapOcrWordsToSensitiveRanges([
      { text: "客", confidence: 96, bbox: { x0: 8, y0: 8, x1: 28, y1: 28 } },
      { text: "户", confidence: 96, bbox: { x0: 30, y0: 8, x1: 50, y1: 28 } },
      { text: "王", confidence: 96, bbox: { x0: 52, y0: 8, x1: 72, y1: 28 } },
      { text: "小", confidence: 96, bbox: { x0: 74, y0: 8, x1: 94, y1: 28 } },
      { text: "明", confidence: 96, bbox: { x0: 96, y0: 8, x1: 116, y1: 28 } },
      { text: "会", confidence: 96, bbox: { x0: 118, y0: 8, x1: 138, y1: 28 } },
      { text: "跟进", confidence: 96, bbox: { x0: 140, y0: 8, x1: 182, y1: 28 } },
    ], {
      detectionProfile: "balanced",
      semanticReviewProvider: createLocalStatisticalSemanticProvider(),
    });

    expect(result.findings).toEqual([{ kind: "person_name", count: 1 }]);
    expect(result.requiresReview).toBe(true);
    expect(result.rectangles).toEqual([{ x: 52, y: 8, width: 64, height: 20 }]);
  });

  it("fails closed when OCR returns malformed or unbounded word data", () => {
    const result = mapOcrWordsToSensitiveRanges([
      { text: "13800138000", confidence: 96, bbox: { x0: 20, y0: 10, x1: 180, y1: 30 } },
      { text: "bad", confidence: Number.NaN, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } },
    ]);

    expect(result.findings).toEqual([{ kind: "phone", count: 1 }]);
    expect(result.truncated).toBe(true);
  });

  it("marks low-confidence OCR as partial rather than clean", () => {
    expect(classifyOcrCoverage([{ text: "13800138000", confidence: 22, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }])).toBe("partial");
  });

  it("uses only extension-local OCR resource URLs", () => {
    const urls = createLocalOcrResourceUrls((path) => `chrome-extension://test/${path}`);

    expect(urls).toEqual({
      workerPath: "chrome-extension://test/vendor/tesseract/worker.min.js",
      corePath: "chrome-extension://test/vendor/tesseract/tesseract-core-lstm.wasm.js",
      langPath: "chrome-extension://test/assets/tessdata",
    });
    expect(JSON.stringify(urls)).not.toContain("https://");
  });

  it("rejects a non-extension resource before OCR can initialize", async () => {
    await expect(createLocalOcrEngine({
      workerPath: "https://example.test/worker.js",
      corePath: "https://example.test/core.js",
      langPath: "https://example.test/lang",
    })).rejects.toThrow("chrome-extension URLs");
    await expect(createLocalOcrEngine({
      workerPath: "chrome-extension://trusted@evil/worker.js",
      corePath: "chrome-extension://test/core.js",
      langPath: "chrome-extension://test/lang",
    })).rejects.toThrow("chrome-extension URLs");
  });
});
