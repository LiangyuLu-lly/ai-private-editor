import { describe, expect, it } from "vitest";

import { SEMANTIC_MODEL_CORPUS } from "../src/shared/semantic-model-corpus.js";
import { SEMANTIC_REVIEW_CORPUS } from "./fixtures/semantic-review-corpus.js";
import { SEMANTIC_V2_CORPUS } from "./fixtures/semantic-v2-corpus.js";

const EVALUATION_CASES = [...SEMANTIC_REVIEW_CORPUS, ...SEMANTIC_V2_CORPUS];

function stripPunctuation(text: string): string {
  return text.replace(/[\s，。；、：！？,.;:!?]/gu, "");
}

/**
 * 统计模型只看实体两侧的上下文窗口，实体值本身被剔除。所以"评测值不出现在训练
 * 语料中"并不足以证明隔离——训练语料按设计本就不含实体值，那条检查恒成立。
 *
 * 真正的泄漏形态是：评测句去掉实体后剩下的上下文骨架与某条训练上下文逐字相同。
 * 此时模型是在复述见过的上下文，而不是泛化。
 */
function contextSkeleton(input: string, values: readonly string[]): string {
  let text = input;
  for (const value of values) {
    text = text.split(value).join("");
  }
  return stripPunctuation(text);
}

describe("local semantic training and evaluation separation", () => {
  it("keeps evaluation entity values out of the synthetic context training set", () => {
    // 这条目前恒成立，因为训练语料的姓名与地址位置留空。保留它是为了在有人
    // 把具体实体值写进训练上下文时立刻失败。
    const trainingContexts = SEMANTIC_MODEL_CORPUS.map((sample) => sample.context);
    const evaluationValues = EVALUATION_CASES.flatMap((testCase) =>
      testCase.expected.map((expected) => expected.value),
    );

    for (const value of evaluationValues) {
      expect(trainingContexts.some((context) => context.includes(value))).toBe(false);
    }
  });

  it("does not reuse an evaluation context skeleton as a training context", () => {
    const trainingContexts = new Set(
      SEMANTIC_MODEL_CORPUS.map((sample) => stripPunctuation(sample.context)),
    );

    for (const testCase of EVALUATION_CASES) {
      const skeleton = contextSkeleton(
        testCase.input,
        testCase.expected.map((expected) => expected.value),
      );
      expect(
        trainingContexts.has(skeleton),
        `evaluation case "${testCase.name}" reuses a training context verbatim: "${skeleton}"`,
      ).toBe(false);
    }
  });
});
