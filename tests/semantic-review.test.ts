import { describe, expect, it } from "vitest";

import { materializeDraftRedaction, redactDraft, resolveSendAction } from "../src/shared/detector.js";
import { LOCAL_STATISTICAL_SEMANTIC_MODEL } from "../src/shared/semantic-model.js";
import {
  createLocalStatisticalSemanticProvider,
  createNoopSemanticReviewProvider,
  MAX_SEMANTIC_REVIEW_CHARACTERS,
} from "../src/shared/semantic-review.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";
import { CHINESE_PRIVACY_CASES } from "./fixtures/chinese-privacy-corpus.js";

describe("local semantic review contract", () => {
  it("keeps the default semantic provider local and empty", () => {
    expect(createNoopSemanticReviewProvider().review("我是张默言")).toEqual([]);
  });

  it("finds free-form person and address candidates with the local statistical model", () => {
    const provider = createLocalStatisticalSemanticProvider();

    expect(provider.review("客户王小明会跟进这件事。")).toEqual([
      { kind: "person_name", start: 2, end: 5, score: expect.any(Number), requiresConfirmation: true },
    ]);
    expect(provider.review("包裹放到北京市朝阳区望京街10号前台。")).toEqual([
      { kind: "address", start: 4, end: 16, score: expect.any(Number), requiresConfirmation: true },
    ]);
  });

  it("does not infer a model candidate from code or an ordinary city reference", () => {
    const provider = createLocalStatisticalSemanticProvider();

    expect(provider.review("```text\n客户王小明会跟进\n```")).toEqual([]);
    expect(provider.review("北京市将举办开发者活动。")).toEqual([]);
  });

  it("does not treat an indoor location with a floor number as an address", () => {
    const provider = createLocalStatisticalSemanticProvider();

    // 行政区划字曾是裸字匹配，"市场部"里的"市"会与"会议室""3楼"凑成地址三要素。
    expect(provider.review("到市场部会议室3楼开会。")).toEqual([]);
    expect(provider.review("在办公室2楼碰面。")).toEqual([]);
    expect(provider.review("去实验室5号楼。")).toEqual([]);
  });

  it("still recognizes a deliverable street address after tightening the rules", () => {
    const provider = createLocalStatisticalSemanticProvider();

    expect(provider.review("寄送到上海市浦东新区世纪大道88号。")).toEqual([
      { kind: "address", start: 3, end: 17, score: expect.any(Number), requiresConfirmation: true },
    ]);
    // 无城市名但有区级行政区划与街道门牌，仍应识别。
    expect(provider.review("家住朝阳区建国路88号。")).toEqual([
      { kind: "address", start: 2, end: 11, score: expect.any(Number), requiresConfirmation: true },
    ]);
  });

  it("keeps local semantic candidates on the confirmation path", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const result = redactDraft("客户王小明会跟进这件事。", [], undefined, [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: provider,
    });

    expect(result).toMatchObject({
      status: "ready",
      outboundText: "客户[[PERSON_001]]会跟进这件事。",
      findings: [{ kind: "person_name", count: 1, policy: "confirm", inferred: true }],
    });
  });

  it("does not let a replace category policy downgrade a semantic confirmation", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const result = redactDraft("客户王小明会跟进这件事。", [], undefined, [], [
      { kind: "person_name", action: "replace" },
    ], {
      detectionProfile: "balanced",
      semanticReviewProvider: provider,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(resolveSendAction(result.findings, "replace")).toBe("confirm");
  });

  it("keeps confirmation when a contextual candidate overlaps the semantic candidate", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const result = redactDraft("请联系张默言。", [], undefined, [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: provider,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(resolveSendAction(result.findings, "replace")).toBe("confirm");
  });

  it.each([
    "客户王小明会跟进，联系人：李雷。",
    "联系人：李雷，客户王小明会跟进。",
  ])("aggregates same-kind policy by strongest action: %s", (input) => {
    const result = redactDraft(input, [], undefined, [], [
      { kind: "person_name", action: "replace" },
    ], {
      detectionProfile: "balanced",
      semanticReviewProvider: createLocalStatisticalSemanticProvider(),
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(resolveSendAction(result.findings, "replace")).toBe("confirm");
  });

  it("normalizes Unicode obfuscation while preserving original hint spans", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const nameInput = "客户王\u200b小明会跟进这件事。";
    const addressInput = "请前往上海市浦东新区世纪大道８８号参加会议。";

    const nameHint = provider.review(nameInput).find((hint) => hint.kind === "person_name");
    const addressHint = provider.review(addressInput).find((hint) => hint.kind === "address");

    expect(nameHint).toMatchObject({ kind: "person_name", requiresConfirmation: true });
    expect(nameInput.slice(nameHint?.start, nameHint?.end)).toBe("王\u200b小明");
    expect(addressHint).toMatchObject({ kind: "address", requiresConfirmation: true });
    expect(addressInput.slice(addressHint?.start, addressHint?.end)).toBe("上海市浦东新区世纪大道８８号");
  });

  it("removes bidirectional format controls without splitting semantic identity tokens", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const first = "客户王\u2066小明会跟进。";
    const second = "客户王小明会跟进。";
    const tokenMap = createSessionTokenMap();
    const options = { detectionProfile: "balanced" as const, semanticReviewProvider: provider };

    expect(first.slice(provider.review(first)[0]?.start, provider.review(first)[0]?.end)).toBe("王\u2066小明");
    expect(materializeDraftRedaction(first, [], tokenMap, [], [], options).outboundText).toBe("客户[[PERSON_001]]会跟进。");
    expect(materializeDraftRedaction(second, [], tokenMap, [], [], options).outboundText).toBe("客户[[PERSON_001]]会跟进。");
  });

  it("lets an explicit user allowlist match the canonical form of a confirmed semantic candidate", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const result = redactDraft("客户王\u2066小明会跟进。", [], undefined, ["王小明"], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: provider,
    });

    expect(result).toMatchObject({ findings: [], outboundText: "客户王\u2066小明会跟进。" });
  });

  it("requires positive corpus evidence instead of scoring unknown context from the prior alone", () => {
    expect(LOCAL_STATISTICAL_SEMANTIC_MODEL.score("person_name", "qvzx")).toBe(0);
    expect(LOCAL_STATISTICAL_SEMANTIC_MODEL.score("address", "qvzx")).toBe(0);
  });

  it("keeps ordinary names, titles, and code out of semantic candidates", () => {
    const provider = createLocalStatisticalSemanticProvider();

    expect(provider.review("李白是唐代诗人。")).toEqual([]);
    expect(provider.review("联系人王工稍后回复。")).toEqual([]);
    expect(provider.review("```text\n客户王小明会跟进\n```")).toEqual([]);
  });

  it("recognizes broader names and location phrasing only as confirmation candidates", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const personInput = "由覃小敏跟进此事。";
    const addressInput = "会议地点在上海市浦东新区世纪大道88号附近。";

    const personHint = provider.review(personInput).find((hint) => hint.kind === "person_name");
    const addressHint = provider.review(addressInput).find((hint) => hint.kind === "address");

    expect(personInput.slice(personHint?.start, personHint?.end)).toBe("覃小敏");
    expect(addressInput.slice(addressHint?.start, addressHint?.end)).toBe("上海市浦东新区世纪大道88号");
  });

  it("covers bounded conversational rewrites while excluding titles, landmarks, and historical contexts", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const values = [
      ["我叫：张默言，今天由我处理。", "张默言"],
      ["给张默言发消息，提醒他跟进。", "张默言"],
      ["这是我同事张默言，他会跟进。", "张默言"],
      ["家住西安市碑林区友谊西路128号，今天不在。", "西安市碑林区友谊西路128号"],
      ["在上海浦东世纪大道88号碰面。", "上海浦东世纪大道88号"],
      ["客户張小明会跟进。", "張小明"],
      ["客户张·默言会跟进。", "张·默言"],
    ] as const;

    for (const [input, expected] of values) {
      const hint = provider.review(input)[0];
      expect(input.slice(hint?.start, hint?.end)).toBe(expected);
    }
    expect(provider.review("由于公司会跟进。请联系王府井会处理。客户李白会参加历史展。")).toEqual([]);
  });

  it("skips closed, unclosed, and alternate fenced semantic examples", () => {
    const provider = createLocalStatisticalSemanticProvider();

    expect(provider.review("```text\n客户王小明会跟进")).toEqual([]);
    expect(provider.review("~~~text\n请前往北京市朝阳区望京街10号\n~~~")).toEqual([]);
    expect(provider.review("示例 `客户王小明会跟进` 不应识别。")).toEqual([]);
  });

  it("scans beyond the local review window without a silent semantic bypass", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const input = `${"无".repeat(MAX_SEMANTIC_REVIEW_CHARACTERS + 1)}客户张三会跟进。`;
    const hint = provider.review(input).find((candidate) => candidate.kind === "person_name");

    expect(input.slice(hint?.start, hint?.end)).toBe("张三");
  });

  it("handles natural name spacing, honorifics, and handoff wording without widening ordinary prose", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const spacedNameInput = "麻烦请联系 张 小明老师确认交付时间。";
    const customerNameInput = "客户是欧阳娜娜，会在门店签收。";

    const spacedName = provider.review(spacedNameInput).find((hint) => hint.kind === "person_name");
    const customerName = provider.review(customerNameInput).find((hint) => hint.kind === "person_name");

    expect(spacedNameInput.slice(spacedName?.start, spacedName?.end)).toBe("张 小明");
    expect(customerNameInput.slice(customerName?.start, customerName?.end)).toBe("欧阳娜娜");
    expect(provider.review("客户经理会在门店签收。项目路线需要确认。")).toEqual([]);
  });

  it("recognizes extended compound surnames in ordinary handoff wording", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const input = "售后备注里留的是皇甫知宁，回电请拨(145)6530-8173。";
    const hint = provider.review(input).find((candidate) => candidate.kind === "person_name");

    expect(input.slice(hint?.start, hint?.end)).toBe("皇甫知宁");
    expect(provider.review("客户是令狐书微，会在门店签收。").map((candidate) =>
      "客户是令狐书微，会在门店签收。".slice(candidate.start, candidate.end),
    )).toContain("令狐书微");
  });

  it("replaces a spaced semantic name as one source span without retaining a suffix", () => {
    const input = "麻烦联系张 默 言处理。";
    const result = materializeDraftRedaction(
      input,
      [],
      createSessionTokenMap(),
      [],
      [],
      { detectionProfile: "balanced", semanticReviewProvider: createLocalStatisticalSemanticProvider() },
    );

    expect(result.outboundText).toBe("麻烦联系[[PERSON_001]]处理。");
    expect(result.outboundText).not.toContain("张");
    expect(result.outboundText).not.toContain("默");
    expect(result.outboundText).not.toContain("言");
  });

  it("continues confirmation detection after a short unclosed code example", () => {
    const input = "```text\n客户王小明会跟进\n# 示例\n客户李雷会跟进。";
    const provider = createLocalStatisticalSemanticProvider();

    expect(provider.review(input).map((hint) => input.slice(hint.start, hint.end))).toEqual(["李雷"]);
  });

  it("recognizes a building-level delivery address with or without a delivery anchor", () => {
    const provider = createLocalStatisticalSemanticProvider();
    const input = "请把合同寄到广东省深圳市南山区科技园科苑路15号B座1203室。";
    const hint = provider.review(input).find((candidate) => candidate.kind === "address");

    expect(input.slice(hint?.start, hint?.end)).toBe("广东省深圳市南山区科技园科苑路15号B座1203室");

    // 无锚词的同一条地址现在也进入确认流程（有意的政策变更，见
    // tests/fixtures/semantic-review-corpus.ts 里的度量依据）。四个种子（省/市/区/路）
    // 会命中同一条地址，只保留最宽的那个跨度，用户不会为同一段文本被问四次。
    const anchorFree = "广东省深圳市南山区科技园科苑路15号B座1203室附近开了新店。";
    expect(
      provider.review(anchorFree).map((candidate) => anchorFree.slice(candidate.start, candidate.end)),
    ).toEqual(["广东省深圳市南山区科技园科苑路15号B座1203室"]);
  });

  it("rejects an unmarked external semantic hint even in balanced mode", () => {
    let calls = 0;
    const provider = {
      review: () => {
        calls += 1;
        return [{ kind: "person_name" as const, start: 2, end: 5 }];
      },
    } as unknown as import("../src/shared/semantic-review.js").SemanticReviewProvider;

    expect(redactDraft("请求赵甲乙", [], undefined, [], [], { semanticReviewProvider: provider })).toMatchObject({
      findings: [],
    });
    expect(calls).toBe(0);
    expect(redactDraft("请求赵甲乙", [], undefined, [], [], {
      detectionProfile: "balanced",
      semanticReviewProvider: provider,
    })).toMatchObject({ findings: [] });
    expect(calls).toBe(1);
  });

  it("rejects semantic hints inside code blocks and over high-confidence candidates", () => {
    const codeProvider = {
      review: () => [{ kind: "person_name" as const, start: 8, end: 11 }],
    } as unknown as import("../src/shared/semantic-review.js").SemanticReviewProvider;
    const phoneProvider = {
      review: () => [{ kind: "address" as const, start: 3, end: 14 }],
    } as unknown as import("../src/shared/semantic-review.js").SemanticReviewProvider;

    expect(
      redactDraft("```text\n我是张默言\n```", [], undefined, [], [], {
        detectionProfile: "balanced",
        semanticReviewProvider: codeProvider,
      }),
    ).toMatchObject({ findings: [] });
    expect(
      redactDraft("请联系 13800138000", [], undefined, [], [], {
        detectionProfile: "balanced",
        semanticReviewProvider: phoneProvider,
      }),
    ).toMatchObject({ findings: [{ kind: "phone", count: 1 }] });
  });

  it.each(CHINESE_PRIVACY_CASES)("keeps Chinese robustness case: $name", ({ input, options, expectedKinds }) => {
    expect(redactDraft(input, [], undefined, [], [], options).findings.map((finding) => finding.kind)).toEqual(expectedKinds);
  });
});
