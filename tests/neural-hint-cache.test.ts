import { describe, expect, it } from "vitest";

import { analyzeDraft } from "../src/shared/detector.js";
import {
  combineSemanticProviders,
  createCachedNeuralProvider,
  createNeuralHintCache,
} from "../src/shared/neural/hint-cache.js";
import { createLocalStatisticalSemanticProvider, type SemanticHint } from "../src/shared/semantic-review.js";

function hint(start: number, end: number, kind: SemanticHint["kind"] = "person_name"): SemanticHint {
  return { kind, start, end, score: 0.9, requiresConfirmation: true };
}

describe("neural hint cache", () => {
  it("returns hints only for the exact draft they were computed from", () => {
    const cache = createNeuralHintCache();
    cache.put("客户王川梓会跟进", [hint(2, 5)]);

    expect(cache.get("客户王川梓会跟进")).toEqual([hint(2, 5)]);
    // One character different means every offset after the edit is wrong, so this must miss.
    expect(cache.get("客户王川梓会跟进。")).toBeUndefined();
    expect(cache.get("客户王川梓")).toBeUndefined();
  });

  it("evicts the oldest entry past the bound", () => {
    const cache = createNeuralHintCache(2);
    cache.put("a", [hint(0, 1)]);
    cache.put("b", [hint(0, 1)]);
    cache.put("c", [hint(0, 1)]);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("refreshes an entry's position when it is written again", () => {
    const cache = createNeuralHintCache(2);
    cache.put("a", [hint(0, 1)]);
    cache.put("b", [hint(0, 1)]);
    cache.put("a", [hint(0, 2)]);
    cache.put("c", [hint(0, 1)]);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual([hint(0, 2)]);
  });

  it("bounds total key size for very long drafts", () => {
    const cache = createNeuralHintCache(8, 100);
    cache.put("x".repeat(80), [hint(0, 1)]);
    cache.put("y".repeat(80), [hint(0, 1)]);

    expect(cache.size).toBe(1);
    expect(cache.get("y".repeat(80))).toBeDefined();
  });

  it("does not mutate stored hints when the caller mutates its array", () => {
    const cache = createNeuralHintCache();
    const hints = [hint(2, 5)];
    cache.put("客户王川梓会跟进", hints);
    hints.push(hint(6, 8));

    expect(cache.get("客户王川梓会跟进")).toHaveLength(1);
  });
});

describe("cached provider on the synchronous send path", () => {
  it("returns nothing for an unreviewed draft, so the rule engine decides alone", () => {
    const provider = createCachedNeuralProvider(createNeuralHintCache());

    expect(provider.review("客户王川梓会跟进")).toEqual([]);
  });

  // This is the bucket the rule engine provably cannot reach: a common surname plus a
  // two-character given name, no anchor word before it and no role word after it. Verified
  // against the shipped detector rather than assumed — `客户王川梓` would have been a bad
  // example because `客户` is itself a person anchor.
  const UNANCHORED = "周妍舒昨天说过这件事";

  it("feeds cached hints into the detector as confirmation candidates", () => {
    const cache = createNeuralHintCache();
    cache.put(UNANCHORED, [hint(0, 3)]);

    const withoutModel = analyzeDraft(UNANCHORED, [], [], [], { detectionProfile: "conservative" });
    const withModel = analyzeDraft(UNANCHORED, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: createCachedNeuralProvider(cache),
    });

    expect(withoutModel.findings).toEqual([]);
    expect(withModel.findings).toEqual([
      expect.objectContaining({ kind: "person_name", count: 1, policy: "confirm" }),
    ]);
    expect(withModel.redactedText).toBe("[[PERSON_001]]昨天说过这件事");
  });

  it("falls back to rule-only behaviour when the draft changed after review", () => {
    const cache = createNeuralHintCache();
    cache.put(UNANCHORED, [hint(0, 3)]);

    // The user typed one more character after the model ran. Applying the stale span would
    // mask the wrong characters, so the miss must be silent and total.
    const analysis = analyzeDraft(`${UNANCHORED}。`, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: createCachedNeuralProvider(cache),
    });

    expect(analysis.findings).toEqual([]);
  });
});

describe("combining the rule provider with the neural provider", () => {
  it("keeps hints from both and never drops a rule hint", () => {
    const text = "包裹放到北京市朝阳区望京街10号前台，客户王川梓会跟进";
    const cache = createNeuralHintCache();
    const ruleProvider = createLocalStatisticalSemanticProvider();
    const ruleHints = ruleProvider.review(text);
    expect(ruleHints.length).toBeGreaterThan(0);

    const personStart = text.indexOf("王川梓");
    cache.put(text, [hint(personStart, personStart + 3)]);
    const combined = combineSemanticProviders(ruleProvider, createCachedNeuralProvider(cache));
    const hints = combined.review(text);

    for (const ruleHint of ruleHints) {
      expect(hints).toContainEqual(ruleHint);
    }
    expect(hints.some((item) => item.start === personStart && item.end === personStart + 3)).toBe(true);
  });

  it("deduplicates a span both providers found", () => {
    const cache = createNeuralHintCache();
    cache.put("x", [hint(0, 1)]);
    const stub = { review: () => [hint(0, 1)] };

    expect(combineSemanticProviders(stub, createCachedNeuralProvider(cache)).review("x")).toHaveLength(1);
  });

  it("returns hints sorted by position", () => {
    const cache = createNeuralHintCache();
    cache.put("x", [hint(10, 12)]);
    const stub = { review: () => [hint(3, 5), hint(20, 22)] };

    expect(
      combineSemanticProviders(stub, createCachedNeuralProvider(cache)).review("x").map((item) => item.start),
    ).toEqual([3, 10, 20]);
  });
});
