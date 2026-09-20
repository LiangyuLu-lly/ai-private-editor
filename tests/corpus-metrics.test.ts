import { describe, expect, it } from "vitest";

import { analyzeDraft } from "../src/shared/detector.js";
import { CHINESE_PRIVACY_CASES } from "./fixtures/chinese-privacy-corpus.js";

describe("Chinese privacy corpus metrics", () => {
  it("detects every expected category without declared false positives", () => {
    const missed: string[] = [];
    const unexpected: string[] = [];

    for (const testCase of CHINESE_PRIVACY_CASES) {
      const actualKinds = analyzeDraft(testCase.input, [], [], [], testCase.options).findings.map(
        (finding) => finding.kind,
      );

      for (const expectedKind of testCase.expectedKinds) {
        if (!actualKinds.includes(expectedKind)) {
          missed.push(`${testCase.name}: ${expectedKind}`);
        }
      }
      for (const unexpectedKind of testCase.unexpectedKinds ?? []) {
        if (actualKinds.includes(unexpectedKind)) {
          unexpected.push(`${testCase.name}: ${unexpectedKind}`);
        }
      }
    }

    expect(missed, `missed corpus cases:\n${missed.join("\n")}`).toEqual([]);
    expect(unexpected, `unexpected corpus findings:\n${unexpected.join("\n")}`).toEqual([]);
  });
});
