// 覆盖 2026-08-28 定位并修掉的四个检测器缺陷。
//
// A 词表缺公文角色词：`申请人：沈砚` 两档全漏。
// B 备选项顺序：`联系(?:一下)?` 遮住 `联系人(?:是|为|叫)?`，导致 `联系人 邵桉`
//   检不出，而结构相同的 `收件人 沈砚` 能检出。
// C 标签字段强制分隔符：`微信 yx_12345`、`账号 zl_98765` 全漏。
// D 标签字段零校验：`负责人：华为技术有限公司`、`负责人：待定`、`地址：详见合同`
//   被当成 PII 打码。D 是盲测没抓到的现存缺陷，因为探针总在角色词后放真人名。
import { describe, expect, it } from "vitest";

import { getDetectionRanges } from "../src/shared/detector.js";
import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";
import { PERSON_PREFIX_PATTERN, PERSON_ROLE_NOUNS } from "../src/shared/semantic-lexicon.js";

type Profile = "conservative" | "balanced";

function detect(text: string, profile: Profile) {
  return getDetectionRanges(text, [], [], [], {
    detectionProfile: profile,
    ...(profile === "balanced"
      ? { semanticReviewProvider: createLocalStatisticalSemanticProvider() }
      : {}),
  }).map((range) => ({ kind: range.kind, value: text.slice(range.start, range.end) }));
}

function values(text: string, profile: Profile, kind: string): string[] {
  return detect(text, profile)
    .filter((range) => range.kind === kind)
    .map((range) => range.value);
}

describe("defect A - formal-document role words", () => {
  const cases: readonly [string, string][] = [
    ["申请人：沈砚", "沈砚"],
    ["处理人：岑湛珩", "岑湛珩"],
    ["承租人：邵桉", "邵桉"],
    ["候选人：储翊", "储翊"],
    ["参会人：笪霁", "笪霁"],
    ["经办人：缪翊", "缪翊"],
    ["委托人：蒯砚", "蒯砚"],
    ["监护人：阙湛", "阙湛"],
    ["投保人：厉珩", "厉珩"],
    ["签收人：苌桉", "苌桉"],
  ];

  it.each(cases)("detects a person behind %s in the conservative profile", (input, expected) => {
    expect(values(input, "conservative", "person_name")).toEqual([expected]);
  });

  it.each(cases)("detects a person behind %s in the balanced profile", (input, expected) => {
    expect(values(input, "balanced", "person_name")).toEqual([expected]);
  });

  it("does not adopt 甲方 or 乙方, whose contract values are companies as often as people", () => {
    // 有意留空：这两个位置填公司的概率与填人相当，而下游只有姓氏表和边界检查
    // 两道守卫。宁可漏检，不可误打码。
    expect(PERSON_ROLE_NOUNS).not.toContain("乙方");
    expect(PERSON_ROLE_NOUNS).not.toContain("甲方");
  });
});

describe("defect B - anchor alternation order", () => {
  it("puts every role noun ahead of any shorter alternative that prefixes it", () => {
    const source = PERSON_PREFIX_PATTERN.source;
    // 具体的回归点：`联系人` 必须先于 `联系` 出现，否则最左备选只吃掉 `联系`。
    expect(source.indexOf("联系人")).toBeLessThan(source.indexOf("联系(?:一下)?"));
    expect(source.indexOf("聯繫人")).toBeLessThan(source.indexOf("(?:聯絡|聯繫)(?:一下)?"));
  });

  it.each([
    ["联系人 邵桉", "邵桉"],
    ["联系人邵桉", "邵桉"],
    ["备用联系人 邵桉", "邵桉"],
    ["联络人 沈砚", "沈砚"],
  ])("detects %s, which the shadowed alternation missed", (input, expected) => {
    expect(values(input, "balanced", "person_name")).toEqual([expected]);
  });

  it("still leaves ordinary 联系 phrasing alone", () => {
    expect(values("请联系人力资源部办理", "balanced", "person_name")).toEqual([]);
    expect(values("联系人王工稍后回复。", "balanced", "person_name")).toEqual([]);
  });
});

