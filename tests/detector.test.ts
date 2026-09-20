import { describe, expect, it } from "vitest";

import {
  analyzeDraft,
  getRedactionValues,
  materializeDraftRedaction,
  redactDraft,
  resolveSendAction,
} from "../src/shared/detector.js";
import { getCuratedSecretRules } from "../src/shared/secret-rules.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";

describe("redactDraft", () => {
  it.each([
    ["到时给我打电话吧，幺三八 零零零一 二三四五，下午方便。", "到时给我打电话吧，[[PHONE_001]]，下午方便。"],
    ["请回拨１３九·〇〇〇〇·五六七八。", "请回拨[[PHONE_001]]。"],
    ["一三九零零零零五六七八是我的手机号。", "[[PHONE_001]]是我的手机号。"],
    ["🙂手机：幺三九\u200b零零零零五六七八", "🙂手机：[[PHONE_001]]"],
    ["拨打幺三八-零零零一-二三四五", "拨打[[PHONE_001]]"],
  ])("detects dictated Chinese phones without relying on neural labels: %s", (input, expected) => {
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });
    expect(result.redactedText).toBe(expected);
    expect(resolveSendAction(result.findings, "replace")).toBe("replace");
    expect(result.findings).toEqual([{ kind: "phone", decision: "replace", count: 1 }]);
  });

  it.each([
    "练习念数字：幺三八零零零一二三四五。",
    "题目中的号码是一二三四五六七八九零一。",
    "联系电话：幺三八零零零一二三四五六。",
    "电话随手记了幺三八零零零一二三四，还没记完。",
    "代码示例中，phone 等于幺三八零零零一二三四五。",
    "测试夹具的电话是幺三八零零零一二三四五。",
  ])("does not invent phones from unsupported dictated numbers: %s", (input) => {
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });
    expect(result.findings.filter((finding) => finding.kind === "phone")).toEqual([]);
  });

  it.each([
    ["测试结束后请回拨幺三九零零零零五六七八，谢谢。", "测试结束后请回拨[[PHONE_001]]，谢谢。"],
    ["代码稍后发给你，先打电话幺三九零零零零五六七八联系我。", "代码稍后发给你，先打电话[[PHONE_001]]联系我。"],
    ["这不是测试数据，我的手机号是幺三九零零零零五六七八。", "这不是测试数据，我的手机号是[[PHONE_001]]。"],
    ["这不是测试数据而是我的手机号幺三九零零零零五六七八。", "这不是测试数据而是我的手机号[[PHONE_001]]。"],
    ["日志里记录了我的手机号幺三九零零零零五六七八。", "日志里记录了我的手机号[[PHONE_001]]。"],
    ["样例已经写好；请回拨幺三九零零零零五六七八，代码示例稍后给你。", "样例已经写好；请回拨[[PHONE_001]]，代码示例稍后给你。"],
    ["测试完成后请回拨１３九·〇〇〇〇·五六七八🙂", "测试完成后请回拨[[PHONE_001]]🙂"],
  ])("keeps personal phone evidence in ordinary work context: %s", (input, expected) => {
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });
    expect(result.redactedText).toBe(expected);
    expect(result.findings).toEqual([{ kind: "phone", decision: "replace", count: 1 }]);
  });

  it.each([
    "测试数据中的手机号是幺三九零零零零五六七八。",
    "配置样例的电话为幺三九零零零零五六七八。",
    "电话幺三九零零零零五六七八是固定占位。",
    "电话号码幺三九零零零零五六七八只是代码示例。",
  ])("keeps explicitly attributed fixture phones unredacted: %s", (input) => {
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });
    expect(result.redactedText).toBe(input);
    expect(result.findings).toEqual([]);
  });

  it("does not let a fixture clause suppress a separate personal contact", () => {
    const input = "测试夹具的电话是幺三八零零零一二三四五；我的电话是幺三九零零零零五六七八。";
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });
    expect(result.redactedText).toBe("测试夹具的电话是幺三八零零零一二三四五；我的电话是[[PHONE_001]]。");
    expect(result.findings).toEqual([{ kind: "phone", decision: "replace", count: 1 }]);
  });

  it("keeps an obfuscated contact email next to incidental technical prose", () => {
    const input = "测试结束后请发到 lan.qin 艾特 example 点 invalid，代码示例我来整理。";
    const result = analyzeDraft(input, [], [], [], { detectionProfile: "balanced" });
    expect(result.redactedText).toBe("测试结束后请发到 [[EMAIL_001]]，代码示例我来整理。");
    expect(result.findings).toEqual([expect.objectContaining({ kind: "email", policy: "confirm" })]);
  });

  it("keeps model-recognized contact numbers when testing is only surrounding work", () => {
    const input = "测试完了，把幺三九零零零零五六七八单独发我。";
    const start = input.indexOf("幺");
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "phone", start, end: start + 11, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(result.redactedText).toBe("测试完了，把[[PHONE_001]]单独发我。");
    expect(result.findings).toEqual([expect.objectContaining({ kind: "phone", policy: "confirm" })]);
  });

  it("reuses one phone token and allowlist identity across spoken and Arabic digits", () => {
    const session = createSessionTokenMap();
    const spoken = "手机：一三九零零零零五六七八";
    expect(materializeDraftRedaction(spoken, [], session).outboundText).toBe("手机：[[PHONE_001]]");
    expect(materializeDraftRedaction("手机：13900005678", [], session).outboundText).toBe("手机：[[PHONE_001]]");
    expect(analyzeDraft(spoken, [], ["13900005678"]).redactedText).toBe(spoken);
  });

  it("prepares a local safe rendering for a high-risk credential before confirmation", () => {
    const secret = "synthetic-confirmation-secret";
    const analysis = analyzeDraft(`数据库密码：${secret}`);

    expect(analysis).toEqual({
      findings: [{ kind: "credential", decision: "block", count: 1, labels: ["数据库密码"] }],
      redactedText: "数据库密码：[[CREDENTIAL_001]]",
    });
    expect(resolveSendAction(analysis.findings, "replace")).toBe("confirm");
    expect(JSON.stringify(analysis.findings)).not.toContain(secret);
  });

  it("materializes a confirmed anonymous draft with the current session token map", () => {
    const tokenMap = createSessionTokenMap();
    const secret = "synthetic-confirmation-secret";

    expect(materializeDraftRedaction(`数据库密码：${secret}，手机号：13800138000`, [], tokenMap)).toEqual({
      findings: [
        { kind: "credential", decision: "block", count: 1, labels: ["数据库密码"] },
        { kind: "phone", decision: "replace", count: 1 },
      ],
      outboundText: "数据库密码：[[CREDENTIAL_001]]，手机号：[[PHONE_001]]",
    });
    expect(materializeDraftRedaction("再次联系 13800138000", [], tokenMap).outboundText).toBe(
      "再次联系 [[PHONE_001]]",
    );
  });

  it("captures comma-containing quoted and unquoted credential values as a whole", () => {
    const quoted = redactDraft('password="alpha,beta"', [], undefined, [], [{ kind: "credential", action: "replace" }]);
    const unquoted = redactDraft("数据库密码：alpha,beta，手机号：13800138000", [], undefined, [], [
      { kind: "credential", action: "replace" },
    ]);

    expect(quoted.status === "ready" ? quoted.outboundText : "").toBe('password="[[CREDENTIAL_001]]"');
    expect(unquoted.status === "ready" ? unquoted.outboundText : "").toBe(
      "数据库密码：[[CREDENTIAL_001]]，手机号：[[PHONE_001]]",
    );
    expect(unquoted.status === "ready" ? unquoted.outboundText : "").not.toContain("beta");
  });

  it("recognizes short bearer credentials and common English configuration keys", () => {
    const result = redactDraft("Authorization: Bearer synthetic-token-value password=alpha,beta");

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.kind)).toContain("credential");
    expect(JSON.stringify(result.findings)).not.toContain("synthetic-token-value");
  });

  it("blocks a high-confidence API key without retaining it in the result", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ";
    const result = redactDraft(`请检查这个密钥：${secret}`);

    expect(result).toEqual({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "api_key", decision: "block", count: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("replaces repeated normalized values with a stable token", () => {
    const result = redactDraft("请联系 138 0013 8000 或 13800138000，邮箱 li@example.com。");

    expect(result.status).toBe("ready");
    expect(result.outboundText).toBe(
      "请联系 [[PHONE_001]] 或 [[PHONE_001]]，邮箱 [[EMAIL_001]]。",
    );
    expect(result.findings).toEqual([
      { kind: "phone", decision: "replace", count: 2 },
      { kind: "email", decision: "replace", count: 1 },
    ]);
  });

  it("keeps tokens stable across drafts when they share a session map", () => {
    const tokenMap = createSessionTokenMap();

    const first = redactDraft("请联系 13800138000，邮箱 Li@Example.com。", [], tokenMap);
    const second = redactDraft("再次联系 138 0013 8000，并抄送 li@example.com。", [], tokenMap);

    expect(first).toMatchObject({
      status: "ready",
      outboundText: "请联系 [[PHONE_001]]，邮箱 [[EMAIL_001]]。",
    });
    expect(second).toMatchObject({
      status: "ready",
      outboundText: "再次联系 [[PHONE_001]]，并抄送 [[EMAIL_001]]。",
    });
  });

  it("keeps a user-configured Chinese name stable across drafts", () => {
    const tokenMap = createSessionTokenMap();

    expect(redactDraft("张三负责这个项目。", ["张三"], tokenMap)).toMatchObject({
      status: "ready",
      outboundText: "[[CUSTOM_001]]负责这个项目。",
    });
    expect(redactDraft("请让张三补充进度。", ["张三"], tokenMap)).toMatchObject({
      status: "ready",
      outboundText: "请让[[CUSTOM_001]]补充进度。",
    });
  });

  it("does not reserve session tokens for a draft blocked by a credential", () => {
    const tokenMap = createSessionTokenMap();
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ";

    expect(redactDraft(`手机号 13800138000，密钥 ${secret}`, [], tokenMap)).toMatchObject({
      status: "blocked",
      outboundText: null,
    });
    expect(redactDraft("手机号 13800138000", [], tokenMap)).toMatchObject({
      status: "ready",
      outboundText: "手机号 [[PHONE_001]]",
    });
  });

  it("starts token numbering again for a new session map", () => {
    const firstMap = createSessionTokenMap();
    const secondMap = createSessionTokenMap();

    expect(redactDraft("请联系 13800138000", [], firstMap)).toMatchObject({
      status: "ready",
      outboundText: "请联系 [[PHONE_001]]",
    });
    expect(redactDraft("请联系 13900139000", [], firstMap)).toMatchObject({
      status: "ready",
      outboundText: "请联系 [[PHONE_002]]",
    });
    expect(redactDraft("请联系 13900139000", [], secondMap)).toMatchObject({
      status: "ready",
      outboundText: "请联系 [[PHONE_001]]",
    });
  });

  it("prefers a longer custom term when custom terms overlap", () => {
    const result = redactDraft("项目代号是阿尔法计划，简称阿尔法。", ["阿尔法", "阿尔法计划"]);

    expect(result).toMatchObject({
      status: "ready",
      outboundText: "项目代号是[[CUSTOM_001]]，简称[[CUSTOM_002]]。",
      findings: [{ kind: "custom_term", decision: "replace", count: 2 }],
    });
  });

  it("only replaces checksum-valid IDs and card-like numbers", () => {
    const result = redactDraft(
      "身份证 11010519491231002X，卡号 4539 1488 0343 6467，无效号 110105194912310021。",
    );

    expect(result).toMatchObject({
      status: "ready",
      outboundText:
        "身份证 [[CHINA_ID_001]]，卡号 [[BANK_CARD_001]]，无效号 110105194912310021。",
      findings: [
        { kind: "china_id", decision: "replace", count: 1 },
        { kind: "bank_card", decision: "replace", count: 1 },
      ],
    });
  });

  it("replaces a labeled ID-shaped value before it can be mistaken for a bank card", () => {
    const result = redactDraft("身份证号：110105194912310002");

    expect(result).toEqual({
      status: "ready",
      outboundText: "身份证号：[[CHINA_ID_001]]",
      findings: [{ kind: "china_id", decision: "replace", count: 1, labels: ["身份证号"] }],
    });
  });

  it("keeps an explicitly labeled invalid-checksum identity number out of bank-card classification", () => {
    expect(redactDraft("紧急联系人身份证：610402199411072648")).toEqual({
      status: "ready",
      outboundText: "紧急联系人身份证：[[CHINA_ID_001]]",
      findings: [{ kind: "china_id", decision: "replace", count: 1, labels: ["紧急联系人身份证"] }],
    });
  });

  it("accepts common Unicode dashes in a labeled email address", () => {
    const nonBreakingHyphen = String.fromCharCode(0x2011);
    const result = redactDraft(`邮箱：test${nonBreakingHyphen}person@example${nonBreakingHyphen}demo.com`);

    expect(result).toEqual({
      status: "ready",
      outboundText: "邮箱：[[EMAIL_001]]",
      findings: [{ kind: "email", decision: "replace", count: 1 }],
    });
  });

  it("blocks an API key written with Unicode dashes", () => {
    const nonBreakingHyphen = String.fromCharCode(0x2011);
    const secret = `sk${nonBreakingHyphen}proj${nonBreakingHyphen}ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890`;
    const result = redactDraft(`项目密钥：${secret}`);

    expect(result).toEqual({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "api_key", decision: "block", count: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("replaces a checksum-valid unified social credit code", () => {
    const result = redactDraft("统一社会信用代码：91110108MA01K12342");

    expect(result).toEqual({
      status: "ready",
      outboundText: "统一社会信用代码：[[USCC_001]]",
      findings: [{ kind: "unified_social_credit_code", decision: "replace", count: 1 }],
    });
  });

  it("leaves a checksum-invalid unified social credit code unchanged", () => {
    expect(redactDraft("统一社会信用代码：91110108MA01K12343")).toEqual({
      status: "ready",
      outboundText: "统一社会信用代码：91110108MA01K12343",
      findings: [],
    });
  });

  it("replaces a labeled card number even when a synthetic sample fails Luhn validation", () => {
    expect(redactDraft("银行卡号：4000000000000000000")).toEqual({
      status: "ready",
      outboundText: "银行卡号：[[BANK_CARD_001]]",
      findings: [{ kind: "bank_card", decision: "replace", count: 1, labels: ["银行卡号"] }],
    });
  });

  it("reports a MAC address with a dedicated stable token", () => {
    expect(redactDraft("MAC地址：AA-BB-CC-DD-EE-FF")).toEqual({
      status: "ready",
      outboundText: "MAC地址：[[MAC_ADDRESS_001]]",
      findings: [{ kind: "mac_address", decision: "replace", count: 1 }],
    });
  });

  it("replaces explicit Chinese labels for a person, address, account, and identifier", () => {
    const result = redactDraft(
      "对接人：李小明，家庭住址：北京市海淀区科技路12号，微信号：sample_wechat_42，工号：EMP-42。",
    );

    expect(result).toEqual({
      status: "ready",
      outboundText:
        "对接人：[[PERSON_001]]，家庭住址：[[ADDRESS_001]]，微信号：[[ACCOUNT_001]]，工号：[[IDENTIFIER_001]]。",
      findings: [
        { kind: "person_name", decision: "replace", count: 1, labels: ["对接人"] },
        { kind: "address", decision: "replace", count: 1, labels: ["家庭住址"] },
        { kind: "account", decision: "replace", count: 1, labels: ["微信号"] },
        { kind: "labeled_identifier", decision: "replace", count: 1, labels: ["工号"] },
      ],
    });
  });

  it.each([
    ["社保卡号", "SS-001"],
    ["医保卡号", "YB-001"],
    ["公积金账号", "HF-002"],
    ["客户合同编号", "CT-003"],
    ["人事档案编号", "HR-004"],
    ["车架号", "VIN-006"],
  ])("replaces a %s value only when the field label is explicit", (label, value) => {
    expect(redactDraft(`${label}：${value}`)).toEqual({
      status: "ready",
      outboundText: `${label}：[[IDENTIFIER_001]]`,
      findings: [{ kind: "labeled_identifier", decision: "replace", count: 1, labels: [label] }],
    });
  });

  it.each([
    ["车辆牌照", "京A-005"],
    ["车牌号", "陕A8KD47"],
    ["车牌", "沪B12345"],
  ])("reports a %s value as a license plate rather than a generic identifier", (label, value) => {
    // 从 labeled_identifier 拆出来是有意的：出站文本里的令牌本来就按类型命名
    // （[[PERSON_001]]、[[ADDRESS_001]]），车牌笼统写成“编号”会让收信方少一条信息，
    // 用户在提示里也看不出被删的是什么。
    expect(redactDraft(`${label}：${value}`)).toEqual({
      status: "ready",
      outboundText: `${label}：[[LICENSE_PLATE_001]]`,
      findings: [{ kind: "license_plate", decision: "replace", count: 1, labels: [label] }],
    });
  });

  it.each([
    ["护照号", "E12345678"],
    ["护照", "G70546688"],
    ["因私护照", "EA1234567"],
  ])("replaces a %s value, which the detector previously had no coverage for at all", (label, value) => {
    // `护照` 此前在整个 src/ 里一次都没出现，裸号和带标签号都会原样发出去。
    expect(redactDraft(`${label}：${value}`)).toEqual({
      status: "ready",
      outboundText: `${label}：[[PASSPORT_001]]`,
      findings: [{ kind: "passport", decision: "replace", count: 1, labels: [label] }],
    });
  });

  it("detects a bare passport number and a bare plate with no field label", () => {
    const result = redactDraft("护照 E12345678 已经过期，他的车是京A12345。");

    expect(result.status).toBe("ready");
    expect(result.outboundText).toBe("护照 [[PASSPORT_001]] 已经过期，他的车是[[LICENSE_PLATE_001]]。");
  });

  it("detects high-signal Chinese privacy extensions with strict boundaries", () => {
    const result = redactDraft(
      "生日：1992年5月14日，分享 https://pan.baidu.com/s/1AbCdEfGhijk，设备 0E-3F-A2-78-D1-94，银行账户：ABC-2026-00991。",
      [],
      undefined,
      [],
      [{ kind: "private_url", action: "replace" }],
    );

    expect(result).toEqual({
      status: "ready",
      outboundText:
        "生日：[[PRIVATE_DATE_001]]，分享 [[PRIVATE_URL_001]]，设备 [[MAC_ADDRESS_001]]，银行账户：[[BANK_ACCOUNT_001]]。",
      findings: [
        { kind: "private_date", decision: "replace", count: 1, labels: ["生日"] },
        { kind: "private_url", decision: "replace", count: 1, policy: "replace" },
        { kind: "mac_address", decision: "replace", count: 1 },
        { kind: "bank_account", decision: "replace", count: 1, labels: ["银行账户"] },
      ],
    });
  });

  it("does not widen privacy extensions into ordinary dates, public pages, or sentinel MACs", () => {
    const result = redactDraft(
      "公开主页 https://pan.baidu.com/，版本发布日期：2026-08-31，MAC 00:00:00:00:00:00，广播 FF-FF-FF-FF-FF-FF。",
    );

    expect(result.findings).toEqual([]);
    expect(result.status === "ready" ? result.outboundText : "").toBe(
      "公开主页 https://pan.baidu.com/，版本发布日期：2026-08-31，MAC 00:00:00:00:00:00，广播 FF-FF-FF-FF-FF-FF。",
    );
  });

  it("redacts a chat participant and bare UnionPay-shaped number while excluding business numbers", () => {
    const result = redactDraft(
      "信息汇总：沈杰/181 03413164/510104198303123639/6225684192832768",
    );
    expect(result).toMatchObject({
      status: "ready",
      outboundText: "信息汇总：[[PERSON_001]]/[[PHONE_001]]/[[CHINA_ID_001]]/[[BANK_CARD_001]]",
      findings: [
        { kind: "person_name", count: 1, policy: "confirm" },
        { kind: "phone", count: 1 },
        { kind: "china_id", count: 1 },
        { kind: "bank_card", count: 1, policy: "confirm" },
      ],
    });

    const business = redactDraft("订单号 6225684192832768，端口 3306，版本 6225684192832768");
    expect(business.findings).toEqual([]);
    expect(redactDraft("构建任务校验码 62220230632096969 只是测试编号，不是银行卡。").findings).toEqual([]);
  });

  it("does not let a nearby bank-card context steal an adjacent identity number", () => {
    const result = redactDraft("👋 曹霞 手机186 80715451 身份证420106199201228902 银行卡6214837603859771 都在这了");
    expect(result).toMatchObject({
      status: "ready",
      findings: [
        { kind: "person_name", count: 1, policy: "confirm" },
        { kind: "phone", count: 1 },
        { kind: "china_id", count: 1 },
        { kind: "bank_card", count: 1 },
      ],
    });
    expect(result.status === "ready" ? result.outboundText : "").not.toContain("420106199201228902");
  });

  it("recognizes a plausibly dated identity number with chat-style grouping only in identity context", () => {
    const protectedDraft = redactDraft("叶嘉琪身份证号 510107 19660806 7105 🤣");
    expect(protectedDraft).toMatchObject({
      status: "ready",
      outboundText: "[[PERSON_001]]身份证号 [[CHINA_ID_001]] 🤣",
      findings: [
        { kind: "person_name", count: 1, policy: "confirm" },
        { kind: "china_id", count: 1, policy: "confirm" },
      ],
    });

    expect(redactDraft("版本号 510107 19660806 7105 已发布").findings).toEqual([]);
  });

  it("uses an adjacent structured value as a bounded person-name boundary", () => {
    const result = redactDraft("FYI 彭静 13229014767 email admin57@foxmail.com");
    expect(result).toMatchObject({
      status: "ready",
      outboundText: "FYI [[PERSON_001]] [[PHONE_001]] email [[EMAIL_001]]",
      findings: [
        { kind: "person_name", count: 1, policy: "confirm" },
        { kind: "phone", count: 1 },
        { kind: "email", count: 1 },
      ],
    });

    const ordinary = redactDraft("项目说明方案 13800138000 已更新");
    expect(ordinary.findings.map((finding) => finding.kind)).toEqual(["phone"]);
  });

  it("detects names adjacent to self-validating contact values without treating organization names as people", () => {
    const result = redactDraft("@all 徐敏 16448570862，邓洋 13959351863");
    expect(result).toMatchObject({
      status: "ready",
      outboundText: "@all [[PERSON_001]] [[PHONE_001]]，[[PERSON_002]] [[PHONE_002]]",
      findings: [
        { kind: "person_name", count: 2, policy: "confirm" },
        { kind: "phone", count: 2 },
      ],
    });

    expect(redactDraft("华为 13800138000 是公司测试号").findings.map((finding) => finding.kind)).toEqual(["phone"]);
  });

  it("covers chat-shaped structured variants before semantic hints can fragment them", () => {
    const input = "负责人：皇甫知宁，证件串130102-19740611-100X；回电(145)6530-8173；邮箱 notice.r12.909.2_at_r12-mail_dot_invalid；私聊 @mosaic_909_000000";
    const result = redactDraft(input, [], undefined, [], [], { detectionProfile: "balanced" });

    expect(result.outboundText).toBe(
      "负责人：[[PERSON_001]]，证件串[[CHINA_ID_001]]；回电[[PHONE_001]]；邮箱 [[EMAIL_001]]；私聊 [[ACCOUNT_001]]",
    );
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "person_name",
      "china_id",
      "phone",
      "email",
      "account",
    ]);
  });

  it.each([
    "回执写 demo_user[at]example[dot]invalid，不要公开",
    "回执写 demo_user 艾特 example 点 invalid，不要公开",
  ])("recognizes a complete obfuscated email rule without fragmenting it into accounts: %s", (input) => {
    const result = redactDraft(input);

    expect(result.status).toBe("ready");
    expect(result.findings).toEqual([
      { kind: "email", decision: "replace", count: 1, policy: "confirm" },
    ]);
    expect(result.status === "ready" ? result.outboundText : "").toBe(
      "回执写 [[EMAIL_001]]，不要公开",
    );
  });

  it.each([
    "notice.r12.909.0（at）r12-mail（dot）invalid",
    "notice.r12.909.0 at r12-mail dot invalid",
    "notice.r12.909.0_at_r12-mail_dot_invalid",
  ])("normalizes obfuscated email spelling %s", (value) => {
    const result = redactDraft(`邮箱：${value}`);
    expect(result.outboundText).toBe("邮箱：[[EMAIL_001]]");
    expect(result.findings).toEqual([{ kind: "email", decision: "replace", count: 1, policy: "confirm" }]);
  });

  it("confirms a shaped account alias only in explicit local account context", () => {
    const result = redactDraft("应用里搜 qinglan_483920 就能找到我，加work_qinglan_4821 也可以。");
    expect(result).toMatchObject({
      status: "ready",
      outboundText: "应用里搜 [[ACCOUNT_001]] 就能找到我，加[[ACCOUNT_002]] 也可以。",
      findings: [{ kind: "account", count: 2, policy: "confirm", inferred: true }],
    });

    expect(redactDraft("项目版本 v1.2.3 已更新，token qinglan_483920 不要提交。").findings).toEqual([]);
    expect(redactDraft("```text\n应用里搜 qinglan_483920\n```").findings).toEqual([]);
  });

  it("accepts a personal account assignment without treating a project service name as a person", () => {
    const personal = redactDraft("导出的联系人里有皇甫知宁，账号记为mosaic_909_000001，只限项目小组使用。", [], undefined, [], [], {
      detectionProfile: "balanced",
    });
    expect(personal.outboundText).toBe("导出的联系人里有[[PERSON_001]]，账号记为[[ACCOUNT_001]]，只限项目小组使用。");
    expect(personal.findings.map((finding) => finding.kind)).toEqual(["person_name", "account"]);

    expect(redactDraft("项目账号记为 service_worker_2026，不能按聊天账号处理。", [], undefined, [], [], {
      detectionProfile: "balanced",
    }).findings).toEqual([]);
  });

  it("rejects technical placeholders and explicit non-account prose while keeping a personal code-host account", () => {
    const negatives = [
      "代码示例的cache_warmup_0017是变量占位，形状像账号也不能当作联系人。",
      "tenant_seed_0017用于区分实验批次，不是姓名，也不应提示为私人账号。",
      "日志里的fixture_user_0017是服务任务标识，不是聊天账号或联系人。",
      "把fixture_user_0189留在变更单即可；这是组件代号，不是私聊对象。",
    ];
    for (const input of negatives) {
      expect(redactDraft(input, [], undefined, [], [], { detectionProfile: "balanced" }).findings, input).toEqual([]);
    }

    const personal = redactDraft("我的代码托管账号是alice_dev_2026", [], undefined, [], [], {
      detectionProfile: "balanced",
    });
    expect(personal.outboundText).toBe("我的代码托管账号是[[ACCOUNT_001]]");
    expect(personal.findings.map((finding) => finding.kind)).toEqual(["account"]);
  });

  it("does not treat ordinary English words as accounts when a shaped handle is present", () => {
    const input = "ＦＯＬＬＯＷ 标记后出现个人联系入口；英文 reply target 指向45959345，不是服务用户名；真实句柄 alice_dev_2026";
    const hints = ["ＦＯＬＬＯＷ", "reply", "target", "45959345", "alice_dev_2026"].map((value) => {
      const start = input.indexOf(value);
      return { kind: "account" as const, start, end: start + value.length, score: 0.9, requiresConfirmation: true as const };
    });

    const result = redactDraft(input, [], undefined, [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: { review: () => hints },
    });

    expect(result.outboundText).toBe(
      "ＦＯＬＬＯＷ 标记后出现个人联系入口；英文 reply target 指向[[ACCOUNT_001]]，不是服务用户名；真实句柄 [[ACCOUNT_002]]",
    );
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 2, policy: "confirm", inferred: true },
    ]);
  });

  it("does not let a nearby personal phrase turn a common English word into an account", () => {
    const input = "ＦＯＬＬＯＷ 张三，私聊入口 alice_dev_2026";
    const followStart = input.indexOf("ＦＯＬＬＯＷ");
    const handleStart = input.indexOf("alice_dev_2026");
    const result = redactDraft(input, [], undefined, [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [
          { kind: "account", start: followStart, end: followStart + "ＦＯＬＬＯＷ".length, score: 0.9, requiresConfirmation: true },
          { kind: "account", start: handleStart, end: handleStart + "alice_dev_2026".length, score: 0.9, requiresConfirmation: true },
        ],
      },
    });

    expect(result.outboundText).toBe("ＦＯＬＬＯＷ 张三，私聊入口 [[ACCOUNT_001]]");
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);
  });

  it("detects account-shaped values in conversational assignment and search phrasing", () => {
    const input = "会话入口改成栖云8181；一句无字段备注：搜霜枝9033；英文 reply target 指向45959345；alias=春汐6499；加30613110。";
    const result = redactDraft(input);

    expect(result.outboundText).toBe(
      "会话入口改成[[ACCOUNT_001]]；一句无字段备注：搜[[ACCOUNT_002]]；英文 reply target 指向[[ACCOUNT_003]]；alias=[[ACCOUNT_004]]；加[[ACCOUNT_005]]。",
    );
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 5, policy: "confirm", inferred: true },
    ]);
  });

  it("detects CJK, numeric, and mixed account handles after explicit conversational cues", () => {
    const input = "完整账号仍是晚钟8111；会话入口改成栖云8181；搜霜枝9033；alias=春汐6499；英文 reply target 指向45959345；加30613110。";
    const result = redactDraft(input);

    expect(result.outboundText).toBe(
      "完整账号仍是[[ACCOUNT_001]]；会话入口改成[[ACCOUNT_002]]；搜[[ACCOUNT_003]]；alias=[[ACCOUNT_004]]；英文 reply target 指向[[ACCOUNT_005]]；加[[ACCOUNT_006]]。",
    );
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 6, policy: "confirm", inferred: true },
    ]);
  });

  it("does not treat a simulated tenant handle as a personal account", () => {
    expect(redactDraft("audit.pipeline_0106属于模拟租户，不是某个人的昵称或通讯入口。")).toEqual({
      status: "ready",
      outboundText: "audit.pipeline_0106属于模拟租户，不是某个人的昵称或通讯入口。",
      findings: [],
    });
  });

  it("bounds a labeled account before a closing quote and trailing prose", () => {
    const input = "聊天摘录“闻人珞筠的账号是81291532”需分别处理。";
    const result = redactDraft(input);

    expect(result.outboundText).toBe("聊天摘录“闻人珞筠的账号是[[ACCOUNT_001]]”需分别处理。");
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, labels: ["账号"] },
    ]);
  });

  it("keeps rule boundaries over a wider overlapping model hint and rejects fixed non-name words", () => {
    const text = "快递寄到海淀深南大道58号 傅秀兰 16488360765";
    const result = analyzeDraft(text, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "address", start: 4, end: 16, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(result.redactedText).toBe("快递寄到[[ADDRESS_001]] [[PERSON_001]] [[PHONE_001]]");
    expect(redactDraft("车主电话14931839335，谢谢").findings.map((finding) => finding.kind)).toEqual(["phone"]);
    expect(redactDraft("给郭涛打电话 号码17427978819").status === "ready"
      ? redactDraft("给郭涛打电话 号码17427978819").outboundText
      : "").toBe("给[[PERSON_001]]打电话 号码[[PHONE_001]]");
  });

  it("accepts only shaped, account-contextual neural hints", () => {
    const accountInput = "请搜索 wxid_demo_123 看看";
    const account = analyzeDraft(accountInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "account", start: 4, end: 17, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(account.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);

    const phoneInput = "手机号 13800138000";
    const phone = analyzeDraft(phoneInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "account", start: 4, end: 15, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(phone.findings.map((finding) => finding.kind)).toEqual(["phone"]);

    const numericInput = "群成员昵称对应803845827，请勿在工单展示。";
    const numericStart = numericInput.indexOf("803845827");
    const numeric = analyzeDraft(numericInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{
          kind: "account",
          start: numericStart,
          end: numericStart + "803845827".length,
          score: 0.9,
          requiresConfirmation: true,
        }],
      },
    });
    expect(numeric.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);

    const codeInput = "订单号 803845827 已完成";
    const codeStart = codeInput.indexOf("803845827");
    const code = analyzeDraft(codeInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{
          kind: "account",
          start: codeStart,
          end: codeStart + "803845827".length,
          score: 0.9,
          requiresConfirmation: true,
        }],
      },
    });
    expect(code.findings).toEqual([]);
  });

  it("recovers a non-phone semantic hint as an account only in a safe account context", () => {
    const accountInput = "群成员昵称对应803845827，请勿在工单展示。";
    const accountValue = "803845827";
    const accountStart = accountInput.indexOf(accountValue);
    const account = analyzeDraft(accountInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "phone", start: accountStart, end: accountStart + accountValue.length, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(account.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);
    expect(account.redactedText).toBe("群成员昵称对应[[ACCOUNT_001]]，请勿在工单展示。");

    const phoneInput = "账号联系幺三八六二九四七一零五";
    const phoneValue = "幺三八六二九四七一零五";
    const phoneStart = phoneInput.indexOf(phoneValue);
    const phone = analyzeDraft(phoneInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "phone", start: phoneStart, end: phoneStart + phoneValue.length, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(phone.findings).toEqual([
      { kind: "phone", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);

    const technicalInput = "日志中的 fixture_user_9205 是服务任务标识";
    const technicalValue = "fixture_user_9205";
    const technicalStart = technicalInput.indexOf(technicalValue);
    const technical = analyzeDraft(technicalInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "phone", start: technicalStart, end: technicalStart + technicalValue.length, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(technical.findings).toEqual([]);

    const shortInput = "请搜索 abc";
    const shortStart = shortInput.indexOf("abc");
    const short = analyzeDraft(shortInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "phone", start: shortStart, end: shortStart + 3, score: 0.9, requiresConfirmation: true }],
      },
    });
    expect(short.findings).toEqual([]);
  });

  it.each([
    ["phone", "请用电话联系幺三八六二九四七一零五", "幺三八六二九四七一零五"],
    ["email", "请通过邮件发送至 demo_user at example dot invalid", "demo_user at example dot invalid"],
    ["china_id", "请核验实名信息 1 1 0 1 0 5 1 9 4 9 1 2 3 1 0 0 2 X", "1 1 0 1 0 5 1 9 4 9 1 2 3 1 0 0 2 X"],
    ["china_id", "请核验实名信息 一一零一零五一九四九一二三一零零二X", "一一零一零五一九四九一二三一零零二X"],
    ["bank_card", "请转入 4111·1111·1111·1111", "4111·1111·1111·1111"],
    ["bank_card", "请转入 四一一一·一一一一·一一一一·一一一一", "四一一一·一一一一·一一一一·一一一一"],
    ["license_plate", "我的车是 京 A 1 2 3 4 5", "京 A 1 2 3 4 5"],
    ["passport", "证件编号 E 12345678", "E 12345678"],
  ] as const)("accepts a gated semantic %s span", (kind, input, value) => {
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind, start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.redactedText).not.toContain(value);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind, decision: "replace", count: 1 }),
      ]),
    );
  });

  it.each([
    ["private_date", "我的生日是1992年05月14日，入职安排另说。", "1992年05月14日"],
    ["bank_account", "请把收款账户记为ACCT-920514-XQ，别发群里。", "ACCT-920514-XQ"],
    ["credential", "请把凭据值改成Saffron!9205，今晚再轮换。", "Saffron!9205"],
    ["api_key", "云服务API密钥是key_live_7f91c2a4d8e6，发我私聊。", "key_live_7f91c2a4d8e6"],
    ["access_token", "请求头携带tok_live_7f91c2a4d8e6，五分钟后失效。", "tok_live_7f91c2a4d8e6"],
    ["labeled_identifier", "我的OA工号记作EMP-74291，别和项目号混淆。", "EMP-74291"],
    ["ipv4", "服务器地址是192.168.5.114，先不要公开。", "192.168.5.114"],
    ["mac_address", "网卡MAC地址写成0E-3F-A2-78-D1-94。", "0E-3F-A2-78-D1-94"],
  ] as const)("accepts expanded semantic %s hints only after runtime validation", (kind, input, value) => {
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind, start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.redactedText, input).not.toContain(value);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind, decision: expect.any(String), count: 1 }),
    ]));
  });

  it.each([
    ["private_date", "会议日期是2031年02月30日", "2031年02月30日"],
    ["bank_account", "订单号是ACCT-920514-XQ", "ACCT-920514-XQ"],
    ["labeled_identifier", "版本号是v2026.09.16", "v2026.09.16"],
    ["labeled_identifier", "工单号是TICKET-74291", "TICKET-74291"],
    ["ipv4", "示例值是999.1.2.3", "999.1.2.3"],
    ["mac_address", "示例MAC是00-00-00-00-00-00", "00-00-00-00-00-00"],
  ] as const)("rejects invalid or weakly contextual expanded semantic %s hints", (kind, input, value) => {
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind, start, end: start + value.length, score: 0.99, requiresConfirmation: true }],
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.redactedText).toBe(input);
  });

  it.each([
    ["phone", "请拨打一二三四五六七八九零一", "一二三四五六七八九零一"],
    ["email", "标记 a at b dot c", "a at b dot c"],
    ["china_id", "编号 1 1 0 1 0 5 1 9 4 9 1 2 3 1 0 0 2 1", "1 1 0 1 0 5 1 9 4 9 1 2 3 1 0 0 2 1"],
    ["bank_card", "订单 4111·1111·1111·1112", "4111·1111·1111·1112"],
    ["license_plate", "型号 京 A 1 2", "京 A 1 2"],
    ["passport", "订单 E 12345", "E 12345"],
  ] as const)("rejects an unsupported semantic %s span", (kind, input, value) => {
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind, start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.redactedText).toBe(input);
  });

  it("keeps model-recognized conversational structured values without a field label", () => {
    const cases = [
      ["phone", "把幺三八六二九四七一零五单独发我", "幺三八六二九四七一零五"],
      ["email", "用 demo_user 艾特 example 点 invalid 回我", "demo_user 艾特 example 点 invalid"],
      ["passport", "旅行证号 K12345678 已提交", "K12345678"],
    ] as const;

    for (const [kind, input, value] of cases) {
      const start = input.indexOf(value);
      const result = analyzeDraft(input, [], [], [], {
        detectionProfile: "balanced",
        semanticReviewProvider: {
          review: () => [{ kind, start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
        },
      });

      expect(result.redactedText, input).not.toContain(value);
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind, decision: "replace", count: 1, policy: "confirm" }),
      ]));
    }
  });

  it("keeps model-recognized structured test fixtures and order codes unredacted", () => {
    const cases = [
      ["phone", "构建夹具把幺三八六二九四七一零五写入日志", "幺三八六二九四七一零五"],
      ["email", "配置样例中的 demo_user 艾特 example 点 invalid 是固定占位", "demo_user 艾特 example 点 invalid"],
      ["passport", "订单 K12345678 已提交", "K12345678"],
    ] as const;

    for (const [kind, input, value] of cases) {
      const start = input.indexOf(value);
      const result = analyzeDraft(input, [], [], [], {
        detectionProfile: "balanced",
        semanticReviewProvider: {
          review: () => [{ kind, start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
        },
      });

      expect(result.findings, input).toEqual([]);
      expect(result.redactedText, input).toBe(input);
    }
  });

  it("keeps a bracket-obfuscated email whole instead of fragmenting it into accounts", () => {
    const input = "回执写 demo_user[at]example[dot]invalid，不要公开";
    const value = "demo_user[at]example[dot]invalid";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "email", start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.redactedText).not.toContain(value);
    expect(result.findings).toEqual([
      { kind: "email", decision: "replace", count: 1, policy: "confirm" },
    ]);
  });

  it("accepts a model-recognized full-width account alias in a personal chat context", () => {
    const input = "小红书号是 蓝桥９２０５";
    const value = "蓝桥９２０５";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "account", start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.redactedText).not.toContain(value);
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);
  });

  it("keeps a model-recognized grouped resident ID over an overlapping phone-shaped fragment", () => {
    const input = "核对串 110105-19491231-002X 后再归档";
    const value = "110105-19491231-002X";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "china_id", start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.redactedText).not.toContain(value);
    expect(result.findings).toEqual([
      { kind: "china_id", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);
  });

  it("does not split an X-terminated resident ID into a bare bank-card candidate", () => {
    const input = "核对串 110105-19700101-029X 后再归档";
    const value = "110105-19700101-029X";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "china_id", start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.findings).toEqual([
      { kind: "china_id", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);
    expect(result.redactedText).toBe("核对串 [[CHINA_ID_001]] 后再归档");
  });

  it("does not let an earlier identity field suppress a later bare bank card", () => {
    const result = redactDraft("证件 11010519700101029X，卡 4111111111111111");

    expect(result).toEqual({
      status: "ready",
      outboundText: "证件 [[CHINA_ID_001]]，卡 [[BANK_CARD_001]]",
      findings: [
        { kind: "china_id", decision: "replace", count: 1 },
        { kind: "bank_card", decision: "replace", count: 1 },
      ],
    });
  });

  it("accepts a model-recognized account in an interpersonal forwarding context", () => {
    const input = "转发给对方时，入口是 demo_contact_9205，别贴群里";
    const value = "demo_contact_9205";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "account", start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.redactedText).not.toContain(value);
    expect(result.findings).toEqual([
      { kind: "account", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);
  });

  it("rejects a model-recognized fixture identifier in explicit technical context", () => {
    const input = "日志中的 fixture_user_9205 是服务任务标识";
    const value = "fixture_user_9205";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "account", start, end: start + value.length, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.redactedText).toBe(input);
  });

  it("accepts natural Chinese and mixed account aliases from the semantic provider", () => {
    const mixedInput = "请加我 zhangmy_920514";
    const mixedValue = "zhangmy_920514";
    const mixedStart = mixedInput.indexOf(mixedValue);
    const mixed = analyzeDraft(mixedInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{
          kind: "account",
          start: mixedStart,
          end: mixedStart + mixedValue.length,
          score: 0.9,
          requiresConfirmation: true,
        }],
      },
    });
    expect(mixed.findings.map((finding) => finding.kind)).toContain("account");

    const chineseInput = "小红书号是蓝桥9205";
    const chineseValue = "蓝桥9205";
    const chineseStart = chineseInput.indexOf(chineseValue);
    const chinese = analyzeDraft(chineseInput, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{
          kind: "account",
          start: chineseStart,
          end: chineseStart + chineseValue.length,
          score: 0.9,
          requiresConfirmation: true,
        }],
      },
    });
    expect(chinese.findings.map((finding) => finding.kind)).toContain("account");
  });

  it("accepts a structured mixed alias without an explicit account cue", () => {
    const input = "定位到景原市鹿鸣区观澜巷８１号湖畔新居２４座１４８８室后用晚樱_cid24发一声就好。";
    const value = "晚樱_cid24";
    const start = input.indexOf(value);
    const result = analyzeDraft(input, [], [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{
          kind: "account",
          start,
          end: start + value.length,
          score: 0.9,
          requiresConfirmation: true,
        }],
      },
    });

    expect(result.findings.map((finding) => finding.kind)).toContain("account");
    expect(result.redactedText).not.toContain(value);
  });

  it.each(["京A·12345", "京A・12345", "京A 12345", "京A12345"])(
    "detects the plate spelling %s, and maps every spelling onto one session token",
    (plate) => {
      // `京A·12345` 是官方样式，间隔号属于车牌本身。正则必须跨过它——否则
      // normalizeValue 去符号根本没有机会执行。
      const result = redactDraft(`他的车是${plate}，停在B2。`);

      expect(result.status).toBe("ready");
      expect(result.outboundText).toBe("他的车是[[LICENSE_PLATE_001]]，停在B2。");
    },
  );

  it("gives every spelling of one plate the same token inside a single draft", () => {
    const result = redactDraft("登记的是京A·12345，实际拍到的是京A12345。");

    expect(result.status).toBe("ready");
    expect(result.outboundText).toBe("登记的是[[LICENSE_PLATE_001]]，实际拍到的是[[LICENSE_PLATE_001]]。");
  });

  it.each([
    // 收紧到真实中国护照前缀，否则订单号和料号会被当成护照。
    "订单号 A12345678 已发货。",
    "料号 B1234567 缺货。",
    "票号 T4821399 已作废。",
    "内部代号 Z12345678 不要外传。",
  ])("does not treat an ordinary code as a passport: %s", (input) => {
    expect(redactDraft(input).findings.filter((finding) => finding.kind === "passport")).toEqual([]);
  });

  it.each([
    ["紧急联系人身份证", "synthetic-emergency-id"],
    ["内部项目编号", "PROJ-TEST-001"],
    ["数据库实例端口", "3306"],
    ["VPN动态密钥", "VPN-TEST-001"],
    ["OA登录密码", "synthetic-oa-password"],
  ])("keeps the complete high-signal Chinese label for %s", (label, value) => {
    const result = redactDraft(`${label}：${value}`);

    expect(result.findings[0]).toMatchObject({ labels: [label] });
    if (result.status === "blocked") {
      expect(result.outboundText).toBeNull();
    } else {
      expect(result.outboundText).toContain(`${label}：[[`);
    }
  });

  it("blocks an explicitly labeled credential even when its format is otherwise unknown", () => {
    const secret = "synthetic-test-password";
    const result = redactDraft(`数据库密码：${secret}`);

    expect(result).toEqual({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "credential", decision: "block", count: 1, labels: ["数据库密码"] }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps only the safe field label in finding details", () => {
    expect(redactDraft("数据库密码：synthetic-test-password")).toMatchObject({
      status: "blocked",
      findings: [{ kind: "credential", decision: "block", count: 1, labels: ["数据库密码"] }],
    });
  });

  it("does not infer names, addresses, or credentials from ordinary unlabelled prose", () => {
    expect(redactDraft("张三在北京开会，请解释密码字段的设计。")).toEqual({
      status: "ready",
      outboundText: "张三在北京开会，请解释密码字段的设计。",
      findings: [],
    });
  });

  it("replaces local paths and valid IPv4 addresses", () => {
    const result = redactDraft(
      "文件在 C:\\Users\\alice\\reports\\budget.xlsx，也同步到 /Users/bob/.ssh/id_rsa，地址是 10.0.0.8。",
    );

    expect(result).toMatchObject({
      status: "ready",
      outboundText:
        "文件在 [[LOCAL_PATH_001]]，也同步到 [[LOCAL_PATH_002]]，地址是 [[IPV4_001]]。",
      findings: [
        { kind: "local_path", decision: "replace", count: 2 },
        { kind: "ipv4", decision: "replace", count: 1 },
      ],
    });
  });

  it("keeps ordinary text unchanged when no supported rule matches", () => {
    const result = redactDraft("请把这段产品文案调整得更简洁。 ");

    expect(result).toEqual({ status: "ready", outboundText: "请把这段产品文案调整得更简洁。 ", findings: [] });
  });

  it("does not let a global allowlist silently bypass a high-risk credential", () => {
    const result = redactDraft("数据库密码：synthetic-test-password", [], undefined, ["synthetic-test-password"]);

    expect(result).toMatchObject({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "credential", decision: "block", count: 1 }],
    });
  });

  it("allows an explicitly site-scoped high-risk value before its expiry", () => {
    const result = redactDraft("数据库密码：synthetic-test-password", [], undefined, [
      { value: "synthetic-test-password", scope: "site", expiresAt: "2099-01-01T00:00:00.000Z" },
    ]);

    expect(result).toEqual({
      status: "ready",
      outboundText: "数据库密码：synthetic-test-password",
      findings: [],
    });
  });

  it("does not let an expired site allowlist value bypass detection", () => {
    const result = redactDraft("数据库密码：synthetic-test-password", [], undefined, [
      { value: "synthetic-test-password", scope: "site", expiresAt: "2000-01-01T00:00:00.000Z" },
    ]);

    expect(result).toMatchObject({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "credential", decision: "block", count: 1 }],
    });
  });

  it("does not let a permanent site allowlist silently bypass a high-risk credential", () => {
    const result = redactDraft("数据库密码：synthetic-test-password", [], undefined, [
      { value: "synthetic-test-password", scope: "site" },
    ]);

    expect(result).toMatchObject({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "credential", decision: "block", count: 1 }],
    });
  });

  it("keeps a non-allowlisted credential blocked", () => {
    expect(redactDraft("数据库密码：synthetic-test-password", [], undefined, ["another-value"])).toMatchObject({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "credential", decision: "block", count: 1 }],
    });
  });

  it("matches allowlisted phone formatting through the candidate normalization", () => {
    expect(redactDraft("请联系 138 0013 8000", [], undefined, ["13800138000"])).toEqual({
      status: "ready",
      outboundText: "请联系 138 0013 8000",
      findings: [],
    });
  });

  it("lets a whitelist override an overlapping custom term", () => {
    expect(redactDraft("请使用青岚项目", ["青岚项目"], undefined, ["青岚项目"])).toEqual({
      status: "ready",
      outboundText: "请使用青岚项目",
      findings: [],
    });
  });

  it("uses a category replacement policy to anonymize a labeled credential", () => {
    expect(
      redactDraft(
        "数据库密码：synthetic-test-password",
        [],
        undefined,
        [],
        [{ kind: "credential", action: "replace" }],
      ),
    ).toEqual({
      status: "ready",
      outboundText: "数据库密码：[[CREDENTIAL_001]]",
      findings: [{ kind: "credential", decision: "replace", count: 1, labels: ["数据库密码"], policy: "replace" }],
    });
  });

  it("marks an explicit category block policy without exposing the selected value", () => {
    const result = redactDraft(
      "请联系 13800138000",
      [],
      undefined,
      [],
      [{ kind: "phone", action: "block" }],
    );

    expect(result).toEqual({
      status: "blocked",
      outboundText: null,
      findings: [{ kind: "phone", decision: "block", count: 1, policy: "block" }],
    });
    expect(JSON.stringify(result)).not.toContain("13800138000");
  });

  it("returns normalized selected values for an in-memory session allowlist", () => {
    expect(getRedactionValues("请联系 138 0013 8000，邮箱 Li@Example.com。")).toEqual([
      "13800138000",
      "li@example.com",
    ]);
  });

  it("covers the high-confidence Chinese fields used in a mixed business record without exposing values in findings", () => {
    const input = [
      "对接人：演示联系人甲",
      "身份证号：ID-DEMO-001",
      "手机号：13900001234",
      "备用号码：13700005678",
      "家庭住址：测试省样例市演示区示例路1号101室",
      "户籍地址：测试省样例市户籍区演示街2号",
      "电子邮箱：demo_user@example.test",
      "个人微信id：demo_wechat_01",
      "QQ号：QQ-DEMO-001",
      "社保卡号：SOCIAL-DEMO-001",
      "公积金账号：FUND-DEMO-002",
      "银行卡号：4111111111111111",
      "开户行：示例银行样例支行",
      "信用卡CVV：999",
      "内部项目编号：PROJECT-DEMO-001",
      "项目密钥：example-project-secret",
      "项目访问token：example-token-value",
      "服务器内网 IP：192.0.2.44",
      "MAC地址：02-00-00-00-00-01",
      "数据库账号：demo_database_01",
      "数据库密码：example-database-secret",
      "Redis连接密码：example-redis-secret",
      "SSH私钥指纹：SHA256:example-fingerprint",
      "VPN账号：demo_vpn_user",
      "VPN动态密钥：example-vpn-secret",
      "客户合同编号：CONTRACT-DEMO-001",
      "合同加密密码：example-contract-secret",
      "OA系统工号：EMP-DEMO-001",
      "OA登录密码：example-oa-secret",
      "人事档案编号：HR-DEMO-001",
      "紧急联系人：演示联系人乙",
      "紧急联系电话：13600007890",
      "紧急联系人身份证：ID-DEMO-002",
      "车辆牌照：京A-DEMO1",
      "车架号VIN：VIN-DEMO-001",
      "医疗档案编号：MED-DEMO-001",
    ].join("，");
    const expectedValues = [
      "演示联系人甲",
      "ID-DEMO-001",
      "13900001234",
      "13700005678",
      "测试省样例市演示区示例路1号101室",
      "测试省样例市户籍区演示街2号",
      "demo_user@example.test",
      "demo_wechat_01",
      "QQ-DEMO-001",
      "SOCIAL-DEMO-001",
      "FUND-DEMO-002",
      "4111111111111111",
      "示例银行样例支行",
      "999",
      "PROJECT-DEMO-001",
      "example-project-secret",
      "example-token-value",
      "192.0.2.44",
      "020000000001",
      "demo_database_01",
      "example-database-secret",
      "example-redis-secret",
      "SHA256:example-fingerprint",
      "demo_vpn_user",
      "example-vpn-secret",
      "CONTRACT-DEMO-001",
      "example-contract-secret",
      "EMP-DEMO-001",
      "example-oa-secret",
      "HR-DEMO-001",
      "演示联系人乙",
      "13600007890",
      "ID-DEMO-002",
      "京A-DEMO1",
      "VIN-DEMO-001",
      "MED-DEMO-001",
    ];

    expect(getRedactionValues(input)).toEqual(expectedValues);

    const result = redactDraft(input);
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result.findings)).not.toContain("example-project-secret");
    expect(JSON.stringify(result.findings)).not.toContain("demo_user@example.test");
  });

  it("removes every user-like sensitive field from a natural long-form draft when replacement is explicitly allowed", () => {
    const fields = [
      ["对接人", "张默言"],
      ["身份证号", "610103199205147832"],
      ["手机号", "13862947105"],
      ["备用号码", "13517489263"],
      ["家庭住址", "陕西省西安市碑林区友谊西路 128 号佳苑小区 7 号楼 2 单元 1103 室"],
      ["户籍地址", "陕西省咸阳市秦都区人民路34号福安公寓B座1506"],
      ["电子邮箱", "zhang_moyan_test@fake-demo.invalid"],
      ["个人微信id", "zhangmy_920514"],
      ["QQ号", "274891635"],
      ["社保卡号", "610300202608117459"],
      ["公积金账号", "GX-89410726"],
      ["银行卡号", "6222023700018945612"],
      ["开户行", "工行西安友谊西路支行"],
      ["副卡卡号", "6217004220013678904"],
      ["信用卡号", "6258213710047721"],
      ["信用卡CVV", "731"],
      ["信用卡有效期", "09/29"],
      ["内部项目编号", "PROJ-2026-A0719"],
      ["项目密钥", "synthetic-project-key-value"],
      ["项目访问token", "synthetic-project-access-token"],
      ["服务器内网 IP", "192.168.5.114"],
      ["外网公网IP", "117.45.82.169"],
      ["MAC地址", "0E-3F-A2-78-D1-94"],
      ["数据库账号", "proj_admin_03"],
      ["密码", "synthetic-db-password"],
      ["数据库实例端口", "3306"],
      ["Redis连接密码", "synthetic-redis-password"],
      ["SSH登录账号", "proj_root"],
      ["SSH私钥指纹", "SHA256:synthetic-fingerprint"],
      ["VPN账号", "zhangmy_proj"],
      ["VPN动态密钥", "VPN-SEC-784512"],
      ["客户合同编号", "HT-QL-0941"],
      ["涉密归档编号", "ARC-SEC-1142"],
      ["合同加密密码", "synthetic-contract-password"],
      ["OA系统工号", "EMP-74291"],
      ["OA登录密码", "synthetic-oa-password"],
      ["人事档案编号", "RS-DA-2023-147"],
      ["薪资档案编号", "XZ-0841"],
      ["紧急联系人", "李舒雯"],
      ["紧急联系电话", "13609174428"],
      ["紧急联系人身份证", "610402199411072648"],
      ["车辆牌照", "陕A-8KD47"],
      ["车架号VIN", "LSVAF033FAK478912"],
      ["车辆发动机号", "ENG-FAKE-841072"],
      ["医疗档案编号", "MED-2026-59"],
    ] as const;
    const input = fields.map(([label, value]) => `${label}是${value}`).join("，");
    const result = redactDraft(
      input,
      [],
      undefined,
      [],
      [
        { kind: "credential", action: "replace" },
      ],
      { detectionProfile: "balanced" },
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    for (const [, value] of fields) {
      expect(result.outboundText).not.toContain(value);
    }
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "person_name",
      "china_id",
      "phone",
      "address",
      "email",
      "account",
      "labeled_identifier",
      "bank_card",
      "credential",
      "ipv4",
      "mac_address",
      // findings 不按文本顺序，而按 KIND_PRIORITY 分组；license_plate 的优先级插在
      // 数值型标识符与语义标签之间，所以落在最后。
      "license_plate",
    ]);
  });

  it("redacts mixed separators and long Chinese field values without leaking the originals", () => {
    const nonBreakingHyphen = String.fromCharCode(0x2011);
    const fields = [
      ["对接人", "张默言"],
      ["身份证号", "610103199205147832"],
      ["手机号", "13862947105"],
      ["备用号码", "13517489263"],
      ["家庭住址", "陕西省西安市碑林区友谊西路 128 号佳苑小区 7 号楼 2 单元 1103 室"],
      ["户籍地址", "陕西省咸阳市秦都区人民路34号福安公寓B座1506"],
      ["电子邮箱", `zhang_moyan_test@fake${nonBreakingHyphen}demo.com`],
      ["个人微信id", "zhangmy_920514"],
      ["QQ号", "274891635"],
      ["社保卡号", "610300202608117459"],
      ["公积金账号", "GX-89410726"],
      ["银行卡号", "6222023700018945612"],
      ["开户行", "工行西安友谊西路支行"],
      ["副卡卡号", "6217004220013678904"],
      ["信用卡号", "6258213710047721"],
      ["信用卡CVV", "731"],
      ["信用卡有效期", "09/29"],
      ["内部项目编号", "PROJ-2026-A0719"],
      ["项目密钥", "sk-fake-82bc76190ef342ad9c7e"],
      ["项目访问token", "eyJhbGciOiJIUzI1NiJ9.faketoken78219456.abcdefghijklmnopqrst"],
      ["服务器内网 IP", "192.168.5.114"],
      ["外网公网IP", "117.45.82.169"],
      ["MAC地址", "0E-3F-A2-78-D1-94"],
      ["数据库账号", "proj_admin_03"],
      ["密码", "Demo@2026#Lan"],
      ["数据库实例端口", "3306"],
      ["Redis连接密码", "Redis#Sec2026@Ql"],
      ["SSH登录账号", "proj_root"],
      ["SSH私钥指纹", "SHA256:fake-91ac62de45bf8102ce7789abcdef0123456789"],
      ["VPN账号", "zhangmy_proj"],
      ["VPN动态密钥", "VPN-SEC-784512"],
      ["客户合同编号", "HT-QL-0941"],
      ["涉密归档编号", "ARC-SEC-1142"],
      ["合同加密密码", "QlProj#2026-A"],
      ["OA系统工号", "EMP-74291"],
      ["OA登录密码", "Oa@Zhang9205"],
      ["人事档案编号", "RS-DA-2023-147"],
      ["薪资档案编号", "XZ-0841"],
      ["紧急联系人", "李舒雯"],
      ["紧急联系电话", "13609174428"],
      ["紧急联系人身份证", "610402199411072648"],
      ["车辆牌照", "陕A-8KD47"],
      ["车架号VIN", "LSVAF033FAK478912"],
      ["车辆发动机号", "ENG-FAKE-841072"],
      ["医疗档案编号", "MED-2026-59"],
    ] as const;
    const separators = ["：", ": ", "是", "为", "叫", "="] as const;
    const input = fields
      .map(([label, value], index) => `${label}${separators[index % separators.length]}${value}`)
      .join("；");
    const result = redactDraft(
      input,
      [],
      undefined,
      [],
      [
        { kind: "api_key", action: "replace" },
        { kind: "access_token", action: "replace" },
        { kind: "credential", action: "replace" },
      ],
      { detectionProfile: "balanced" },
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    for (const [, value] of fields) {
      expect(result.outboundText).not.toContain(value);
    }
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "person_name",
      "china_id",
      "phone",
      "address",
      "email",
      "account",
      "labeled_identifier",
      "bank_card",
      "credential",
      "api_key",
      "access_token",
      "ipv4",
      "mac_address",
      "license_plate",
    ]);
  });

  it("detects common secret prefixes from the curated browser rule pack", () => {
    const gitlabPat = ["glpat", "0123456789abcdefghijkl"].join("-");
    const slackBot = ["xoxb", "123456789012", "123456789012", "abcdefghijklmnop"].join("-");
    const result = redactDraft(`GitLab ${gitlabPat}，Slack ${slackBot}`);

    expect(result).toMatchObject({
      status: "blocked",
      findings: [{ kind: "api_key", decision: "block", count: 2 }],
    });
  });

  it("redacts a phone number obscured with full-width digits and zero-width characters", () => {
    const source = "请联系 １３８\u200B００１３\u200D８０００";
    const result = redactDraft(source);

    expect(result).toMatchObject({
      status: "ready",
      outboundText: "请联系 [[PHONE_001]]",
      findings: [{ kind: "phone", count: 1 }],
    });
  });

  it("redacts a custom term obscured with zero-width and full-width characters", () => {
    const tokenMap = createSessionTokenMap();

    // 自定义词与内置规则共用归一化视图，混淆形式不能成为绕过口子。
    expect(redactDraft("请整理青岚\u200B项目的安排", ["青岚项目"], tokenMap)).toMatchObject({
      status: "ready",
      outboundText: "请整理[[CUSTOM_001]]的安排",
      findings: [{ kind: "custom_term", decision: "replace", count: 1 }],
    });

    // 同一词条的不同混淆写法应复用同一令牌。
    expect(redactDraft("青岚项目进展如何", ["青岚项目"], tokenMap).outboundText).toBe(
      "[[CUSTOM_001]]进展如何",
    );
  });

  it("matches a custom term written with a full-width latin alias", () => {
    expect(redactDraft("代号 ＱＩＮＧＬＡＮ 已启用", ["QINGLAN"])).toMatchObject({
      status: "ready",
      outboundText: "代号 [[CUSTOM_001]] 已启用",
      findings: [{ kind: "custom_term", decision: "replace", count: 1 }],
    });
  });

  it("normalizes bidirectional format controls across structured sensitive values", () => {
    const result = redactDraft("电话 138\u206600138000，邮箱 demo\u200F_user@example.test。");

    expect(result).toEqual({
      status: "ready",
      outboundText: "电话 [[PHONE_001]]，邮箱 [[EMAIL_001]]。",
      findings: [
        { kind: "phone", decision: "replace", count: 1 },
        { kind: "email", decision: "replace", count: 1 },
      ],
    });
  });

  it("detects a full-width credential label without leaking its original value in the redacted projection", () => {
    const source = "ｐａｓｓｗｏｒｄ＝ａｌｐｈａ\u200B，ｂｅｔａ";
    const analysis = analyzeDraft(source);

    expect(analysis.findings).toMatchObject([{ kind: "credential", decision: "block", count: 1 }]);
    expect(analysis.redactedText).not.toContain("ａｌｐｈａ");
    expect(analysis.redactedText).not.toContain("ｂｅｔａ");
  });

  it("marks an oversized credential while replacing only its bounded field", () => {
    const secret = "x".repeat(4097);
    const analysis = analyzeDraft(`password="${secret}"，说明=keep-this-text`);
    const tokenMap = createSessionTokenMap();
    const materialized = materializeDraftRedaction(`password="${secret}"，说明=keep-this-text`, [], tokenMap);

    expect(analysis.findings).toMatchObject([
      { kind: "credential", decision: "block", count: 1, warning: "credential_too_long" },
    ]);
    expect(analysis.redactedText).toBe('password="[[CREDENTIAL_001]]"，说明=keep-this-text');
    expect(analysis.redactedText).not.toContain(secret);
    expect(materialized.outboundText).toBe('password="[[CREDENTIAL_001]]"，说明=keep-this-text');
    expect(tokenMap.getRawValue("[[CREDENTIAL_001]]")).toBe("原值过长，未在会话映射中保留");
  });

  it("recognizes explicit Chinese conversational identity and address context in balanced mode", () => {
    const result = redactDraft(
      "我是张默言，住在陕西省西安市碑林区友谊西路128号，后续请联系我。",
      [],
      undefined,
      [],
      [],
      { detectionProfile: "balanced" },
    );

    expect(result).toMatchObject({
      status: "ready",
      outboundText: "我是[[PERSON_001]]，住在[[ADDRESS_001]]，后续请联系我。",
      findings: [
        { kind: "person_name", count: 1 },
        { kind: "address", count: 1 },
      ],
    });
  });

  it("recognizes varied high-signal Chinese phrasing in balanced mode without changing ordinary prose", () => {
    const input = [
      "项目负责人叫张默言",
      "请把样品寄送到陕西省西安市碑林区友谊西路128号佳苑小区7号楼",
      "我的微信 ID 是 demo_wechat_920514",
      "邮件为 demo_user@example.invalid",
      "备用手机为 135 1748 9263",
      "数据库密码是 synthetic-db-secret",
      "项目访问 token 为 synthetic-access-token",
      "内网地址为 192.168.5.114",
    ].join("；");

    const result = redactDraft(
      input,
      [],
      undefined,
      [],
      [
        { kind: "credential", action: "replace" },
        { kind: "api_key", action: "replace" },
      ],
      { detectionProfile: "balanced" },
    );

    expect(result).toMatchObject({
      status: "ready",
      findings: [
        { kind: "person_name", count: 1 },
        { kind: "address", count: 1 },
        { kind: "account", count: 1 },
        { kind: "email", count: 1 },
        { kind: "phone", count: 1 },
        { kind: "credential", count: 2, policy: "replace" },
        { kind: "ipv4", count: 1 },
      ],
    });
    expect(result.status === "ready" ? result.outboundText : "").not.toContain("张默言");
    expect(result.status === "ready" ? result.outboundText : "").not.toContain("demo_wechat_920514");
    expect(result.status === "ready" ? result.outboundText : "").not.toContain("synthetic-db-secret");
  });

  it("does not apply weak conversational rules inside fenced code", () => {
    const result = redactDraft("```text\n我是张默言，住在北京市朝阳区\n```", [], undefined, [], [], {
      detectionProfile: "balanced",
    });

    expect(result).toEqual({
      status: "ready",
      outboundText: "```text\n我是张默言，住在北京市朝阳区\n```",
      findings: [],
    });
  });

  it("uses typed non-real surrogates while retaining the raw value only in the session map", () => {
    const tokenMap = createSessionTokenMap();
    const result = redactDraft("请联系 13800138000", [], tokenMap, [], [], { replacementStyle: "surrogate" });

    expect(result).toMatchObject({ status: "ready", outboundText: "请联系 <手机号-001>" });
    expect(tokenMap.getRawValue("[[PHONE_001]]")).toBe("13800138000");
  });
});

