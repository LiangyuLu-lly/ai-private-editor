import { describe, expect, it } from "vitest";

import { isKnownDetectionKind } from "../src/scanner/types.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";
import type { DetectionKind } from "../src/shared/types.js";

describe("DetectionKind ipv6 plumbing", () => {
  it("accepts ipv6 in the known-kind parser when the kind is registered", () => {
    // Given: ipv6 is a DetectionKind
    const kind: DetectionKind = "ipv6";

    // When
    const known = isKnownDetectionKind(kind);

    // Then
    expect(known).toBe(true);
  });

  it("assigns the IPV6 token prefix when mapping an ipv6 value", () => {
    // Given
    const tokens = createSessionTokenMap();

    // When
    const token = tokens.getOrCreate("ipv6", "2001:db8::1");

    // Then
    expect(token).toBe("[[IPV6_001]]");
  });
});
