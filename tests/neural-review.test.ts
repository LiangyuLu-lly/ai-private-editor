import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { repairPersonEntityToUniqueName, reviewWithModel } from "../src/shared/neural/review.js";
import { type InferenceRunner, type LogitsTensor } from "../src/shared/neural/session.js";
import { createVocabulary, tokenize } from "../src/shared/neural/tokenizer.js";

const labels = [
  "O",
  "B-PERSON", "I-PERSON", "E-PERSON",
  "B-ADDRESS", "I-ADDRESS", "E-ADDRESS",
  "B-ACCOUNT_ALIAS", "I-ACCOUNT_ALIAS", "E-ACCOUNT_ALIAS",
];
const expandedLabels = [
  ...labels,
  "B-CN_PHONE", "I-CN_PHONE", "E-CN_PHONE",
  "B-EMAIL", "I-EMAIL", "E-EMAIL",
  "B-CN_ID", "I-CN_ID", "E-CN_ID",
  "B-BANK_CARD", "I-BANK_CARD", "E-BANK_CARD",
  "B-LICENSE_PLATE", "I-LICENSE_PLATE", "E-LICENSE_PLATE",
  "B-PASSPORT", "I-PASSPORT", "E-PASSPORT",
  "B-PRIVATE_DATE", "I-PRIVATE_DATE", "E-PRIVATE_DATE",
  "B-SOCIAL_ACCOUNT", "I-SOCIAL_ACCOUNT", "E-SOCIAL_ACCOUNT",
  "B-BANK_ACCOUNT", "I-BANK_ACCOUNT", "E-BANK_ACCOUNT",
  "B-CREDENTIAL", "I-CREDENTIAL", "E-CREDENTIAL",
  "B-API_KEY", "I-API_KEY", "E-API_KEY",
  "B-ACCESS_TOKEN", "I-ACCESS_TOKEN", "E-ACCESS_TOKEN",
  "B-EMPLOYEE_ID", "I-EMPLOYEE_ID", "E-EMPLOYEE_ID",
  "B-HEALTH_RECORD", "I-HEALTH_RECORD", "E-HEALTH_RECORD",
  "B-VEHICLE_VIN", "I-VEHICLE_VIN", "E-VEHICLE_VIN",
  "B-IP_ADDRESS", "I-IP_ADDRESS", "E-IP_ADDRESS",
  "B-MAC_ADDRESS", "I-MAC_ADDRESS", "E-MAC_ADDRESS",
];
const vocabulary = createVocabulary(
  JSON.parse(readFileSync(resolve(__dirname, "../src/shared/neural/vocab.json"), "utf8")) as string[],
);

function entityRunner(
  text: string,
  start: number,
  end: number,
  entityLabel: string,
  modelLabels: readonly string[] = labels,
): InferenceRunner {
  const { offsets } = tokenize(text, vocabulary);
  const tagged = offsets
    .map(([offsetStart, offsetEnd], index) => offsetStart >= start && offsetEnd <= end ? index : -1)
    .filter((index) => index >= 0);

  return {
    run: async (batch): Promise<LogitsTensor> => {
      const width = batch.inputIds[0]?.length ?? 0;
      const data = new Float32Array(width * modelLabels.length);
      for (let position = 0; position < width; position += 1) {
        const tokenIndex = position - 1;
        const taggedIndex = tagged.indexOf(tokenIndex);
        const label = taggedIndex === -1
          ? "O"
          : taggedIndex === 0
            ? `B-${entityLabel}`
            : taggedIndex === tagged.length - 1
              ? `E-${entityLabel}`
              : `I-${entityLabel}`;
        data[position * modelLabels.length + modelLabels.indexOf(label)] = 8;
      }
      return { data, dims: [1, width, modelLabels.length] };
    },
  };
}

function rawContextEntityRunner(
  text: string,
  start: number,
  end: number,
  entityLabel: string,
  requiredTokenId: number,
  modelLabels: readonly string[] = labels,
): InferenceRunner {
  const { offsets } = tokenize(text, vocabulary);
  const tagged = offsets
    .map(([offsetStart, offsetEnd], index) => offsetStart >= start && offsetEnd <= end ? index : -1)
    .filter((index) => index >= 0);

  return {
    run: async (batch): Promise<LogitsTensor> => {
      const width = batch.inputIds[0]?.length ?? 0;
      const data = new Float32Array(width * modelLabels.length);
      if (!batch.inputIds.some((row) => row.includes(requiredTokenId))) {
        return { data, dims: [1, width, modelLabels.length] };
      }
      for (let position = 0; position < width; position += 1) {
        const tokenIndex = position - 1;
        const taggedIndex = tagged.indexOf(tokenIndex);
        const label = taggedIndex === -1
          ? "O"
          : taggedIndex === 0
            ? `B-${entityLabel}`
            : taggedIndex === tagged.length - 1
              ? `E-${entityLabel}`
              : `I-${entityLabel}`;
        data[position * modelLabels.length + modelLabels.indexOf(label)] = 8;
      }
      return { data, dims: [1, width, modelLabels.length] };
    },
  };
}

