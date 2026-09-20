import { describe, expect, it } from "vitest";

import { analyzeDraft } from "../src/shared/detector.js";
import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";

describe("local semantic review performance", () => {
  it("keeps a large synthetic repeated draft below the interaction latency guardrail", () => {
    const input = "客户张三会跟进。".repeat(10_000);
    const started = performance.now();
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: createLocalStatisticalSemanticProvider(),
    });
    const elapsed = performance.now() - started;

    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "person_name", count: 10_000, policy: "confirm" }),
    ]);
    expect(elapsed).toBeLessThan(1_500);
  });

  // conservative 是默认档，而它现在也走语义候选，所以延迟护栏必须单独覆盖它。
  // 这一档不接 provider，走的是 appendContextCandidates。
  it("keeps the default conservative profile below the same guardrail", () => {
    const input = "客户张三会跟进，地址是上海市浦东新区世纪大道88号。".repeat(5_000);
    const started = performance.now();
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "conservative" });
    const elapsed = performance.now() - started;

    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "person_name", count: 5_000 }),
      expect.objectContaining({ kind: "address", count: 5_000 }),
    ]);
    expect(elapsed).toBeLessThan(1_500);
  });
});
