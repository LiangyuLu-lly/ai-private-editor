import { describe, expect, it } from "vitest";

import { analyzeDraft, getDetectionRanges } from "../src/shared/detector.js";
import type { DetectionKind, DetectionProfile } from "../src/shared/types.js";

const PROFILES = ["conservative", "balanced"] as const satisfies readonly DetectionProfile[];

function ranges(text: string, profile: DetectionProfile) {
  return getDetectionRanges(text, [], [], [], { detectionProfile: profile });
}

function valuesOf(text: string, profile: DetectionProfile, kind: DetectionKind): string[] {
  return ranges(text, profile)
    .filter((range) => range.kind === kind)
    .map((range) => text.slice(range.start, range.end));
}

function analysisKinds(text: string, profile: DetectionProfile): DetectionKind[] {
  return analyzeDraft(text, [], [], [], { detectionProfile: profile }).findings.map(
    (finding) => finding.kind,
  );
}

describe("professional entity recognizers", () => {
  describe.each(PROFILES)("profile %s", (profile) => {
    it("finds a 20-digit e-invoice number and ignores an order-number lookalike", () => {
      const positive = "数电发票号：23992000000000000001";
      const negative = "订单号：23992000000000000001";

      expect(valuesOf(positive, profile, "labeled_identifier")).toEqual(["23992000000000000001"]);
      expect(analysisKinds(positive, profile)).toContain("labeled_identifier");

      expect(valuesOf(negative, profile, "labeled_identifier")).toEqual([]);
      expect(analysisKinds(negative, profile)).not.toContain("labeled_identifier");
    });

    it("finds an SPC court case number and ignores a meeting date", () => {
      const positive = "(2024)京01民初123号";
      const negative = "会议日期：2024年1月1日";

      expect(valuesOf(positive, profile, "labeled_identifier")).toEqual(["(2024)京01民初123号"]);
      expect(analysisKinds(positive, profile)).toContain("labeled_identifier");

      expect(valuesOf(negative, profile, "labeled_identifier")).toEqual([]);
      expect(analysisKinds(negative, profile)).not.toContain("labeled_identifier");
    });

    it("finds a space-separated medical record number and ignores 账号 已经注销", () => {
      const positive = "病历号 440123456789";
      const negative = "账号 已经注销";

      expect(valuesOf(positive, profile, "labeled_identifier")).toEqual(["440123456789"]);
      expect(analysisKinds(positive, profile)).toContain("labeled_identifier");

      expect(valuesOf(negative, profile, "labeled_identifier")).toEqual([]);
      expect(analysisKinds(negative, profile)).not.toContain("labeled_identifier");
      expect(valuesOf(negative, profile, "account")).toEqual([]);
    });

    it("finds a bare ISO-3779 VIN and ignores a 17-char string containing I/O/Q", () => {
      const positive = "1HGCM82633A004352";
      const negative = "1HOCM82633A004352";

      expect(valuesOf(positive, profile, "labeled_identifier")).toEqual(["1HGCM82633A004352"]);
      expect(analysisKinds(positive, profile)).toContain("labeled_identifier");

      expect(valuesOf(negative, profile, "labeled_identifier")).toEqual([]);
      expect(analysisKinds(negative, profile)).not.toContain("labeled_identifier");
    });

    it("finds a contract number and ignores 甲方/乙方 prose", () => {
      const positive = "合同号：HT-2024-001";
      const negative = "甲方应当按约履行";

      expect(valuesOf(positive, profile, "labeled_identifier")).toEqual(["HT-2024-001"]);
      expect(analysisKinds(positive, profile)).toContain("labeled_identifier");

      expect(valuesOf(negative, profile, "labeled_identifier")).toEqual([]);
      expect(analysisKinds(negative, profile)).not.toContain("labeled_identifier");
    });

    it("finds +86 and 0086 mobile numbers and ignores a room code", () => {
      const plus = "+86 13800138000";
      const zeroZero = "008613800138000";
      const negative = "会议室 1380";

      expect(valuesOf(plus, profile, "phone").some((value) => value.includes("13800138000"))).toBe(
        true,
      );
      expect(analysisKinds(plus, profile)).toContain("phone");

      expect(valuesOf(zeroZero, profile, "phone").some((value) => value.includes("13800138000"))).toBe(
        true,
      );
      expect(analysisKinds(zeroZero, profile)).toContain("phone");

      expect(valuesOf(negative, profile, "phone")).toEqual([]);
      expect(analysisKinds(negative, profile)).not.toContain("phone");
    });

    it("finds IPv6, keeps IPv4 as ipv4, and skips loopback/link-local IPv6", () => {
      const mixed = "网关 2001:db8::1 备份 192.168.1.1";
      const loopbackV4 = "127.0.0.1";
      const loopbackV6 = "::1";
      const linkLocal = "fe80::1";

      expect(valuesOf(mixed, profile, "ipv6")).toEqual(["2001:db8::1"]);
      expect(analysisKinds(mixed, profile)).toContain("ipv6");
      expect(valuesOf(mixed, profile, "ipv4")).toEqual(["192.168.1.1"]);
      expect(analysisKinds(mixed, profile)).toContain("ipv4");

      expect(valuesOf(loopbackV4, profile, "ipv6")).toEqual([]);
      expect(analysisKinds(loopbackV4, profile)).not.toContain("ipv6");

      expect(valuesOf(loopbackV6, profile, "ipv6")).toEqual([]);
      expect(analysisKinds(loopbackV6, profile)).not.toContain("ipv6");
      expect(valuesOf(linkLocal, profile, "ipv6")).toEqual([]);
      expect(analysisKinds(linkLocal, profile)).not.toContain("ipv6");
    });

    it("leaves 投保人 钱思洁 uncovered while china_id 63-81 remains on sift-opf-gold-00470", () => {
      // Pre-existing gap vs r7 over-wide PERSON 42-81: R1 snapshot and current both miss the name.
      const text = [
        "保险单",
        "保单号:P-2025-098765 投保日期:2025-05-15",
        "投保人:钱思洁 女 1990-12-08 身份证 320106199012080048",
        "联系电话:13501239876 邮箱:qian.sj@outlook.com",
        "住址:上海市浦东新区世纪大道 1198 号 12 层 1208 室",
        "受益人:配偶 周建国 身份证 110108196201020013 13988776655",
        "保额:200 万 期限:终身",
        "扣款账户:招商银行 6225884567890123 (户名 钱思洁)",
        "扣款日:每月 5 号",
      ].join("\n");

      expect(text.slice(42, 45)).toBe("钱思洁");
      expect(text.slice(63, 81)).toBe("320106199012080048");

      const hits = ranges(text, profile);
      expect(valuesOf(text, profile, "person_name")).not.toContain("钱思洁");
      expect(
        hits.some((range) => range.kind === "person_name" && range.start < 45 && range.end > 42),
      ).toBe(false);
      expect(
        hits.some((range) => range.kind === "china_id" && range.start === 63 && range.end === 81),
      ).toBe(true);
    });
  });
});