describe("defect C - whitespace as a labelled-field separator", () => {
  it.each([
    ["微信 yx_12345", "yx_12345"],
    ["微信号 yx_12345", "yx_12345"],
    ["账号 zl_98765", "zl_98765"],
    ["用户名 hy.4421", "hy.4421"],
  ])("detects an account in %s", (input, expected) => {
    expect(values(input, "conservative", "account")).toEqual([expected]);
  });

  it.each([
    ["收件人 沈砚", "沈砚"],
    ["负责人 岑湛珩", "岑湛珩"],
    ["申请人 沈砚", "沈砚"],
    ["收件人 沈砚，电话 13800138000", "沈砚"],
    ["交接说明：\n负责人 岑湛珩\n联系电话 13800138000", "岑湛珩"],
  ])("detects a person in %s even in the conservative profile", (input, expected) => {
    expect(values(input, "conservative", "person_name")).toEqual([expected]);
  });

  it.each(["账号 已经注销", "账号 无法登录", "用户名 不要写在这里", "微信 稍后再发"])(
    "does not treat prose as an account in %s",
    (input) => {
      expect(values(input, "conservative", "account")).toEqual([]);
    },
  );

  it.each(["收件人 已经签收", "负责人 还没定", "联系人 待确认", "申请人 未提交材料"])(
    "does not treat prose as a person in %s",
    (input) => {
      expect(values(input, "balanced", "person_name")).toEqual([]);
    },
  );

  it.each([
    "对接人 方案已确认",
    "负责人 何时确认",
    "申请人 于近期提交",
    "对接人 单位已盖章",
    "联系人 白天在公司",
    "负责人 计划的第二部分",
    "对接人 石油项目组",
    "负责人 程度上还可以",
  ])("requires a clause-final value, so prose stays clean: %s", (input) => {
    // 空格分隔的表单字段里，值后面紧跟标点；跟动词说明这是散文。放开而不加这道
    // 限制，方案 / 何时 / 于近期 / 单位 都会被当成人名。
    expect(values(input, "conservative", "person_name")).toEqual([]);
    expect(values(input, "balanced", "person_name")).toEqual([]);
  });

  it("catches a mid-clause name through the semantic path in both profiles", () => {
    // 标签字段路径仍然拒绝它（值后面跟的是动词，不是标点），接住它的是语义候选路径。
    //
    // 此前 conservative 档在 appendContextCandidates 整条早返回，所以这里的期望是 []。
    // 那意味着**默认配置**检不出任何自由形式的人名与地址。放开之后 conservative 档
    // 相对自身基线：hidden-redteam F1 0.7237→0.8266 且精确率 0.9864→0.9891，
    // semantic-v2 F1 0.1968→0.7459 且精确率保持 1.0000；1000 条真实机构名负例与
    // blind-probe 1065 条负例的污染率都仍是 0.0000。详见 src/shared/detector.ts
    // 里 appendContextCandidates 上方的度量记录。
    expect(values("负责人 张三已经确认", "conservative", "person_name")).toEqual(["张三"]);
    expect(values("负责人 张三已经确认", "balanced", "person_name")).toEqual(["张三"]);
    expect(values("收件人 沈砚会去取", "conservative", "person_name")).toEqual(["沈砚"]);
    expect(values("收件人 沈砚会去取", "balanced", "person_name")).toEqual(["沈砚"]);
  });
});