describe("curated secret signatures", () => {
  const awsSecretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const azureSasUrl =
    "https://examplestorage.blob.core.windows.net/container/blob.txt?sv=2023-01-03&se=2026-01-01T00:00:00Z&sr=b&sp=r&sig=abcdefghijklmnopqrstuvwxyz0123456789ABCD%3D";
  const openaiSvcacctKey = "sk-svcacct-abcdefghijklmnopqrstuvwxyz1234567890ABCD";
  const shortSigUrl = "https://example.com/file?sig=abc";
  const awsAccessKeyId = "AKIAIOSFODNN7EXAMPLE";
  const genericSkKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD";

  function ruleById(id: string) {
    return getCuratedSecretRules().find((rule) => rule.id === id);
  }

  function matchesRule(id: string, sample: string): boolean {
    const rule = ruleById(id);
    if (rule === undefined) {
      return false;
    }
    return new RegExp(rule.pattern.source, rule.pattern.flags).test(sample);
  }

  it("blocks an AWS secret access key", () => {
    expect(ruleById("aws-secret-access-key")).toEqual(expect.objectContaining({ id: "aws-secret-access-key" }));
    expect(matchesRule("aws-secret-access-key", awsSecretAccessKey)).toBe(true);
    expect(redactDraft(`请保管 ${awsSecretAccessKey}`)).toMatchObject({
      status: "blocked",
      findings: [{ kind: "api_key", decision: "block", count: 1 }],
    });
  });

  it("blocks an Azure SAS URL with sig=", () => {
    expect(ruleById("azure-sas-signature")).toEqual(expect.objectContaining({ id: "azure-sas-signature" }));
    expect(matchesRule("azure-sas-signature", azureSasUrl)).toBe(true);
    expect(redactDraft(`下载 ${azureSasUrl}`)).toMatchObject({
      status: "blocked",
      findings: [{ kind: "api_key", decision: "block", count: 1 }],
    });
  });

  it("blocks an OpenAI sk-svcacct key", () => {
    expect(ruleById("openai-svcacct")).toEqual(expect.objectContaining({ id: "openai-svcacct" }));
    expect(matchesRule("openai-svcacct", openaiSvcacctKey)).toBe(true);
    expect(redactDraft(`密钥 ${openaiSvcacctKey}`)).toMatchObject({
      status: "blocked",
      findings: [{ kind: "api_key", decision: "block", count: 1 }],
    });
  });

  it("does not treat a short ?sig=abc as Azure SAS", () => {
    expect(ruleById("azure-sas-signature")).toEqual(expect.objectContaining({ id: "azure-sas-signature" }));
    expect(matchesRule("azure-sas-signature", shortSigUrl)).toBe(false);
    expect(redactDraft(shortSigUrl).findings.filter((finding) => finding.kind === "api_key")).toEqual([]);
  });

  it("does not treat an AKIA access-key-id as an AWS secret access key", () => {
    expect(ruleById("aws-secret-access-key")).toEqual(expect.objectContaining({ id: "aws-secret-access-key" }));
    expect(matchesRule("aws-secret-access-key", awsAccessKeyId)).toBe(false);
  });

  it("maps a generic sk- prefix to the existing api_key rule rather than svcacct", () => {
    expect(ruleById("openai-svcacct")).toEqual(expect.objectContaining({ id: "openai-svcacct" }));
    expect(matchesRule("openai-svcacct", genericSkKey)).toBe(false);
    expect(redactDraft(`密钥 ${genericSkKey}`)).toMatchObject({
      status: "blocked",
      findings: [{ kind: "api_key", decision: "block", count: 1 }],
    });
  });
});
