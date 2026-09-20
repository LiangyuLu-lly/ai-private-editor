import { describe, expect, it } from "vitest";

import {
  MAX_EXTRACTED_TEXT_BYTES,
  createRedactedTextBlob,
  scanPlainText,
} from "../src/scanner/scan.js";

describe("local text file scanner", () => {
  it("returns a safe text derivative without retaining raw values in its summary", async () => {
    const result = scanPlainText("手机号：13800138000\n项目：青岚项目", {
      customTerms: ["青岚项目"],
    });

    expect(result).toMatchObject({
      status: "sensitive",
      format: "text",
      coverage: "complete",
      findings: [
        { kind: "phone", count: 1 },
        { kind: "custom_term", count: 1 },
      ],
      redactedText: "手机号：[[PHONE_001]]\n项目：[[CUSTOM_001]]",
    });
    expect(JSON.stringify(result.summary)).not.toContain("13800138000");
    expect(JSON.stringify(result.summary)).not.toContain("青岚项目");

    const blob = createRedactedTextBlob(result.redactedText ?? "");
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("marks text larger than the local extraction budget as unscannable", () => {
    const result = scanPlainText("x".repeat(MAX_EXTRACTED_TEXT_BYTES + 1));

    expect(result).toEqual({
      status: "unscannable",
      format: "text",
      coverage: "none",
      findings: [],
      summary: { reason: "text_limit" },
    });
  });

  it("does not retain a clean source-text derivative after scanning", () => {
    expect(scanPlainText("这是不含敏感项的合成文本。")).toEqual({
      status: "clean",
      format: "text",
      coverage: "complete",
      findings: [],
      summary: {},
    });
  });

  it("does not create a derivative for a confirmation-only semantic candidate", () => {
    const result = scanPlainText("张三会跟进交付。", {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "person_name", start: 0, end: 2, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: "partial",
      findings: [{ kind: "person_name", count: 1 }],
      summary: { reason: "review_required" },
      requiresReview: true,
    });
    expect(result.redactedText).toBe("[[PERSON_001]]会跟进交付。");
  });
});
