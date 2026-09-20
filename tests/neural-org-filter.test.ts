import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isNonPersonOrganisation } from "../src/shared/neural/review.js";
import { COMMON_ORGANIZATION_OR_PLACE_NAMES } from "../src/shared/semantic-lexicon.js";

type Fixture = {
  names: string[];
  cases: { value: string; rejected: boolean; note: string }[];
};

const fixture: Fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "neural-org-filter-fixtures.json"), "utf8"),
);

describe("neural organisation filter", () => {
  it("matches hybrid.py on every generated case", () => {
    for (const { value, rejected, note } of fixture.cases) {
      expect(isNonPersonOrganisation(value), `${JSON.stringify(value)} — ${note}`).toBe(rejected);
    }
  });

  it("carries exactly the Python set, so a change on either side fails here", () => {
    // Guards against the drift the fixture exists to catch: someone adds a name to hybrid.py and
    // regenerates the fixture, but the TypeScript set is never updated.
    for (const name of fixture.names) {
      expect(isNonPersonOrganisation(name), `${name} is in hybrid.py but not in review.ts`).toBe(true);
    }
    const rejectedByFixture = fixture.cases.filter((entry) => entry.rejected).map((entry) => entry.value);
    expect([...rejectedByFixture].sort()).toEqual([...fixture.names].sort());
  });

    it("uses exact match, not substring", () => {
    // `华为民` is a plausible given name. A `startsWith`/`includes` implementation would delete it,
    // and deleting a real name is a leak rather than a cosmetic error.
    for (const value of ["华为民", "小米兰", "阿里木", "百度成", "王府井东街", "黄鹤楼路", "天安门东"]) {
      expect(isNonPersonOrganisation(value)).toBe(false);
    }
  });

  it("suppresses 黄鹤楼 and 天安门 when the span is an exact landmark match", () => {
    // Given: the R9 validation diagnostic's only safe gazetteer wideners (landmark-shaped, 0 gold).
    // When: the filter sees the full span.
    // Then: both are rejected as non-person, same as 王府井 / 中关村.
    expect(isNonPersonOrganisation("黄鹤楼")).toBe(true);
    expect(isNonPersonOrganisation("天安门")).toBe(true);
  });

  it("keeps 黄鹤楼路 and a real name that only contains those characters", () => {
    // Given: exact-match discipline. 黄鹤楼路 is a street; 黄鹤楼民 is the 华为民 shape.
    // When: the span is longer than the listed landmark.
    // Then: the filter must not fire. Substring matching would leak a real name.
    expect(isNonPersonOrganisation("黄鹤楼路")).toBe(false);
    expect(isNonPersonOrganisation("黄鹤楼民")).toBe(false);
    expect(isNonPersonOrganisation("天安门东")).toBe(false);
  });

  it("does not inherit the rule path's organisation-marker regex", () => {
    // The whole reason this is a separate predicate: the rule path's `isPersonNegative` treats 云 as
    // an organisation marker, which suppresses 马云 and also deletes 云丽 / 馨云 / 筑云 — twelve
    // gold-matching names on OpenPII. Measured in scripts/measure-negative-predicate-gap.mjs.
    for (const value of ["马云", "云丽", "馨云", "筑云"]) {
      expect(isNonPersonOrganisation(value)).toBe(false);
    }
  });

  it("is narrower than the rule path's name set, which is intentional", () => {
    // The rule lexicon is larger and includes bank names. Those are reached through a different
    // route and were not part of the measured variant, so the neural filter must not silently
    // widen to them.
    expect(COMMON_ORGANIZATION_OR_PLACE_NAMES.has("招商银行")).toBe(true);
    expect(isNonPersonOrganisation("招商银行")).toBe(false);
  });
});
