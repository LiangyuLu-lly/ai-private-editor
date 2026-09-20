import { describe, expect, it } from "vitest";

import { getDetectionRanges } from "../src/shared/detector.js";
import {
  buildHighlightRanges,
  createHighlightOverlayFactory,
} from "../src/shared/highlight-ranges.js";

const SECRET_PHONE = "13800138000";

function assertNoMatchedSubstring(value: unknown, matched: string): void {
  expect(JSON.stringify(value)).not.toContain(matched);
}

describe("highlight ranges", () => {
  it("returns kind ranges without ever including the matched substring", () => {
    const text = `请联系 ${SECRET_PHONE}。`;
    const start = text.indexOf(SECRET_PHONE);
    const end = start + SECRET_PHONE.length;
    const detected = getDetectionRanges(text, [], [], []);
    expect(detected.some((range) => range.start === start && range.end === end)).toBe(true);

    const dirty = [
      {
        kind: "phone" as const,
        start,
        end,
        value: SECRET_PHONE,
        text: SECRET_PHONE,
        raw: SECRET_PHONE,
      },
      ...detected,
    ];

    const highlights = buildHighlightRanges(text, dirty);

    expect(highlights).toEqual([{ kind: "phone", start, end }]);
    for (const descriptor of highlights) {
      expect(Object.keys(descriptor).sort()).toEqual(["end", "kind", "start"]);
      expect("value" in descriptor).toBe(false);
      expect("text" in descriptor).toBe(false);
      expect("raw" in descriptor).toBe(false);
      assertNoMatchedSubstring(descriptor, SECRET_PHONE);
    }

    const overlay = createHighlightOverlayFactory(document).create(highlights);
    expect(overlay.style.pointerEvents).toBe("none");
    expect(overlay.textContent).toBe("");
    expect(overlay.outerHTML).not.toContain(SECRET_PHONE);
    for (const node of overlay.querySelectorAll("[data-kind]")) {
      expect(node).toBeInstanceOf(HTMLElement);
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      expect(node.getAttribute("data-kind")).toBe("phone");
      expect(node.textContent).toBe("");
      expect(node.style.pointerEvents).toBe("none");
      expect(node.outerHTML).not.toContain(SECRET_PHONE);
      for (const attribute of Array.from(node.attributes)) {
        expect(attribute.value).not.toContain(SECRET_PHONE);
      }
    }
  });

  it("merges overlapping ranges deterministically", () => {
    const text = "0123456789ABCDEF";
    const overlapping = [
      { kind: "email" as const, start: 4, end: 12 },
      { kind: "phone" as const, start: 0, end: 8 },
    ];
    const nested = [
      { kind: "phone" as const, start: 0, end: 10 },
      { kind: "api_key" as const, start: 2, end: 5 },
    ];
    const sameKind = [
      { kind: "phone" as const, start: 1, end: 6 },
      { kind: "phone" as const, start: 4, end: 9 },
    ];
    const overlappingCover = [
      { kind: "phone", start: 0, end: 8 },
      { kind: "email", start: 8, end: 12 },
    ];
    const nestedCover = [
      { kind: "phone", start: 0, end: 2 },
      { kind: "api_key", start: 2, end: 5 },
      { kind: "phone", start: 5, end: 10 },
    ];

    expect(buildHighlightRanges(text, overlapping)).toEqual(overlappingCover);
    expect(buildHighlightRanges(text, [...overlapping].reverse())).toEqual(overlappingCover);
    expect(buildHighlightRanges(text, nested)).toEqual(nestedCover);
    expect(buildHighlightRanges(text, [...nested].reverse())).toEqual(nestedCover);
    expect(buildHighlightRanges(text, sameKind)).toEqual([{ kind: "phone", start: 1, end: 9 }]);
    expect(buildHighlightRanges(text, [...sameKind].reverse())).toEqual([
      { kind: "phone", start: 1, end: 9 },
    ]);
  });

  it("treats out-of-range and zero-length inputs as skipped", () => {
    const text = "0123456789";
    const kept = { kind: "phone" as const, start: 2, end: 5 };
    const skipped = [
      { kind: "phone" as const, start: 3, end: 3 },
      { kind: "email" as const, start: 8, end: 2 },
      { kind: "phone" as const, start: -1, end: 3 },
      { kind: "email" as const, start: 8, end: 20 },
      { kind: "phone" as const, start: 10, end: 12 },
      { kind: "api_key" as const, start: Number.NaN, end: 4 },
      { kind: "phone" as const, start: 0, end: Number.POSITIVE_INFINITY },
    ];

    expect(buildHighlightRanges(text, [kept, ...skipped])).toEqual([
      { kind: "phone", start: 2, end: 5 },
    ]);
    expect(buildHighlightRanges(text, skipped)).toEqual([]);
  });
});