describe("top-100 surnames 肖 and 付", () => {
  // 这两个是 top-100 里此前唯二缺失的姓氏，代表真实用户；而 blind-probe-v1 里那批
  // 生僻姓（笪苌禚翦麴亓羿）刻意选得罕见，补进表里只会拿误报换跑分。
  it.each([
    ["负责人：付伟强", "付伟强"],
    ["申请人 肖磊", "肖磊"],
    ["收件人 肖敏，电话 13800138000", "肖敏"],
  ])("detects %s in the conservative profile", (input, expected) => {
    expect(values(input, "conservative", "person_name")).toEqual([expected]);
  });

  it.each([
    ["请联系肖桂英确认交付时间。", "肖桂英"],
    ["这件事交由付志远跟进。", "付志远"],
  ])("detects %s in the balanced profile", (input, expected) => {
    expect(values(input, "balanced", "person_name")).toEqual([expected]);
  });

  it.each([
    "负责人 付款流程还没走完",
    "对接人 付费方案已确认",
    "请联系付款部门核对。",
    "这张肖像照不用打码。",
    "交由付出更多精力的团队负责。",
    "负责人：付款单",
    "请把付款凭证发过来。",
    "肖像权问题请咨询法务。",
  ])("does not turn a 付 or 肖 word into a name: %s", (input) => {
    // 加姓氏必须同时加否决词，否则等于用一个缺陷换另一个。
    expect(values(input, "conservative", "person_name")).toEqual([]);
    expect(values(input, "balanced", "person_name")).toEqual([]);
  });

  it("rejects a labelled value that merely starts with a common non-name word", () => {
    // 只判等号会让 付款 被拦下而 付款单 漏过去。
    expect(values("负责人：付款单", "conservative", "person_name")).toEqual([]);
    expect(values("对接人：方案说明", "conservative", "person_name")).toEqual([]);
  });
});

describe("name boundary at 的 / 和 / 与 / 及", () => {
  it.each([
    ["候选人 沈砚 的沟通记录在附件里", "沈砚"],
    ["参会人 沈砚 和岑湛都到场", "沈砚"],
    ["负责人 邵桉与储翊一起跟", "邵桉"],
    ["处理人 缪翊的意见已经记录", "缪翊"],
  ])("ends a name at the particle in %s", (input, expected) => {
    expect(values(input, "balanced", "person_name")).toContain(expected);
  });

  it("trims a loose colon value to the parsed name instead of swallowing the clause", () => {
    expect(values("候选人：沈砚的沟通记录在附件里", "conservative", "person_name")).toEqual(["沈砚"]);
  });
});

describe("defect D - labelled-field value validation", () => {
  it.each([
    "负责人：华为技术有限公司",
    "对接人：招商银行",
    "负责人：项目组",
    "联系人：技术团队",
    "收件人：桉林研究院",
  ])("does not mask an organization in a person field: %s", (input) => {
    expect(values(input, "conservative", "person_name")).toEqual([]);
  });

  it.each([
    "负责人：待定",
    "负责人：暂无",
    "联系人：见附件",
    "收件人：详见合同",
    "对接人：同上",
    "负责人：N/A",
    "联系人：-",
  ])("does not mask a placeholder in a person field: %s", (input) => {
    expect(values(input, "conservative", "person_name")).toEqual([]);
  });

  it.each(["地址：详见合同", "住址：待补充", "家庭住址：暂无"])(
    "does not mask a placeholder in an address field: %s",
    (input) => {
      expect(values(input, "conservative", "address")).toEqual([]);
    },
  );

  it("keeps masking a real value behind the same labels", () => {
    expect(values("负责人：沈砚", "conservative", "person_name")).toEqual(["沈砚"]);
    expect(values("收件人：岑湛珩", "conservative", "person_name")).toEqual(["岑湛珩"]);
    expect(values("家庭住址：北京市海淀区科技路12号", "conservative", "address")).toEqual([
      "北京市海淀区科技路12号",
    ]);
  });

  it("still accepts a labelled person value the surname table does not know", () => {
    // 带冒号是强证据，所以宽松路径保留：生僻姓、外文名、演示占位人名都要能打码。
    expect(values("对接人：演示联系人甲", "conservative", "person_name")).toEqual(["演示联系人甲"]);
    expect(values("负责人：Alice Zhang", "conservative", "person_name")).toEqual(["Alice Zhang"]);
  });

  it("still leaves an organization inside an address field alone, because it can be part of one", () => {
    expect(values("地址：华为技术有限公司总部", "conservative", "address")).toEqual([
      "华为技术有限公司总部",
    ]);
  });
});
