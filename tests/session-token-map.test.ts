import { describe, expect, it } from "vitest";

import { createSessionTokenMap } from "../src/shared/session-token-map.js";

describe("session token map", () => {
  it("keeps one raw value only in the current map and resolves its token", () => {
    const tokens = createSessionTokenMap();
    const token = tokens.getOrCreate("phone", "13800138000", "138 0013 8000");

    expect(tokens.getRawValue(token)).toBe("138 0013 8000");
    expect(tokens.hasToken(token)).toBe(true);
  });

  it("does not replace the first raw representation for an equivalent normalized value", () => {
    const tokens = createSessionTokenMap();
    const first = tokens.getOrCreate("phone", "13800138000", "138 0013 8000");
    const second = tokens.getOrCreate("phone", "13800138000", "13800138000");

    expect(second).toBe(first);
    expect(tokens.getRawValue(first)).toBe("138 0013 8000");
  });

  it("forgets all token and raw-value mappings when explicitly cleared", () => {
    const tokens = createSessionTokenMap();
    const token = tokens.getOrCreate("phone", "13800138000", "13800138000");

    tokens.clear();

    expect(tokens.hasToken(token)).toBe(false);
    expect(tokens.getRawValue(token)).toBeNull();
    expect(tokens.getOrCreate("phone", "13800138000", "13800138000")).toBe("[[PHONE_001]]");
  });
});
