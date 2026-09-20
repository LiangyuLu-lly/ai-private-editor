import { describe, expect, it } from "vitest";

import { analyzeDraft, getDetectionRanges } from "../src/shared/detector.js";

function detectedValues(text: string, kind: Parameters<typeof getDetectionRanges>[1] extends never ? never : string) {
  return getDetectionRanges(text, [], [], [], { detectionProfile: "balanced" })
    .filter((range) => range.kind === kind)
    .map((range) => text.slice(range.start, range.end));
}

describe("ordinary-office PII variants", () => {
  it("detects an account expressed as a search instruction without a field label", () => {
    const input = "没有字段名：先搜鹤影9509，再问郄语穗。";

    expect(detectedValues(input, "account")).toEqual(["鹤影9509"]);
  });

  it("detects a mixed Chinese account after an OCR-style account cue", () => {
    const input = "截图 OCR 把符号拆开，完整账号仍是晚钟8111。";

    expect(detectedValues(input, "account")).toEqual(["晚钟8111"]);
  });

  it("detects an account when a work chat window is changed to that handle", () => {
    const input = "对接窗口换成鸢尾_cid40了，找祝霁言时用这个别名即可。";

    expect(detectedValues(input, "account")).toEqual(["鸢尾_cid40"]);
  });

  it("detects an account preceded by an ordinary conversational verb", () => {
    const input = "定位到景原市鹿鸣区观澜巷81号后用晚樱_cid24发一声就好。";

    expect(detectedValues(input, "account")).toEqual(["晚樱_cid24"]);
  });

  it("detects a resident id dictated as Chinese digits in a voice transcript", () => {
    const input = "录音里只记下西门江蕴的一一零一零五一九四九一二三一零零二X，转文字时别漏分隔符。";

    expect(detectedValues(input, "china_id")).toEqual(["一一零一零五一九四九一二三一零零二X"]);
  });

  it("does not include a field separator in an obfuscated email replacement", () => {
    const input = "扫描件校对\n邮件入口=case.260911.597 艾特 hardcase-r14 点 invalid\n完整范围需要保留。";
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });

    expect(result.redactedText).toBe("扫描件校对\n邮件入口=[[EMAIL_001]]\n完整范围需要保留。");
  });

  it("does not treat internal sample identifiers as personal accounts", () => {
    const input = "model-card_0129代表内部样本编号，不能据此推断任何用户身份。";

    expect(detectedValues(input, "account")).toEqual([]);
  });

  it("detects a numeric alias after an English alias assignment", () => {
    const input = "英文 handoff / owner=欧阳绎宁 / alias=32912544。";

    expect(detectedValues(input, "account")).toEqual(["32912544"]);
  });

  it("detects a mixed Chinese alias after an attachment handoff phrase", () => {
    const input = "附件发给橘灯_thi84就行，回执会转到项目群。";

    expect(detectedValues(input, "account")).toEqual(["橘灯_thi84"]);
  });

  it("detects the value in a rename-to-alias expression", () => {
    const input = "霍绢说别名改为松露_cid64，原会话不用再@了。";

    expect(detectedValues(input, "account")).toEqual(["松露_cid64"]);
  });

  it("maps a full-width alias back to the source text", () => {
    const input = "后用ｍ＿ｖｉｏｌｅｔ３０６６发一声就好。";

    expect(detectedValues(input, "account")).toEqual(["ｍ＿ｖｉｏｌｅｔ３０６６"]);
  });

  it("detects a numeric personal contact entry without a field label", () => {
    const input = "FOLLOW 标记后出现17027152，它表示个人联系入口。";

    expect(detectedValues(input, "account")).toEqual(["17027152"]);
  });

  it.each([
    "工单号 17027152 已关闭，版本已发布。",
    "订单流水 32912544 仅用于对账。",
    "项目编号 alias=32912544 不代表任何个人账号。",
  ])("does not treat a technical number as a personal account: %s", (input) => {
    expect(detectedValues(input, "account")).toEqual([]);
  });
});
