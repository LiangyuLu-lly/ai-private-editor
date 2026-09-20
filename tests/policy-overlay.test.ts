import { describe, expect, it } from "vitest";

import { mergeCategoryPolicies, type SiteCategoryPolicy } from "../src/shared/policy-overlay.js";
import type { CategoryPolicyEntry } from "../src/shared/types.js";

describe("policy overlay", () => {
  it("applies a site overlay over the global policy", () => {
    const global: readonly CategoryPolicyEntry[] = [{ kind: "phone", action: "replace" }];
    const overlay: readonly SiteCategoryPolicy[] = [
      { siteId: "chatgpt", kind: "phone", action: "confirm" },
    ];

    expect(mergeCategoryPolicies(global, overlay, "chatgpt")).toEqual([
      { kind: "phone", action: "confirm" },
    ]);
    expect(mergeCategoryPolicies(global, overlay, "doubao")).toEqual([
      { kind: "phone", action: "replace" },
    ]);
    expect(mergeCategoryPolicies(global, overlay, "kimi")).toEqual([
      { kind: "phone", action: "replace" },
    ]);

    const multipleKinds: readonly SiteCategoryPolicy[] = [
      { siteId: "chatgpt", kind: "phone", action: "confirm" },
      { siteId: "chatgpt", kind: "email", action: "block" },
    ];
    expect(mergeCategoryPolicies(global, multipleKinds, "chatgpt")).toEqual([
      { kind: "phone", action: "confirm" },
      { kind: "email", action: "block" },
    ]);

    const lastWins: readonly SiteCategoryPolicy[] = [
      { siteId: "chatgpt", kind: "phone", action: "confirm" },
      { siteId: "chatgpt", kind: "phone", action: "block" },
    ];
    expect(mergeCategoryPolicies(global, lastWins, "chatgpt")).toEqual([
      { kind: "phone", action: "block" },
    ]);
  });
});