describe("neural review label mapping", () => {
  it("maps ACCOUNT_ALIAS to an account hint before the detector applies its context gate", async () => {
    const text = "请搜索 wxid_demo_123 看看";
    const start = text.indexOf("wxid_demo_123");
    const end = start + "wxid_demo_123".length;
    const hints = await reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35, maxLength: 256, stride: 64 },
      entityRunner(text, start, end, "ACCOUNT_ALIAS"),
    );

    expect(hints).toEqual([
      { kind: "account", start, end, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("shrinks an account span that swallowed trailing prose", async () => {
    const text = "聊天摘录“闻人珞筠的账号是81291532”需分别处理。";
    const start = text.indexOf("81291532");

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, start, text.length, "ACCOUNT_ALIAS"),
    )).resolves.toEqual([
      { kind: "account", start, end: start + "81291532".length, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("keeps the Chinese prefix when an account has no separator before digits", async () => {
    const text = "聊天摘录“蓟霁棠的账号是鹤影0288”需分别处理。";
    const start = text.indexOf("鹤影0288");

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, start, text.length, "ACCOUNT_ALIAS"),
    )).resolves.toEqual([
      { kind: "account", start, end: start + "鹤影0288".length, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("restores a Chinese prefix when the model starts an account at its Latin suffix", async () => {
    const text = "在线号：橘灯_dri64\n收到请回。";
    const suffixStart = text.indexOf("dri64");
    const end = suffixStart + "dri64".length;

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, suffixStart, end, "ACCOUNT_ALIAS"),
    )).resolves.toEqual([
      { kind: "account", start: text.indexOf("橘灯_dri64"), end, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("keeps fullwidth context in the model input while mapping the result to the raw span", async () => {
    const text = "ＦＯＬＬＯＷ 标记后出现ember.274107，它表示个人联系入口。";
    const value = "ember.274107";
    const start = text.indexOf(value);
    const end = start + value.length;
    const fullwidthF = vocabulary.idByToken.get("ｆ");
    expect(fullwidthF).toBeDefined();

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      rawContextEntityRunner(text, start, end, "ACCOUNT_ALIAS", fullwidthF as number),
    )).resolves.toEqual([
      { kind: "account", start, end, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("trims a model person span to its unique Chinese name", async () => {
    const text = "FYI 彭静 🏠";
    const start = 0;
    const end = text.length;
    const { offsets } = tokenize(text, vocabulary);
    const tagged = offsets
      .map(([offsetStart, offsetEnd], index) => offsetStart >= start && offsetEnd <= end ? index : -1)
      .filter((index) => index >= 0);
    const runner: InferenceRunner = {
      run: async (batch): Promise<LogitsTensor> => {
        const width = batch.inputIds[0]?.length ?? 0;
        const data = new Float32Array(width * labels.length);
        for (let position = 0; position < width; position += 1) {
          const tokenIndex = position - 1;
          const taggedIndex = tagged.indexOf(tokenIndex);
          const label = taggedIndex === -1
            ? "O"
            : taggedIndex === 0
              ? "B-PERSON"
              : taggedIndex === tagged.length - 1
                ? "E-PERSON"
                : "I-PERSON";
          data[position * labels.length + labels.indexOf(label)] = 8;
        }
        return { data, dims: [1, width, labels.length] };
      },
    };

    await expect(reviewWithModel(text, { vocabulary, labels, threshold: 0.35 }, runner)).resolves.toEqual([
      { kind: "person_name", start: 4, end: 6, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("does not shorten a compound name when the repair parser finds only an inner surname", async () => {
    const text = "请联系淳于栖澈确认交付";
    const start = text.indexOf("淳于栖澈");
    const end = start + "淳于栖澈".length;

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, start, end, "PERSON"),
    )).resolves.toEqual([
      { kind: "person_name", start, end, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("trims an overlong person span when it contains a trailing action phrase", async () => {
    const text = "备注里的皇甫知宁常用";
    const start = text.indexOf("皇甫知宁");
    const end = text.length;

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, start, end, "PERSON"),
    )).resolves.toEqual([
      { kind: "person_name", start, end: start + "皇甫知宁".length, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it.each([
    ["接送通知别复制，张默言的号码稍后再发", "别复制"],
    ["退款接收方是服务账号，不要转发", "方"],
    ["需要补一句就去搜demo_user_2026，那是联系人入口", "搜"],
  ])("filters a fixed non-person syntax fragment: %s", async (text, fragment) => {
    const start = text.indexOf(fragment);

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, start, start + fragment.length, "PERSON"),
    )).resolves.toEqual([]);
  });

  it("keeps a real name that shares a surname with a filtered syntax fragment", async () => {
    const text = "退款接收方是方宁，请核对";
    const start = text.indexOf("方宁");
    const end = start + "方宁".length;

    await expect(reviewWithModel(
      text,
      { vocabulary, labels, threshold: 0.35 },
      entityRunner(text, start, end, "PERSON"),
    )).resolves.toEqual([
      { kind: "person_name", start, end, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it("repairs a clipped or overlong model span only when one overlapping name is available", () => {
    const text = "售后备注里留的是皇甫知宁常用的私聊号。";
    const clippedStart = text.indexOf("甫知宁");
    const overlongEnd = text.indexOf("常用") + 1;

    expect(repairPersonEntityToUniqueName(text, clippedStart, overlongEnd)).toEqual({
      start: text.indexOf("皇甫知宁"),
      end: text.indexOf("皇甫知宁") + "皇甫知宁".length,
    });
    expect(repairPersonEntityToUniqueName("退款接收方是纪予蕴", 4, 6)).toEqual({ start: 6, end: 9 });
    expect(repairPersonEntityToUniqueName("张三，李四", 0, 5)).toBeNull();
  });

  it.each([
    ["CN_PHONE", "phone", "请拨幺三八六二九四七一零五", "幺三八六二九四七一零五"],
    ["EMAIL", "email", "邮件 demo_user at example dot invalid", "demo_user at example dot invalid"],
    ["CN_ID", "china_id", "实名信息 11010519491231002X", "11010519491231002X"],
    ["BANK_CARD", "bank_card", "转账 4111·1111·1111·1111", "4111·1111·1111·1111"],
    ["LICENSE_PLATE", "license_plate", "车是京 A 1 2 3 4 5", "京 A 1 2 3 4 5"],
    ["PASSPORT", "passport", "证件 E 12345678", "E 12345678"],
  ] as const)("maps %s to a %s semantic hint", async (modelLabel, kind, text, value) => {
    const start = text.indexOf(value);
    const end = start + value.length;

    await expect(reviewWithModel(
      text,
      { vocabulary, labels: expandedLabels, threshold: 0.35, maxLength: 256, stride: 64 },
      entityRunner(text, start, end, modelLabel, expandedLabels),
    )).resolves.toEqual([
      { kind, start, end, score: 0.9, requiresConfirmation: true },
    ]);
  });

  it.each([
    ["PRIVATE_DATE", "private_date", "出生资料写的是1992-05-14", "1992-05-14"],
    ["SOCIAL_ACCOUNT", "account", "社交入口换成violet_3066", "violet_3066"],
    ["BANK_ACCOUNT", "bank_account", "收款账户为6222023700018945", "6222023700018945"],
    ["CREDENTIAL", "credential", "登录凭证是Demo@2026#Lan", "Demo@2026#Lan"],
    ["API_KEY", "api_key", "项目密钥sk-test-12345678901234567890", "sk-test-12345678901234567890"],
    ["ACCESS_TOKEN", "access_token", "访问令牌eyJabc.def.ghi", "eyJabc.def.ghi"],
    ["EMPLOYEE_ID", "labeled_identifier", "OA工号EMP-74291", "EMP-74291"],
    ["HEALTH_RECORD", "labeled_identifier", "医疗档案MED-2026-59", "MED-2026-59"],
    ["VEHICLE_VIN", "labeled_identifier", "车架号LSVAF033FAK478912", "LSVAF033FAK478912"],
    ["IP_ADDRESS", "ipv4", "服务器地址192.168.5.114", "192.168.5.114"],
    ["MAC_ADDRESS", "mac_address", "设备地址0E-3F-A2-78-D1-94", "0E-3F-A2-78-D1-94"],
  ] as const)("maps the expanded %s head to the %s runtime kind", async (modelLabel, kind, text, value) => {
    const start = text.indexOf(value);
    const end = start + value.length;

    await expect(reviewWithModel(
      text,
      { vocabulary, labels: expandedLabels, threshold: 0.35, maxLength: 256, stride: 64 },
      entityRunner(text, start, end, modelLabel, expandedLabels),
    )).resolves.toEqual([
      { kind, start, end, score: 0.9, requiresConfirmation: true },
    ]);
  });
});
