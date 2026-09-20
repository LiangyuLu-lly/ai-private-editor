import { describe, expect, it } from "vitest";

import { getAttachmentDecision } from "../src/attachment-guard.js";

describe("attachment guard", () => {
  it("returns an opaque warning without inspecting attachment details", () => {
    const attachment = document.createElement("div");
    attachment.setAttribute("data-private-name", "never-read.txt");

    expect(getAttachmentDecision("warn", [attachment])).toEqual({ action: "warn", count: 1 });
  });

  it("requires confirmation only when the policy requests it", () => {
    const attachment = document.createElement("div");

    expect(getAttachmentDecision("allow", [attachment])).toEqual({ action: "allow", count: 1 });
    expect(getAttachmentDecision("confirm", [attachment])).toEqual({ action: "confirm", count: 1 });
    expect(getAttachmentDecision("confirm", [])).toEqual({ action: "allow", count: 0 });
  });

  it("stops unscanned attachments until an explicit one-time override", () => {
    const attachment = document.createElement("div");

    expect(getAttachmentDecision("block", [attachment])).toEqual({ action: "block", count: 1 });
  });

  it("does not treat an unavailable attachment inspector as an empty attachment list", () => {
    expect(getAttachmentDecision("confirm", [], "unavailable")).toEqual({
      action: "confirm",
      count: 0,
      unverified: true,
    });
    expect(getAttachmentDecision("block", [], "unavailable")).toEqual({
      action: "block",
      count: 0,
      unverified: true,
    });
    expect(getAttachmentDecision("warn", [], "unavailable")).toEqual({
      action: "allow",
      count: 0,
      unverified: true,
    });
  });
});
