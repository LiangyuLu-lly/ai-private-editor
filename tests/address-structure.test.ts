import { describe, expect, it } from "vitest";

import { findHighSignalSemanticCandidates } from "../src/shared/semantic-candidates.js";

function addresses(input: string): string[] {
  return findHighSignalSemanticCandidates(input)
    .filter((candidate) => candidate.kind === "address")
    .map((candidate) => input.slice(candidate.start, candidate.end));
}

describe("anchor-free address structure", () => {
  // 此前地址只在 `寄到`/`家住` 这类锚词之后扫描，四个评测集上"无锚词地址"一律 0.000，
  // 共 1298 条漏检。结构种子从行政区划或道路后缀往前回退定位起点。
  it("finds addresses with no delivery anchor in front", () => {
    expect(addresses("武汉市洪山区霁虹街95号")).toEqual(["武汉市洪山区霁虹街95号"]);
    expect(addresses("辽宁省沈阳市和平区南京北街206号")).toEqual(["辽宁省沈阳市和平区南京北街206号"]);
    expect(addresses("岳麓区琮台路204号砚山听雨公寓")).toEqual(["岳麓区琮台路204号砚山听雨公寓"]);
  });

  // 回退窗口默认 2 字，只在跨过已知地名并落在词开头时才放长。这几条各要跨 1~3 级。
  it("extends the left edge across bare province, city and district names", () => {
    expect(addresses("北京海淀学院路 17 号 6 栋 2202")).toEqual(["北京海淀学院路 17 号 6 栋 2202"]);
    expect(addresses("浙江杭州西湖文三路 200 号 12 幢 1801")).toEqual([
      "浙江杭州西湖文三路 200 号 12 幢 1801",
    ]);
    expect(addresses("上海浦东新区世纪大道 100 号")).toEqual(["上海浦东新区世纪大道 100 号"]);
    // 4 字路名要 b=3 才能完整拿到，同时跨过 `余杭`/`杭州`。
    expect(addresses("杭州余杭文一西路 969 号")).toEqual(["杭州余杭文一西路 969 号"]);
  });

  // 贪婪地向左匹配会把散文头吃进跨度。中文没有词边界，`改为上海市` 里 `上` 前面就是
  // 汉字，任何前瞻断言都会把整条丢掉——所以判据是"跨过的必须是已知地名"。
  it("does not swallow the prose in front of the address", () => {
    expect(addresses("收货地址改为上海市浦东新区世纪大道88号")).toEqual([
      "上海市浦东新区世纪大道88号",
    ]);
    expect(addresses("请填写北京市朝阳区建国路88号")).toEqual(["北京市朝阳区建国路88号"]);
  });
});

