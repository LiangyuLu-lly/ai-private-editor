import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const welcome = readFileSync(join(root, "src/welcome.html"), "utf8");

describe("welcome copy", () => {
  it("does not cite retired R8 leak percentages", () => {
    expect(welcome).not.toContain("81.2");
    expect(welcome).not.toContain("2.8%");
  });

  it("states the cost of turning the model off", () => {
    expect(welcome).toContain("没有提示词的人名几乎不会再提示");
    expect(welcome).toContain("update-banner");
    expect(welcome).toContain("dismiss-update");
  });
});
