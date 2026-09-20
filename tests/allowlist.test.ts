import { describe, expect, it } from "vitest";

import { mergeAllowlists, resolveScopedAllowlistedTerms } from "../src/shared/allowlist.js";

describe("scoped allowlist resolution", () => {
  it("keeps only unexpired entries for the current site and marks their scope", () => {
    const resolved = resolveScopedAllowlistedTerms(
      {
        state: "ready",
        terms: [],
        mode: "replace",
        allowlistedTerms: ["global-safe"],
        siteAllowlist: [
          { value: "live-site-safe", siteId: "chatgpt", expiresAt: "2030-01-02T00:00:00.000Z" },
          { value: "expired-site-safe", siteId: "chatgpt", expiresAt: "2030-01-01T00:00:00.000Z" },
          { value: "other-site-safe", siteId: "claude", expiresAt: "2030-01-02T00:00:00.000Z" },
        ],
      },
      "chatgpt",
      new Set(["session-safe"]),
      new Date("2030-01-01T12:00:00.000Z"),
    );

    expect(resolved).toEqual([
      { value: "global-safe", scope: "global" },
      { value: "live-site-safe", scope: "site", expiresAt: "2030-01-02T00:00:00.000Z" },
      { value: "session-safe", scope: "session" },
    ]);
  });

  it("unions allowlist values and keeps the later expiresAt for the same value and scope", () => {
    expect(
      mergeAllowlists(
        {
          allowlistedTerms: ["a"],
          siteAllowlist: [{ value: "dup", siteId: "chatgpt", expiresAt: "2030-01-01T00:00:00.000Z" }],
        },
        {
          allowlistedTerms: ["b"],
          siteAllowlist: [{ value: "dup", siteId: "chatgpt", expiresAt: "2031-06-01T00:00:00.000Z" }],
        },
      ),
    ).toEqual({
      allowlistedTerms: ["a", "b"],
      siteAllowlist: [{ value: "dup", siteId: "chatgpt", expiresAt: "2031-06-01T00:00:00.000Z" }],
    });
  });
});