describe("address right edge is a chain of structural components", () => {
  // 最严重的一种：地址跨度把电话和人名一起吞进一个 [[ADDRESS_x]] 令牌。
  it("stops before prose that follows the address", () => {
    expect(addresses("我订了 杭州市西湖区灵隐路 168 号的民宿 5月20日入住 房东 张姐 13901234567")).toEqual([
      "杭州市西湖区灵隐路 168 号",
    ]);
    expect(addresses("北京海淀区学院路 17 号 6 栋 2202 三居室")).toEqual([
      "北京海淀区学院路 17 号 6 栋 2202",
    ]);
    expect(addresses("上海徐汇区武康路 393 号 拍照")).toEqual(["上海徐汇区武康路 393 号"]);
    expect(addresses("杭州市西湖区西溪路 12 号 房号 207")).toEqual(["杭州市西湖区西溪路 12 号"]);
  });

  // 楼栋编号可以是拉丁串，但必须紧接成分且必须短。
  it("keeps latin building codes and drops unrelated latin tokens", () => {
    expect(addresses("北京朝阳望京街 6 号望京 SOHO T1 A 座")).toEqual([
      "北京朝阳望京街 6 号望京 SOHO T1 A 座",
    ]);
    expect(addresses("北京海淀学院路 17 号 订单号 ORD-4257")).toEqual(["北京海淀学院路 17 号"]);
    expect(addresses("上海市浦东新区世纪大道88号绿城花园12幢1801 LinkedIn:x")).toEqual([
      "上海市浦东新区世纪大道88号绿城花园12幢1801",
    ]);
  });

  // 数字之间有单位字或连字号才是多级门牌，用空白隔开的下一串数字是别的东西。
  it("distinguishes compound room numbers from a following phone number", () => {
    expect(addresses("北京朝阳建国路 88 号 5-1801")).toEqual(["北京朝阳建国路 88 号 5-1801"]);
    expect(addresses("北京朝阳光华路 9 号世贸天阶 B 座 1701 13012345678")).toEqual([
      "北京朝阳光华路 9 号世贸天阶 B 座 1701",
    ]);
  });

  // 量词与时间词是闭合语法类。链尾停在 1-2 位裸数字、后面紧跟量词时，那个数字属于
  // 后面的短语。刻意不做"短数字一律回退"——那会连带丢掉合法的短门牌号。
  it("rolls back a trailing short number that belongs to a measure phrase", () => {
    expect(addresses("周六团建 集合 朝阳门外大街 88 号 8 点")).toEqual(["朝阳门外大街 88 号"]);
    expect(addresses("房在大理古城洱海路 28 号 5月20日入住")).toEqual(["大理古城洱海路 28 号"]);
    // 合法的短门牌号不受影响：后面不是量词。
    expect(addresses("上海徐汇区武康路 39 号")).toEqual(["上海徐汇区武康路 39 号"]);
  });
});

describe("address head trimming and negatives", () => {
  // ADDRESS_ANCHOR_PATTERN 里有裸的 `到`，`货到了` 会让它命中 `货到`，起点落在 `了` 上。
  it("trims an anchor span back to the first structural component", () => {
    expect(addresses("货到了 收货人 周晓宇 18811223344 杭州西湖区文三路 100 号")).toEqual([
      "杭州西湖区文三路 100 号",
    ]);
  });

  // 地名首字不可能是代词或位移动词。`您小区` 满足"两汉字 + 区"的形状，但真正的地址
  // 是它后面那段。
  it("does not start an address at a pronoun or a motion verb", () => {
    expect(addresses("快递放在您小区 朝阳门外大街 88 号")).toEqual(["朝阳门外大街 88 号"]);
    expect(addresses("顺路去超市3楼")).toEqual([]);
  });

  it("rejects prose and indoor locations that merely look structural", () => {
    expect(addresses("山的路上遇到一个采药的老乡")).toEqual([]);
    expect(addresses("到市场部会议室3楼开会")).toEqual([]);
    expect(addresses("明天到公司楼下取件")).toEqual([]);
  });

  // 一条地址会被 省/市/区/路 四个种子同时命中。只保留最宽的跨度，否则用户会为同一段
  // 文本被问四次。
  it("emits one candidate per address even when several seeds match", () => {
    expect(addresses("广东省深圳市南山区科技园科苑路15号B座1203室")).toEqual([
      "广东省深圳市南山区科技园科苑路15号B座1203室",
    ]);
  });

  // 具名道路 + 阿拉伯门牌号本身就是可投递地址，不需要行政区划或场所词。
  it("accepts a named road with an arabic house number and no division", () => {
    expect(addresses("在 圆通街 3667 的办公室签字")).toEqual(["圆通街 3667"]);
    expect(addresses("本公司在丽水路 1582设有弹性工作中心")).toEqual(["丽水路 1582"]);
  });

  it("accepts a bare district plus a place-name house number after a delivery anchor", () => {
    expect(addresses("外卖送到鼓楼中关村135号 联系曾平19097499309")).toEqual(["鼓楼中关村135号"]);
    expect(addresses("地址天河中关村9号 收件人吕诗涵 电话17490277038")).toEqual(["天河中关村9号"]);
  });
});
