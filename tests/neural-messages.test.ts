import { describe, expect, it } from "vitest";

import {
  NEURAL_REVIEW_RESULT,
  isNeuralReviewResult,
} from "../src/shared/neural/messages.js";

type ExtendedHintCase = {
  kind: "phone" | "email" | "china_id" | "bank_card" | "license_plate" | "passport";
  text: string;
  start: number;
  end: number;
};

const EXTENDED_HINT_CASES: readonly ExtendedHintCase[] = [
  { kind: "phone", text: "电话 13800138000", start: 3, end: 14 },
  { kind: "email", text: "邮箱 demo@example.com", start: 3, end: 18 },
  { kind: "china_id", text: "身份证 11010519491231002X", start: 4, end: 22 },
  { kind: "bank_card", text: "银行卡 6222023700018945612", start: 4, end: 23 },
  { kind: "license_plate", text: "车牌 京A12345", start: 3, end: 9 },
  { kind: "passport", text: "护照 E12345678", start: 3, end: 12 },
];

describe("neural review message contract", () => {
  it.each(EXTENDED_HINT_CASES)("accepts the expanded $kind hint at the runtime boundary", ({ kind, text, start, end }) => {
    expect(isNeuralReviewResult(
      {
        type: NEURAL_REVIEW_RESULT,
        requestId: `test-${kind}`,
        ok: true,
        hints: [{ kind, start, end, score: 0.9, requiresConfirmation: true }],
        elapsedMs: 1,
      },
      text,
      `test-${kind}`,
    )).toBe(true);
  });

  it("continues rejecting unknown hint kinds", () => {
    const text = "未知值 demo";

    expect(isNeuralReviewResult(
      {
        type: NEURAL_REVIEW_RESULT,
        requestId: "test-unknown",
        ok: true,
        hints: [{ kind: "secret_value", start: 4, end: 8, score: 0.9, requiresConfirmation: true }],
        elapsedMs: 1,
      },
      text,
      "test-unknown",
    )).toBe(false);
  });

  it("rejects a well-formed ok result whose requestId does not match the outbound request", () => {
    const text = "周妍舒昨天说过这件事";
    const result = {
      type: NEURAL_REVIEW_RESULT,
      requestId: "outbound-a",
      ok: true as const,
      hints: [{ kind: "person_name" as const, start: 0, end: 3, score: 0.9, requiresConfirmation: true }],
      elapsedMs: 1,
    };

    expect(isNeuralReviewResult(result, text, "outbound-b")).toBe(false);
  });

  it("accepts a well-formed ok result whose requestId matches the outbound request", () => {
    const text = "周妍舒昨天说过这件事";
    const result = {
      type: NEURAL_REVIEW_RESULT,
      requestId: "outbound-a",
      ok: true as const,
      hints: [{ kind: "person_name" as const, start: 0, end: 3, score: 0.9, requiresConfirmation: true }],
      elapsedMs: 1,
    };

    expect(isNeuralReviewResult(result, text, "outbound-a")).toBe(true);
  });
});
