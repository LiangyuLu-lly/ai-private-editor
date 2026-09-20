import { describe, expect, it } from "vitest";

import { assertZeroGoldSpanDeletions } from "../scripts/measure-rules-six-set.mjs";

describe("measure-rules-six-set gate", () => {
  it("fails the gate when a selection-set gold span is missing from predictions", () => {
    // Given: one gold entity on a selection-set document
    const gold = [
      {
        id: "sel-1",
        text: "call 13800138000",
        entities: [{ start: 5, end: 16, label: "CN_PHONE", text: "13800138000" }],
      },
    ];
    const missing = [{ id: "sel-1", text: "call 13800138000", entities: [] }];
    const disjoint = [
      {
        id: "sel-1",
        text: "call 13800138000",
        entities: [{ start: 0, end: 4, label: "PERSON", text: "call" }],
      },
    ];
    const exact = [
      {
        id: "sel-1",
        text: "call 13800138000",
        entities: [{ start: 5, end: 16, label: "CN_PHONE", text: "13800138000" }],
      },
    ];

    // When / Then: no overlap (empty or disjoint) fails the gate
    expect(() => assertZeroGoldSpanDeletions(gold, missing)).toThrow(/gold span/);
    expect(() => assertZeroGoldSpanDeletions(gold, disjoint)).toThrow(/gold span/);

    // When / Then: exact overlap passes
    expect(() => assertZeroGoldSpanDeletions(gold, exact)).not.toThrow();
  });
});
