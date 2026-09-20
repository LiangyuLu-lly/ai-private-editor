import { describe, expect, it } from "vitest";

import { analyzeDraft } from "../src/shared/detector.js";
import {
  DEFAULT_ADVANCED_SETTINGS,
  FEWER_PROMPTS_SETTINGS,
} from "../src/shared/custom-terms.js";
import {
  combineSemanticProviders,
  createCachedNeuralProvider,
  createNeuralHintCache,
} from "../src/shared/neural/hint-cache.js";
import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";

/*
 * 钉住出货默认值，以及"默认值确实让模型生效"这条性质。
 *
 * 之前的默认是 conservative + 语义审查关闭，两者叠加的效果是：随包分发的 12 MB 模型对不改设置的
 * 用户完全不生效。那不是一个保守的默认，是一个产品缺陷——盲测集上 81.2% 的含敏感信息消息会原样
 * 发出去。改成 balanced + local_neural 之后，这里断言的不只是两个字符串，还有"提示真的能变成候选"，
 * 因为只改其中一个开关是没有效果的：`appendSemanticCandidates` 在 conservative 档整条早返回。
 *
 * 这两条断言里任何一条挂掉，都意味着默认配置又变回了模型不生效的状态。
 */

const UNANCHORED = "周妍舒昨天说过这件事";

describe("shipped defaults", () => {
  it("enables the local model, which needs both switches", () => {
    expect(DEFAULT_ADVANCED_SETTINGS.detectionProfile).toBe("balanced");
    expect(DEFAULT_ADVANCED_SETTINGS.semanticReview).toBe("local_neural");
  });

  it("turns a model hint into a finding under the default profile", () => {
    // The property that matters. `detectionProfile: "balanced"` alone would not be enough, and
    // neither would `semanticReview` alone; this asserts the pair actually reaches the detector.
    const cache = createNeuralHintCache(4);
    cache.put(UNANCHORED, [
      { kind: "person_name", start: 0, end: 3, score: 0.9, requiresConfirmation: true },
    ]);
    const provider = combineSemanticProviders(
      createLocalStatisticalSemanticProvider(),
      createCachedNeuralProvider(cache),
    );

    const withDefaults = analyzeDraft(UNANCHORED, [], [], [], {
      detectionProfile: DEFAULT_ADVANCED_SETTINGS.detectionProfile,
      semanticReviewProvider: provider,
    });
    expect(withDefaults.findings.map((finding) => finding.kind)).toContain("person_name");
    // Every model-derived candidate asks rather than rewrites. This is what makes defaulting the
    // model on safe: the worst case is one extra confirmation, never a wrong edit.
    expect(withDefaults.findings.every((finding) => finding.policy === "confirm")).toBe(true);
  });

  it("keeps a rule-only path available, and that is what the fewer-prompts choice selects", () => {
    const cache = createNeuralHintCache(4);
    cache.put(UNANCHORED, [
      { kind: "person_name", start: 0, end: 3, score: 0.9, requiresConfirmation: true },
    ]);
    const provider = combineSemanticProviders(
      createLocalStatisticalSemanticProvider(),
      createCachedNeuralProvider(cache),
    );

    expect(FEWER_PROMPTS_SETTINGS.detectionProfile).toBe("conservative");
    expect(FEWER_PROMPTS_SETTINGS.semanticReview).toBe("off");
    // Documents the cost of that choice rather than merely the setting: in this profile the hint is
    // discarded and the unanchored name is not detected at all.
    const fewerPrompts = analyzeDraft(UNANCHORED, [], [], [], {
      detectionProfile: FEWER_PROMPTS_SETTINGS.detectionProfile,
      semanticReviewProvider: provider,
    });
    expect(fewerPrompts.findings).toEqual([]);
  });
});
