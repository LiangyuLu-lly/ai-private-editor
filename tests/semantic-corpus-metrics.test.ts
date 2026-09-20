import { describe, expect, it } from "vitest";

import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";
import { SEMANTIC_REVIEW_CORPUS } from "./fixtures/semantic-review-corpus.js";
import { SEMANTIC_V2_CORPUS } from "./fixtures/semantic-v2-corpus.js";

describe("frozen local semantic review corpus", () => {
  it("keeps every high-signal positive and negative case within the confirmation-only boundary", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const missed: string[] = [];
    const unexpected: string[] = [];

    for (const testCase of [...SEMANTIC_REVIEW_CORPUS, ...SEMANTIC_V2_CORPUS]) {
      const hints = provider.review(testCase.input);
      const actual = hints.map((hint) => ({
        kind: hint.kind,
        value: testCase.input.slice(hint.start, hint.end),
      }));
      for (const expected of testCase.expected) {
        if (!actual.some((candidate) => candidate.kind === expected.kind && candidate.value === expected.value)) {
          missed.push(`${testCase.name}: ${expected.kind}`);
        }
      }
      if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
        unexpected.push(`${testCase.name}: ${JSON.stringify(actual)}`);
      }
      for (const hint of hints) {
        if (hint.requiresConfirmation !== true || !Number.isFinite(hint.score)) {
          unexpected.push(`${testCase.name}: unsafe hint contract`);
        }
      }
    }

    expect(missed, `semantic misses:\n${missed.join("\n")}`).toEqual([]);
    expect(unexpected, `semantic false positives:\n${unexpected.join("\n")}`).toEqual([]);
  });
});
